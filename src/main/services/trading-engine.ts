import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type {
  TradingConfig,
  Position,
  Order,
  MarketData,
  PortfolioSummary,
  BotStatus,
  IndicatorData,
  CandleData,
  SignalData,
  StrategySnapshot,
  StrategyVotePart,
} from '../../renderer/types/trading.js';
import { TechnicalIndicators } from './indicators/technical-indicators.js';
import { RiskManager } from './risk/risk-manager.js';
import { ExchangeAPI } from './exchange-api.js';
import { AIAnalyst, type AIVerdict } from './ai-analyst.js';
import { fetchSymbolFilters, floorToStep, formatStep, type SymbolFilters } from './exchange-filters.js';
import { computeVotes as computeVotesShared } from './analysis/signal-votes.js';
import { JournalService, type JournalOpenMeta } from './journal-service.js';
import { analyzeStructure, meanReversionSide } from './analysis/market-structure.js';
import { fetchFundingRate, fetchOpenInterest, fetchFearGreed, type FearGreed } from './analysis/market-sentiment.js';
import { Logger } from '../utils/logger.js';
import { DEFAULT_TRADING_CONFIG } from './settings-service.js';
import type { TraderMaxApp } from '../main.js';

const VIRTUAL_START_BALANCE = 10000;
const POLL_INTERVAL_MS = 5000;
const ANALYSIS_INTERVAL_MS = 15000;

export class TradingEngine extends EventEmitter {
  private app: TraderMaxApp;
  private config: TradingConfig;
  private logger: Logger;
  private riskManager: RiskManager;
  private exchangeAPI: ExchangeAPI | null = null;
  /** LIVE MODE: real orders go to Binance. False = pure simulation. */
  private live = false;
  /** Effective commission (BNB discount aware). */
  private effCommission = 0.001;
  private filterCache = new Map<string, { f: SymbolFilters; at: number }>();
  private balanceCache: { usdtFree: number; at: number } | null = null;

  private running = false;
  private startTime = 0;
  private ws: WebSocket | null = null;
  private wsReconnectTimer: NodeJS.Timeout | null = null;
  private wsFailCount = 0;
  private wsEverConnected = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private analysisTimer: NodeJS.Timeout | null = null;

  private subscribedSymbols: Set<string> = new Set();
  private marketCache: Map<string, MarketData> = new Map();
  private candleCache: Map<string, CandleData[]> = new Map();
  private orderBookCache: Map<string, { bids: [number, number][]; asks: [number, number][] }> = new Map();

  private positions: Map<string, Position> = new Map();
  private openOrders: Map<string, Order> = new Map();
  private orderHistory: Order[] = [];

  private virtualBalance = VIRTUAL_START_BALANCE;
  private realizedPnL = 0;
  private totalTrades = 0;
  private winningTrades = 0;
  private lastSignal: BotStatus['lastSignal'] = null;

  // ── Adaptive + AI state ──
  private ai = new AIAnalyst();
  private aiVerdicts: Map<string, { verdict: AIVerdict; at: number }> = new Map();
  private aiWarnedNoKey = false;
  private consecLosses = 0;
  private lastCloseAt: Map<string, number> = new Map();
  private lastClosePnl: Map<string, number> = new Map();
  private lastAnalysisAt: Map<string, number> = new Map();
  private lastRegimeLogAt: Map<string, number> = new Map();
  /** Flow context caches (fail-soft, refreshed in background). */
  private flowCache = new Map<string, { funding: number | null; oi: number | null; at: number }>();
  private fearGreed: FearGreed | null = null;

  // ── Journal state ──
  private journal = new JournalService();
  /** Open-trade context for the journal (set at open, consumed at close). */
  private openMeta: Map<string, JournalOpenMeta> = new Map();
  /** MFE/MAE tracking per open position. */
  private excursion: Map<string, { mfe: number; mae: number }> = new Map();
  /** Positions restored from disk on startup (for the start log). */
  private restoredCount = 0;
  /** Daily circuit breaker state. */
  private dayKey = '';
  private dayStartBalance = VIRTUAL_START_BALANCE;
  private haltedForDay = false;

  constructor(app: TraderMaxApp, config: TradingConfig) {
    super();
    this.app = app;
    // Forward-compatible merge: old stored configs gain new fields automatically
    this.config = {
      ...DEFAULT_TRADING_CONFIG,
      ...config,
      strategies: { ...DEFAULT_TRADING_CONFIG.strategies, ...config.strategies },
    };
    this.logger = new Logger('Engine');
    this.riskManager = new RiskManager(this.config);

    const credentials = app.getSettingsService().getCredentials();
    if (credentials) {
      this.exchangeAPI = new ExchangeAPI(credentials, { futures: this.config.market === 'futures' });
      this.logger.info(`Exchange API initialized (${credentials.exchange} ${this.config.market} testnet)`);
    } else {
      this.logger.warn('No API credentials — running in SIMULATION mode with virtual $10,000');
    }

    // Live mode resolves ONLY with real credentials; otherwise force simulation
    this.live = !!this.config.liveTrading && !!this.exchangeAPI;
    this.effCommission = this.config.useBnbDiscount ? 0.00075 : (this.config.commissionRate || 0.001);
    if (this.config.liveTrading && !this.exchangeAPI) {
      this.logger.warn('liveTrading requested but no API credentials — FORCED to simulation');
      this.emitLog('warn', 'Engine', 'Canlı mod istendi ama API anahtarı yok — simülasyona düşürüldü (para güvende).');
    }
    if (this.live) {
      this.logger.warn('LIVE TRADING ENABLED — real Binance orders will be sent');
    }

    // Restore paper account: balance, stats and OPEN positions survive restarts/updates.
    // LIVE MODE NEVER restores simulated positions — real money starts flat.
    try {
      const saved = app.getSettingsService().getPaperState();
      if (saved && !this.live) {
        this.virtualBalance = saved.virtualBalance;
        this.realizedPnL = saved.realizedPnL;
        this.totalTrades = saved.totalTrades;
        this.winningTrades = saved.winningTrades;
        this.consecLosses = saved.consecLosses || 0;
        for (const p of saved.positions || []) {
          if (p.status === 'OPEN') this.positions.set(p.id, p);
        }
        for (const o of saved.openOrders || []) {
          if (o.status === 'NEW') this.openOrders.set(o.id, o);
        }
        this.lastCloseAt = new Map(saved.lastCloseAt || []);
        this.lastClosePnl = new Map(saved.lastClosePnl || []);
        this.restoredCount = this.positions.size;
        this.logger.info(`Paper account restored: $${this.virtualBalance.toFixed(2)}, ${this.restoredCount} open positions`);
      } else if (this.live) {
        this.logger.warn('LIVE MODE: simulated paper state ignored — starting flat with real exchange balance');
      } else {
        // Fresh account: start with the configured balance (small accounts welcome)
        const sb = Number(this.config.startBalance) || 0;
        this.virtualBalance = sb > 0 ? sb : VIRTUAL_START_BALANCE;
        this.logger.info(`Fresh paper account: $${this.virtualBalance.toFixed(2)}`);
      }
    } catch (err) {
      this.logger.error('Paper restore failed', err);
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.startTime = Date.now();
    this.subscribedSymbols = new Set(this.config.symbols.map((s) => s.toUpperCase()));

    const c = this.config;
    this.emitLog('success', 'Engine', `Bot started — symbols: ${[...this.subscribedSymbols].join(', ')} | TF: ${c.timeframe} | Risk/trade: ${(c.riskPerTrade * 100).toFixed(1)}% | TP 1:${c.takeProfitRiskReward} | Adaptive: ${c.adaptiveMode ? 'ON' : 'OFF'} | AI: ${c.aiMode.toUpperCase()} | Trail: ${c.trailingStopEnabled ? 'ON' : 'OFF'} | Komisyon: %${((c.commissionRate || 0) * 100).toFixed(3)} + slipaj ${c.slippageBps || 0}bps | Rejim filtresi: ${c.regimeFilterEnabled ? `AÇIK (ADX>${c.adxThreshold})` : 'KAPALI'}`);
    if (this.live) {
      const isFut = this.config.market === 'futures';
      this.emitLog('error', 'Live', `⛔ GERÇEK PARA MODU AKTİF — Binance ${isFut ? 'FUTURES' : 'SPOT'} hesabına GERÇEK market emirleri gönderilecek. ${isFut ? 'LONG+SHORT açık (likidasyona dikkat!)' : 'Spot sadece LONG.'} Kapatmak için KILL SWITCH.`);
      for (const s of this.subscribedSymbols) void this.ensureFilters(s);
      await this.getUsdtFree();
      if (isFut && this.exchangeAPI) {
        const lev = Math.min(Math.max(1, Math.round(this.config.leverage || 1)), 5);
        if ((this.config.leverage || 1) > 5) {
          this.emitLog('warn', 'Live', `Kaldıraç ${this.config.leverage}x → 5x'e sabitlendi (sermaye koruması).`);
        }
        for (const s of this.subscribedSymbols) {
          try {
            await this.exchangeAPI.setLeverage(s, lev);
          } catch (err) {
            this.logger.error(`Leverage set failed (${s})`, err);
          }
        }
        this.emitLog('info', 'Live', `Futures kaldıraç ${lev}x ayarlandı. Funding maliyeti muhasebeye dahil DEĞİL (8 saatte bir kesilir, journalda görünmez).`);
      }
    }
    this.journal.snapshotEquity(this.virtualBalance, 'bot-start');
    this.resetDailyBreakerIfNeeded(true);
    if (this.restoredCount > 0) {
      this.emitLog('info', 'Engine', `${this.restoredCount} açık pozisyon diskten geri yüklendi — kaldığı yerden devam (SL/TP seviyeleri korunuyor).`);
      for (const p of this.positions.values()) this.broadcast('position:update', { ...p });
      for (const o of this.openOrders.values()) this.broadcast('order:update', { ...o });
      this.broadcastPortfolio();
    }

    this.connectWebSocket();
    await this.refreshAllMarketData();
    this.pollTimer = setInterval(() => void this.refreshAllMarketData(), POLL_INTERVAL_MS);
    this.analysisTimer = setInterval(() => void this.runAnalysisCycle(), ANALYSIS_INTERVAL_MS);
    // Run first analysis quickly
    setTimeout(() => void this.runAnalysisCycle(), 4000);

    this.broadcastStatus();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.wsReconnectTimer) { clearTimeout(this.wsReconnectTimer); this.wsReconnectTimer = null; }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch { /* noop */ }
      this.ws = null;
    }
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.analysisTimer) clearInterval(this.analysisTimer);
    this.pollTimer = this.analysisTimer = null;
    this.persistPaper();
    this.emitLog('warn', 'Engine', 'Bot stopped by user. Open positions are kept (use Kill Switch to close).');
    this.logger.info('Trading engine stopped');
    this.broadcastStatus();
  }

  async emergencyStop(): Promise<void> {
    this.emitLog('error', 'Engine', 'KILL SWITCH engaged — closing ALL positions & canceling orders!');
    // Live: cancel exchange backstops first so closes don't fight resting stops
    if (this.live) {
      for (const position of this.positions.values()) {
        await this.cancelBackstop(position);
      }
    }
    // Cancel all open orders
    for (const order of this.openOrders.values()) {
      order.status = 'CANCELED';
      order.updatedAt = Date.now();
      this.orderHistory.unshift({ ...order });
      this.broadcast('order:update', order);
    }
    this.openOrders.clear();

    // Close all positions at current market price
    for (const position of this.positions.values()) {
      const market = this.marketCache.get(position.symbol);
      const exitPrice = market?.price ?? position.entryPrice;
      await this.closePosition(position, exitPrice, 'EMERGENCY KILL SWITCH');
    }
    await this.stop();
    this.emitLog('error', 'Engine', 'All positions closed. Bot halted.');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── WebSocket (Binance testnet public streams) ─────────────
  // WS drops are diagnosed to the UI log (close code/reason, HTTP status).
  // If WS stays down, the 5s REST poll keeps prices/PnL/SL-TP alive automatically.
  private connectWebSocket(): void {
    if (!this.running) return;
    if (this.wsReconnectTimer) { clearTimeout(this.wsReconnectTimer); this.wsReconnectTimer = null; }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch { /* noop */ }
      this.ws = null;
    }
    try {
      // Combined stream, miniTicker only (1 msg/sec/symbol is plenty for PnL + SL/TP)
      // NOTE: testnet streams live on stream.testnet.binance.vision (NOT testnet.binance.vision)
      const streams = [...this.subscribedSymbols]
        .map((s) => `${s.toLowerCase()}@miniTicker`)
        .join('/');
      const url = `${this.marketWs()}?streams=${streams}`;
      const ws = new WebSocket(url, { handshakeTimeout: 10000 });
      this.ws = ws;

      ws.on('open', () => {
        this.wsFailCount = 0;
        this.logger.info('Market WebSocket connected');
        this.emitLog(this.wsEverConnected ? 'debug' : 'success', 'Feed', 'Live market WebSocket connected (Binance Testnet)');
        this.wsEverConnected = true;
      });

      ws.on('message', (raw: Buffer) => {
        if (ws !== this.ws) return; // stale socket
        try {
          const msg = JSON.parse(raw.toString());
          const data = msg.data;
          if (!data || data.e !== '24hrMiniTicker') return;
          const symbol: string = data.s;
          const price = parseFloat(data.c);
          if (!isFinite(price) || price <= 0) return;
          const prev = this.marketCache.get(symbol);
          this.marketCache.set(symbol, {
            symbol,
            price,
            bid: price,
            ask: price,
            volume24h: parseFloat(data.v),
            change24h: parseFloat(data.c) - parseFloat(data.o),
            changePercent24h: parseFloat(data.o) !== 0 ? ((parseFloat(data.c) - parseFloat(data.o)) / parseFloat(data.o)) * 100 : 0,
            high24h: parseFloat(data.h),
            low24h: parseFloat(data.l),
            timestamp: Date.now(),
          });
          const updated = this.marketCache.get(symbol)!;
          this.broadcast('market:update', updated);
          // live PnL refresh
          void this.refreshPositionsPnL();
          if (prev && Math.abs(updated.price - prev.price) / prev.price > 0.0001) {
            void this.checkStopTakeProfit(symbol, updated.price);
          }
        } catch (err) {
          this.logger.error('WS message parse error', err);
        }
      });

      // Handshake rejected (HTTP 4xx/5xx) — the key diagnostic for recurring drops
      ws.on('unexpected-response', (_req: unknown, res: { statusCode?: number; statusMessage?: string; on: (ev: string, cb: (c?: unknown) => void) => void }) => {
        let body = '';
        try {
          res.on('data', (chunk: unknown) => { body += String(chunk).slice(0, 300); });
          res.on('end', () => {
            const detail = `HTTP ${res.statusCode ?? '?'} ${res.statusMessage ?? ''} ${body}`.trim();
            this.logger.error('WS handshake rejected', { detail });
            this.emitLog('error', 'Feed', `WS handshake rejected: ${detail}`);
          });
        } catch (err) {
          this.logger.error('WS unexpected-response handler failed', err);
        }
      });

      ws.on('error', (err: Error) => {
        this.logger.error('WebSocket error', err);
        // 'close' follows with the code; surface the message only on early failures to avoid spam
        if (this.wsFailCount < 3) {
          this.emitLog('error', 'Feed', `WebSocket error: ${err.message}`);
        }
      });

      ws.on('close', (code: number, reason: Buffer) => {
        if (ws !== this.ws) return; // stale socket
        this.ws = null;
        const reasonStr = reason?.toString() || 'no reason';
        this.logger.warn(`Market WebSocket closed code=${code} reason=${reasonStr}`);
        if (!this.running) return;
        this.wsFailCount++;
        const backoff = Math.min(5000 * Math.pow(2, this.wsFailCount - 1), 60000);
        if (this.wsFailCount === 1) {
          this.emitLog('warn', 'Feed', `WebSocket disconnected (code ${code}: ${reasonStr}) — retrying, REST polling continues`);
        } else if (this.wsFailCount <= 3) {
          this.emitLog('warn', 'Feed', `WebSocket retry #${this.wsFailCount} failed (code ${code}) — next in ${Math.round(backoff / 1000)}s`);
        } else {
          if (this.wsFailCount === 4) {
            this.emitLog('error', 'Feed', `WebSocket unavailable (code ${code}: ${reasonStr}). REST price feed devrede — bot çalışmaya devam ediyor, arka planda seyrek yeniden denenecek.`);
          } else {
            this.emitLog('debug', 'Feed', `WS retry #${this.wsFailCount} in ${Math.round(backoff / 1000)}s (code ${code})`);
          }
        }
        if (this.wsReconnectTimer) clearTimeout(this.wsReconnectTimer);
        this.wsReconnectTimer = setTimeout(() => {
          this.wsReconnectTimer = null;
          if (this.running) this.connectWebSocket();
        }, backoff);
        if (this.wsReconnectTimer.unref) this.wsReconnectTimer.unref();
      });
    } catch (err) {
      this.logger.error('Failed to connect WebSocket', err);
    }
  }

  /** Market-aware public API root (spot vs futures testnet). */
  private marketApi(path: string): string {
    if (this.config.market === 'futures') {
      return `https://testnet.binancefuture.com/fapi/v1${path}`;
    }
    return `https://testnet.binance.vision/api/v3${path}`;
  }

  private marketWs(): string {
    if (this.config.market === 'futures') {
      return 'wss://stream.testnet.binancefuture.com/stream';
    }
    return 'wss://stream.testnet.binance.vision/stream';
  }

  /** fetch with timeout — a hanging request must never stall the poll loop. */
  private async fetchTimeout(url: string, ms = 10000): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  // ── REST polling fallback ──────────────────────────────────
  private async refreshAllMarketData(): Promise<void> {
    for (const symbol of this.subscribedSymbols) {
      try {
        if (this.exchangeAPI) {
          const ticker = await this.exchangeAPI.getTicker(symbol);
          const price = parseFloat(ticker.lastPrice ?? ticker.last ?? 0);
          if (price > 0) {
            const prevRest = this.marketCache.get(symbol);
            this.marketCache.set(symbol, {
              symbol, price, bid: price, ask: price,
              volume24h: parseFloat(ticker.volume ?? ticker.volume24h ?? 0),
              change24h: parseFloat(ticker.priceChange ?? 0),
              changePercent24h: parseFloat(ticker.priceChangePercent ?? 0),
              high24h: parseFloat(ticker.highPrice ?? ticker.highPrice24h ?? price),
              low24h: parseFloat(ticker.lowPrice ?? ticker.lowPrice24h ?? price),
              timestamp: Date.now(),
            });
            this.broadcast('market:update', this.marketCache.get(symbol)!);
            // WS down ise REST fiyatı SL/TP ve PnL'yi besler
            if (prevRest) void this.checkStopTakeProfit(symbol, price);
          }
          // Order book snapshot (throttled: every poll is fine for testnet)
          const ob = await this.exchangeAPI.getOrderBook(symbol, 20);
          this.orderBookCache.set(symbol, ob);
        } else {
          // Simulation mode: use public Binance REST without keys
          const res = await this.fetchTimeout(`${this.marketApi('/ticker/24hr')}?symbol=${symbol}`);
          if (res.ok) {
            const t = await res.json() as any;
            const price = parseFloat(t.lastPrice);
            if (price > 0) {
              const prevSim = this.marketCache.get(symbol);
              this.marketCache.set(symbol, {
                symbol, price, bid: price, ask: price,
                volume24h: parseFloat(t.volume),
                change24h: parseFloat(t.priceChange),
                changePercent24h: parseFloat(t.priceChangePercent),
                high24h: parseFloat(t.highPrice),
                low24h: parseFloat(t.lowPrice),
                timestamp: Date.now(),
              });
              this.broadcast('market:update', this.marketCache.get(symbol)!);
              // WS down ise REST fiyatı SL/TP ve PnL'yi besler
              if (prevSim) void this.checkStopTakeProfit(symbol, price);
            }
          }
          const obRes = await this.fetchTimeout(`${this.marketApi('/depth')}?symbol=${symbol}&limit=20`);
          if (obRes.ok) {
            const ob = await obRes.json() as any;
            this.orderBookCache.set(symbol, {
              bids: ob.bids.map((b: string[]) => [parseFloat(b[0]), parseFloat(b[1])] as [number, number]),
              asks: ob.asks.map((a: string[]) => [parseFloat(a[0]), parseFloat(a[1])] as [number, number]),
            });
          }
        }
        // Candles
        await this.refreshCandles(symbol, this.config.timeframe, 200);
      } catch (err) {
        this.logger.error(`Refresh failed for ${symbol}`, err);
      }
    }
    // Background market context (funding/OI/fear-greed) — never blocks the loop
    void this.refreshMarketContext();
    // Live USDT balance (throttled inside getUsdtFree)
    if (this.live) {
      void this.getUsdtFree();
    }
    this.broadcastPortfolio();
  }

  /** Flow + sentiment refresh: funding/OI every 5 min, fear-greed hourly. */
  private async refreshMarketContext(): Promise<void> {
    try {
      const now = Date.now();
      if (!this.fearGreed || now - this.fearGreed.updatedAt > 3600 * 1000) {
        const fg = await fetchFearGreed();
        if (fg) {
          this.fearGreed = fg;
          this.emitLog('debug', 'Sentiment', `Korku-Açgözlülük: ${fg.value} (${fg.label})`);
        }
      }
      await Promise.all(
        [...this.subscribedSymbols].map(async (symbol) => {
          const cached = this.flowCache.get(symbol);
          if (cached && now - cached.at < 5 * 60 * 1000) return;
          const [funding, oi] = await Promise.all([fetchFundingRate(symbol), fetchOpenInterest(symbol)]);
          this.flowCache.set(symbol, { funding, oi, at: now });
        })
      );
    } catch (err) {
      this.logger.error('Market context refresh failed', err);
    }
  }

  private async refreshCandles(symbol: string, timeframe: string, limit: number): Promise<void> {
    try {
      if (this.exchangeAPI) {
        const candles = await this.exchangeAPI.getKlines(symbol, timeframe, limit);
        this.candleCache.set(`${symbol}:${timeframe}`, candles);
      } else {
        const res = await this.fetchTimeout(`${this.marketApi('/klines')}?symbol=${symbol}&interval=${timeframe}&limit=${limit}`, 15000);
        if (res.ok) {
          const raw = await res.json() as any[];
          this.candleCache.set(`${symbol}:${timeframe}`, raw.map((k: any[]) => ({
            time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
            low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
          })));
        }
      }
    } catch (err) {
      this.logger.error(`Candle refresh failed ${symbol}`, err);
    }
  }

  // ── Strategy analysis cycle ────────────────────────────────
  private async runAnalysisCycle(): Promise<void> {
    if (!this.running) return;
    this.resetDailyBreakerIfNeeded();
    for (const symbol of this.subscribedSymbols) {
      try {
        this.lastAnalysisAt.set(symbol, Date.now());
        const key = `${symbol}:${this.config.timeframe}`;
        let candles = this.candleCache.get(key);
        if (!candles || candles.length < 50) {
          await this.refreshCandles(symbol, this.config.timeframe, 200);
          candles = this.candleCache.get(key);
        }
        if (!candles || candles.length < 50) continue;

        const closes = candles.map((c) => c.close);
        const indicators = TechnicalIndicators.calculateAllIndicators(candles);

        // Live candle close update → push latest price
        const lastClose = closes[closes.length - 1];
        const evalRes = this.evaluateStrategies(symbol, lastClose, candles, indicators);
        let signal = evalRes.signal;
        // Mean-reversion: in ranging markets, trade support/resistance so
        // capital keeps working instead of sitting idle (quick 1R targets)
        if (!signal && (this.config.rangeTradingEnabled ?? true)) {
          signal = this.checkMeanReversion(symbol, lastClose, candles, indicators);
        }

        this.emitLog('debug', 'Analysis',
          `${symbol} | EMA9:${indicators.ema.fast.toFixed(2)} EMA21:${indicators.ema.slow.toFixed(2)} | MACD:${indicators.macd.histogram.toFixed(4)} | RSI:${indicators.rsi.toFixed(1)} | ATR:${indicators.atr.toFixed(2)} | ADX:${(indicators.adx || 0).toFixed(1)}`);

        // Regime veto: a signal existed but the market is ranging → rest (throttled logging)
        if (evalRes.regimeBlocked) {
          this.journal.recordSkip({
            t: Date.now(), symbol, side: evalRes.wouldBUY ? 'BUY' : 'SELL',
            price: lastClose, strength: 0, category: 'regime',
          });
          const lastLog = this.lastRegimeLogAt.get(symbol) ?? 0;
          if (Date.now() - lastLog > 15 * 60000) {
            this.lastRegimeLogAt.set(symbol, Date.now());
            this.emitLog('info', 'Regime', `${symbol}: yatay piyasa (ADX ${(indicators.adx || 0).toFixed(1)} < ${this.config.adxThreshold}) — sinyal pas geçildi, kırbaçtan korunmak için dinleniliyor`);
          } else {
            this.emitLog('debug', 'Regime', `${symbol}: yatay piyasa ADX ${(indicators.adx || 0).toFixed(1)} — pas`);
          }
        }

        if (signal) {
          this.lastSignal = {
            symbol: signal.symbol, side: signal.side, price: signal.price,
            indicators: signal.indicators, timestamp: signal.timestamp,
          };
          this.emitLog(signal.side === 'BUY' ? 'success' : 'warn', 'Signal',
            ` ${signal.side} ${signal.symbol} @ ${signal.price} | Strength ${signal.strength}/4 | ${signal.reason}`);
          // AI gate/assist layer (never blocks on AI failure)
          if (this.config.aiMode !== 'off') {
            const allowed = await this.applyAIGate(signal);
            if (!allowed) continue;
          }
          await this.executeSignal(signal);
        }
        // Max-hold time exit + SL/TP validation
        const market = this.marketCache.get(symbol);
        if (market) {
          await this.checkMaxHold(symbol);
          await this.checkStopTakeProfit(symbol, market.price);
        }
      } catch (err) {
        this.logger.error(`Analysis failed for ${symbol}`, err);
      }
    }
    this.broadcastStatus();
    this.broadcastPortfolio();
  }

  private computeVotes(
    symbol: string, price: number, candles: CandleData[], ind: IndicatorData
  ): { bullVotes: number; bearVotes: number; parts: StrategyVotePart[]; reasons: string[] } {
    void symbol;
    return computeVotesShared(this.config.strategies, price, candles, ind);
  }


  private evaluateStrategies(
    symbol: string, price: number, candles: CandleData[], ind: IndicatorData
  ): { signal: SignalData | null; regimeBlocked: boolean; wouldBUY: boolean; wouldSELL: boolean } {
    const { bullVotes, bearVotes, reasons } = this.computeVotes(symbol, price, candles, ind);

    // Required net votes: user setting, or adaptive (stricter in high volatility)
    const threshold = this.effectiveMinStrength(symbol, price, ind.atr);
    const wouldBUY = bullVotes >= threshold && bullVotes > bearVotes + 0.5;
    const wouldSELL = bearVotes >= threshold && bearVotes > bullVotes + 0.5;

    // Regime filter: no trend (low ADX) = ranging market → rest, avoid whipsaw
    const regimeBlocked =
      !!this.config.regimeFilterEnabled &&
      (ind.adx || 0) < (this.config.adxThreshold || 20) &&
      (wouldBUY || wouldSELL);

    let signal: SignalData | null = null;
    if (wouldBUY) {
      signal = { symbol, side: 'BUY', price, strength: Math.min(4, Math.round(bullVotes)), indicators: ind, reason: reasons.join(' + '), timestamp: Date.now() };
    } else if (wouldSELL) {
      signal = { symbol, side: 'SELL', price, strength: Math.min(4, Math.round(bearVotes)), indicators: ind, reason: reasons.join(' + '), timestamp: Date.now() };
    }
    if (regimeBlocked) signal = null;
    return { signal, regimeBlocked, wouldBUY, wouldSELL };
  }

  /** Live brain snapshot for the UI — mirrors executeSignal's gate checks. */
  getStrategySnapshot(symbol: string): StrategySnapshot | null {
    const sym = symbol.toUpperCase();
    const key = `${sym}:${this.config.timeframe}`;
    const candles = this.candleCache.get(key);
    if (!candles || candles.length < 50) return null;
    const market = this.marketCache.get(sym);
    const price = market?.price ?? candles[candles.length - 1].close;
    const ind = TechnicalIndicators.calculateAllIndicators(candles);
    const { bullVotes, bearVotes, parts } = this.computeVotes(sym, price, candles, ind);
    const threshold = this.effectiveMinStrength(sym, price, ind.atr);

    const wouldBUY = bullVotes >= threshold && bullVotes > bearVotes + 0.5;
    const wouldSELL = bearVotes >= threshold && bearVotes > bullVotes + 0.5;
    let wouldSignal: 'BUY' | 'SELL' | null = wouldBUY ? 'BUY' : wouldSELL ? 'SELL' : null;
    const snapParts = [...parts];
    // Mean-reversion path (mirrors the live cycle): range + level + RSI
    if (!wouldSignal && (this.config.rangeTradingEnabled ?? true)) {
      const mrSide = meanReversionSide(
        analyzeStructure(candles), price, ind.atr, ind.rsi,
        ind.adx || 0, this.config.adxThreshold || 20
      );
      if (mrSide) {
        wouldSignal = mrSide;
        snapParts.push({
          key: 'mr', label: 'Mean-rev',
          bull: mrSide === 'BUY' ? 2 : 0, bear: mrSide === 'SELL' ? 2 : 0,
          note: 'Destek/direnç tepkisi (TP 1R)',
        });
      }
    }

    const adx = ind.adx || 0;
    const regime: 'TREND' | 'RANGE' | 'OFF' = !this.config.regimeFilterEnabled
      ? 'OFF'
      : adx >= (this.config.adxThreshold || 20) ? 'TREND' : 'RANGE';
    const regimeBlocked = regime === 'RANGE' && (wouldBUY || wouldSELL);

    let blockedBy: string | null = null;
    let cooldownSecLeft = 0;
    const openPositions = [...this.positions.values()].filter((p) => p.status === 'OPEN');
    const existing = openPositions.find((p) => p.symbol === sym) ?? null;

    // Analyst layer: structure + flow + sentiment (read-only context)
    const structure = analyzeStructure(candles);
    let bookImbalance: number | null = null;
    const book = this.orderBookCache.get(sym);
    if (book) {
      const bids = book.bids.slice(0, 10).reduce((s, b) => s + b[0] * b[1], 0);
      const asks = book.asks.slice(0, 10).reduce((s, a) => s + a[0] * a[1], 0);
      if (bids + asks > 0) bookImbalance = (bids - asks) / (bids + asks);
    }
    const flow = this.flowCache.get(sym);

    let htfTrend: 'UP' | 'DOWN' | null = null;
    if (this.config.htfFilterEnabled) {
      const htf = this.candleCache.get(`${sym}:${this.config.htfTimeframe || '1h'}`);
      if (htf && htf.length >= 25) {
        const closes = htf.map((c) => c.close);
        const f = TechnicalIndicators.calculateEMA(closes, 9);
        const s = TechnicalIndicators.calculateEMA(closes, 21);
        const fv = f[f.length - 1];
        const sv = s[s.length - 1];
        if (isFinite(fv) && isFinite(sv) && fv !== sv) htfTrend = fv > sv ? 'UP' : 'DOWN';
      }
    }

    if (wouldSignal) {
      if (this.haltedForDay) {
        blockedBy = 'Günlük zarar freni aktif — yarına kadar yeni pozisyon açılmayacak';
      } else if (openPositions.length >= this.config.maxPositions) {
        blockedBy = `Maks. pozisyon dolu (${openPositions.length}/${this.config.maxPositions})`;
      } else if (existing) {
        blockedBy = `Zaten ${existing.side} pozisyon açık — yeni sinyal aynı sembole işlenmez`;
      } else if (this.config.tradingSide === 'long-only' && wouldSignal === 'SELL') {
        blockedBy = 'Yön filtresi: sadece Long modu açık';
      } else if (this.config.tradingSide === 'short-only' && wouldSignal === 'BUY') {
        blockedBy = 'Yön filtresi: sadece Short modu açık';
      } else if (
        this.config.htfFilterEnabled && htfTrend &&
        !((wouldSignal === 'BUY' && htfTrend === 'UP') || (wouldSignal === 'SELL' && htfTrend === 'DOWN'))
      ) {
        blockedBy = `1h trend ${htfTrend === 'UP' ? 'YUKARI' : 'AŞAĞI'} — ${wouldSignal} sinyali veto edildi (ana trende kafa atılmadı)`;
      } else if (
        wouldSignal &&
        openPositions.filter((p) => p.side === (wouldSignal === 'BUY' ? 'LONG' : 'SHORT')).length >=
          (this.config.maxSameSide ?? 2)
      ) {
        blockedBy = 'Aynı yön tavanı dolu — yön çeşitliliği korunuyor (3 LONG birden tarihte kaldı)';
      } else {
        const cdMin = this.config.cooldownMinutes || 0;
        const lastWasLoss = (this.lastClosePnl.get(sym) ?? 0) < 0;
        if (cdMin > 0 && lastWasLoss) {
          const waitedSec = (Date.now() - (this.lastCloseAt.get(sym) ?? 0)) / 1000;
          if (waitedSec < cdMin * 60) {
            cooldownSecLeft = Math.ceil(cdMin * 60 - waitedSec);
            blockedBy = `Zarar sonrası mola (${cooldownSecLeft} sn kaldı)`;
          }
        }
      }
    }

    return {
      symbol: sym,
      price,
      timestamp: Date.now(),
      bullVotes,
      bearVotes,
      threshold,
      parts: snapParts,
      wouldSignal,
      blockedBy,
      cooldownSecLeft,
      openPositions: openPositions.length,
      maxPositions: this.config.maxPositions,
      existingSide: existing?.side ?? null,
      indicators: ind,
      lastAnalysisAt: this.lastAnalysisAt.get(sym) ?? 0,
      aiMode: this.config.aiMode,
      adx,
      regime,
      regimeBlocked,
      halted: this.haltedForDay,
      htfTrend,
      structure: {
        trend: structure.trend,
        support: structure.support,
        resistance: structure.resistance,
        supportDistPct: structure.supportDistPct,
        resistanceDistPct: structure.resistanceDistPct,
        bos: structure.bos,
      },
      bookImbalance,
      fundingRate: flow?.funding ?? null,
      openInterest: flow?.oi ?? null,
      fearGreed: this.fearGreed ? { value: this.fearGreed.value, label: this.fearGreed.label } : null,
    };
  }

  /**
   * Required signal strength: user's setting as base, adaptive adds +1
   * in high volatility. Base 1 = fresh crosses AND sustained alignments trade.
   */
  private effectiveMinStrength(symbol: string, price: number, atr: number): number {
    const base = this.config.minSignalStrength || 1;
    if (!this.config.adaptiveMode) return base;
    const atrPct = price > 0 ? atr / price : 0;
    const need = atrPct > 0.015 ? Math.min(4, base + 1) : base;
    if (need !== base) {
      this.emitLog('debug', 'Adaptive', `${symbol} volatilite ${(atrPct * 100).toFixed(2)}% → min güç ${need}/4`);
    }
    return need;
  }

  /** Adaptive risk: halve risk after 2 consecutive losses. */
  private effectiveRiskPerTrade(): number {
    if (this.config.adaptiveMode && this.consecLosses >= 2) {
      return this.config.riskPerTrade / 2;
    }
    return this.config.riskPerTrade;
  }

  // ── LIVE helpers (Binance spot) ─────────────────────────────
  private async ensureFilters(symbol: string): Promise<SymbolFilters | null> {
    const cached = this.filterCache.get(symbol);
    if (cached) return cached.f;
    if (!this.exchangeAPI) return null;
    try {
      const f = await fetchSymbolFilters(this.exchangeAPI.getBaseURL(), symbol);
      if (f) this.filterCache.set(symbol, { f, at: Date.now() });
      return f;
    } catch {
      return null;
    }
  }

  private async getUsdtFree(): Promise<number> {
    if (this.balanceCache && Date.now() - this.balanceCache.at < 20000) {
      return this.balanceCache.usdtFree;
    }
    if (!this.exchangeAPI) return 0;
    try {
      const bals = await this.exchangeAPI.getBalances();
      const usdt = bals['USDT']?.free ?? 0;
      this.balanceCache = { usdtFree: usdt, at: Date.now() };
      return usdt;
    } catch (err) {
      this.logger.error('Balance fetch failed', err);
      return this.balanceCache?.usdtFree ?? 0;
    }
  }

  private errMsg(err: unknown): string {
    const e = err as { response?: { data?: { msg?: string; code?: number } }; message?: string };
    const apiMsg = e?.response?.data?.msg;
    const code = e?.response?.data?.code;
    return apiMsg ? `Binance [${code ?? '?'}]: ${apiMsg}` : (e?.message ?? String(err));
  }

  /**
   * Catastrophe backstop resting on the exchange so a dead bot/PC never
   * leaves a naked position. Spot: STOP_LOSS_LIMIT. Futures: STOP_MARKET
   * reduce-only. Trailing stays bot-managed.
   */
  private async placeBackstop(position: Position): Promise<void> {
    if (!this.live || !this.exchangeAPI) return;
    try {
      const rd = position.riskDistance ?? 0;
      if (!(rd > 0) || !(position.quantity > 0)) return;
      const isFut = this.config.market === 'futures';
      const f = await this.ensureFilters(position.symbol);
      const qtyStr = f ? formatStep(position.quantity, f.stepSize) : position.quantity.toString();
      const px = (p: number) => (f ? formatStep(p, f.tickSize) : p.toString());
      const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';
      let res;
      if (isFut) {
        const trig = position.side === 'LONG' ? position.entryPrice - 3 * rd : position.entryPrice + 3 * rd;
        res = await this.exchangeAPI.placeOrder({
          symbol: position.symbol, side: exitSide, type: 'STOP_MARKET',
          quantity: qtyStr, stopPrice: px(trig), reduceOnly: true,
        });
      } else {
        // Spot backstop exists only for LONG (spot can't be short)
        if (position.side !== 'LONG') return;
        const trig = position.entryPrice - 3 * rd;
        const lim = trig * 0.999;
        res = await this.exchangeAPI.placeOrder({
          symbol: position.symbol, side: 'SELL', type: 'STOP_LOSS_LIMIT',
          quantity: qtyStr, price: px(lim), stopPrice: px(trig), timeInForce: 'GTC',
        });
      }
      position.extStopId = String(res.orderId ?? '');
      this.persistPaper();
      this.emitLog('info', 'Live', `Felaket-stopu backstop borsada (${position.symbol}, order ${position.extStopId})`);
    } catch (err) {
      this.emitLog('error', 'Live', `Backstop konulamadı (${position.symbol}): ${this.errMsg(err)} — bot izlemeye devam ediyor`);
    }
  }

  private async cancelBackstop(position: Position): Promise<void> {
    if (!this.exchangeAPI || !position.extStopId) return;
    try {
      await this.exchangeAPI.cancelOrder(position.symbol, position.extStopId);
      position.extStopId = undefined;
    } catch (err) {
      this.logger.error(`Backstop cancel failed (${position.symbol})`, err);
    }
  }

  /** Re-issue the backstop after a partial (quantity changed). */
  private async refreshBackstop(position: Position): Promise<void> {
    if (!this.live) return;
    await this.cancelBackstop(position);
    await this.placeBackstop(position);
  }

  /**
   * Real entry: market BUY with filter-quantized size, accounting from the
   * ACTUAL fill (never the quote). Any failure = no position, money untouched.
   */
  private async openLive(
    signal: SignalData, quantity: number, stopLoss: number, takeProfit: number
  ): Promise<void> {
    const api = this.exchangeAPI;
    if (!api) return;
    const symbol = signal.symbol;
    const entrySide = signal.side; // BUY = LONG, SELL = SHORT (futures only)
    try {
      const f = await this.ensureFilters(symbol);
      const qtyStr = f ? formatStep(quantity, f.stepSize) : quantity.toString();
      this.emitLog('warn', 'Live', `GERÇEK EMİR gönderiliyor: MARKET ${entrySide} ${qtyStr} ${symbol}…`);
      const res = await api.placeOrder({ symbol, side: entrySide, type: 'MARKET', quantity: qtyStr });
      const fills = (res.fills ?? []) as Array<{ price: string; qty: string }>;
      let fq = 0;
      let qp = 0;
      for (const fl of fills) {
        const q = parseFloat(fl.qty);
        fq += q;
        qp += q * parseFloat(fl.price);
      }
      if (!(fq > 0)) {
        fq = parseFloat(res.executedQty ?? '0');
        qp = parseFloat(res.cummulativeQuoteQty ?? '0');
      }
      if (!(fq > 0)) throw new Error('Emir dolmadı (executedQty=0) — para hareket etmedi');
      const fillPrice = qp / fq;
      const aiCached = this.aiVerdicts.get(symbol);
      const posSide: 'LONG' | 'SHORT' = entrySide === 'BUY' ? 'LONG' : 'SHORT';
      const position = await this.openPosition(symbol, posSide, fillPrice, fq, stopLoss, takeProfit, signal.strategy ?? 'strategy', {
        reason: signal.reason,
        strength: signal.strength,
        rsi: signal.indicators.rsi,
        macdHist: signal.indicators.macd.histogram,
        emaFast: signal.indicators.ema.fast,
        emaSlow: signal.indicators.ema.slow,
        atr: signal.indicators.atr,
        aiBias: aiCached?.verdict.bias,
        aiConfidence: aiCached?.verdict.confidence,
      }, signal.tpMultiplier ?? this.config.takeProfitRiskReward);
      position.extOrderId = String(res.orderId ?? '');
      await this.placeBackstop(position);
      this.persistPaper();
      this.emitLog('success', 'Live', `GERÇEK POZİSYON: ${posSide} ${fq} ${symbol} @ ${fillPrice} (borsa order ${position.extOrderId})`);
    } catch (err) {
      this.emitLog('error', 'Live', `Gerçek emir BAŞARISIZ (${symbol}): ${this.errMsg(err)} — pozisyon açılmadı`);
    }
  }

  // ── Order execution + risk ─────────────────────────────────
  private async executeSignal(signal: SignalData): Promise<void> {
    const skip = (category: 'max-positions' | 'duplicate' | 'side-filter' | 'cooldown' | 'halted' | 'htf' | 'no-margin' | 'exposure' | 'min-notional' | 'side-cap') => {
      this.journal.recordSkip({
        t: Date.now(), symbol: signal.symbol, side: signal.side,
        price: signal.price, strength: signal.strength, category,
      });
    };
    // Circuit breaker: no new entries while halted (by design silent — halt was announced loudly)
    if (this.haltedForDay) {
      skip('halted');
      return;
    }
    // Position limits
    const openCount = [...this.positions.values()].filter((p) => p.status === 'OPEN').length;
    if (openCount >= this.config.maxPositions) {
      this.emitLog('warn', 'Risk', `Signal skipped — max positions (${this.config.maxPositions}) reached`);
      skip('max-positions');
      return;
    }
    // No duplicate side on same symbol
    const existing = [...this.positions.values()].find((p) => p.symbol === signal.symbol && p.status === 'OPEN');
    if (existing) {
      this.emitLog('info', 'Risk', `Signal skipped — already have ${existing.side} position on ${signal.symbol}`);
      skip('duplicate');
      return;
    }
    // Direction filter
    const side: 'LONG' | 'SHORT' = signal.side === 'BUY' ? 'LONG' : 'SHORT';
    // Direction concentration guard: cap same-side open positions
    const sameSideCount = [...this.positions.values()].filter((p) => p.status === 'OPEN' && p.side === side).length;
    const sameSideCap = this.config.maxSameSide ?? 2;
    if (sameSideCount >= sameSideCap) {
      this.emitLog('info', 'Risk', `Signal skipped — aynı yön tavanı dolu (${sameSideCount}/${sameSideCap} ${side}), yön çeşitliliği korunuyor`);
      skip('side-cap');
      return;
    }
    if (this.config.tradingSide === 'long-only' && side === 'SHORT') {
      this.emitLog('info', 'Risk', `Signal skipped — long-only mode`);
      skip('side-filter');
      return;
    }
    if (this.config.tradingSide === 'short-only' && side === 'LONG') {
      this.emitLog('info', 'Risk', `Signal skipped — short-only mode`);
      skip('side-filter');
      return;
    }
    // Smart cooldown: winners re-enter immediately, losers sit out briefly
    // (prevents revenge-trading the same stopped-out setup in chop).
    const cdMin = this.config.cooldownMinutes || 0;
    if (cdMin > 0) {
      const lastClose = this.lastCloseAt.get(signal.symbol) ?? 0;
      const waitedMin = (Date.now() - lastClose) / 60000;
      const lastWasLoss = (this.lastClosePnl.get(signal.symbol) ?? 0) < 0;
      if (lastWasLoss && waitedMin < cdMin) {
        this.emitLog('info', 'Risk', `Signal skipped — zararla kapanan işlem sonrası mola ${(cdMin - waitedMin).toFixed(1)} dk kaldı (${signal.symbol})`);
        skip('cooldown');
        return;
      }
    }

    // Higher-timeframe trend filter: never fight the 1h trend
    if (this.config.htfFilterEnabled) {
      const htfTrend = await this.getHTFTrend(signal.symbol);
      if (htfTrend) {
        const agrees =
          (signal.side === 'BUY' && htfTrend === 'UP') ||
          (signal.side === 'SELL' && htfTrend === 'DOWN');
        if (!agrees) {
          this.emitLog('info', 'Trend', `${signal.symbol}: sinyal ${signal.side} ama ${this.config.htfTimeframe || '1h'} trend ${htfTrend === 'UP' ? 'YUKARI' : 'AŞAĞI'} — ana trende kafa atılmadı, pas geçildi`);
          skip('htf');
          return;
        }
      }
    }

    const atr = signal.indicators.atr || signal.price * 0.005;
    const stopLoss = this.riskManager.calculateStopLoss(signal.price, atr, side, this.config.stopLossATRMultiplier);
    const balance = this.getTotalBalance();
    const effRisk = this.effectiveRiskPerTrade();
    if (effRisk !== this.config.riskPerTrade) {
      this.emitLog('warn', 'Adaptive', `Arka arkaya ${this.consecLosses} zarar — risk yarıya: %${(effRisk * 100).toFixed(1)}`);
    }
    const metrics = this.riskManager.calculatePositionSize(balance, signal.price, stopLoss, this.config.leverage, effRisk);
    let quantity = metrics.positionSize / signal.price;
    if (quantity <= 0 || !isFinite(quantity)) return;

    // Exchange filters: floor to LOT_SIZE step (real orders get rejected otherwise)
    const filters = this.exchangeAPI ? await this.ensureFilters(signal.symbol) : null;
    if (filters) {
      quantity = floorToStep(quantity, filters.stepSize);
      if (!(quantity > 0)) {
        this.emitLog('debug', 'Risk', `Signal skipped — miktar borsa adımının altında toz (${signal.symbol})`);
        return;
      }
    }

    // Exchange minimum: positions below min notional would be rejected for real
    const notional = quantity * signal.price;
    const minNot = Math.max(this.config.minNotional ?? 0, filters?.minNotional ?? 0);
    if (minNot > 0 && notional < minNot) {
      this.emitLog('debug', 'Risk', `Signal skipped — tutar $${notional.toFixed(2)} borsa minimumunun ($${minNot}) altında (${signal.symbol})`);
      skip('min-notional');
      return;
    }

    // Margin gate: never open what the account can't cover (available can never go negative)
    const exposure = this.riskManager.checkExposure(
      balance,
      [...this.positions.values()].filter((p) => p.status === 'OPEN').map((p) => p.margin),
      metrics.marginRequired
    );
    if (!exposure.ok) {
      this.emitLog('warn', 'Risk', `Signal skipped — ${exposure.reason} (${signal.symbol})`);
      skip(exposure.code);
      return;
    }

    const takeProfit = this.riskManager.calculateTakeProfit(signal.price, stopLoss, side, signal.tpMultiplier ?? this.config.takeProfitRiskReward);

    // LIVE MODE: entries go to the real book (spot = LONG-only, futures = LONG+SHORT)
    if (this.live) {
      if (side === 'SHORT' && this.config.market !== 'futures') {
        this.emitLog('warn', 'Risk', `Signal skipped — spot canlı modda SHORT yok, sadece LONG (${signal.symbol})`);
        skip('side-filter');
        return;
      }
      const free = await this.getUsdtFree();
      if (quantity * signal.price > free) {
        this.emitLog('warn', 'Risk', `Signal skipped — USDT yetersiz (gerekli $${(quantity * signal.price).toFixed(2)}, boşta $${free.toFixed(2)})`);
        skip('no-margin');
        return;
      }
      await this.openLive(signal, quantity, stopLoss, takeProfit);
      return;
    }

    if (this.config.useLimitOrders) {
      // Limit order simulation: rests on book, fills when touched
      const order: Order = {
        id: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        symbol: signal.symbol,
        side: signal.side,
        type: 'LIMIT',
        quantity,
        price: signal.price,
        status: 'NEW',
        filledQuantity: 0,
        avgFillPrice: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        reduceOnly: false,
        positionSide: side,
      };
      this.openOrders.set(order.id, order);
      this.emitLog('info', 'Order', `LIMIT ${order.side} ${quantity.toFixed(5)} ${signal.symbol} @ ${signal.price} placed (simulated)`);
      this.broadcast('order:update', order);
      return;
    }

    const aiCached = this.aiVerdicts.get(signal.symbol);
    await this.openPosition(signal.symbol, side, signal.price, quantity, stopLoss, takeProfit, signal.strategy ?? 'strategy', {
      reason: signal.reason,
      strength: signal.strength,
      rsi: signal.indicators.rsi,
      macdHist: signal.indicators.macd.histogram,
      emaFast: signal.indicators.ema.fast,
      emaSlow: signal.indicators.ema.slow,
      atr: signal.indicators.atr,
      aiBias: aiCached?.verdict.bias,
      aiConfidence: aiCached?.verdict.confidence,
    }, signal.tpMultiplier ?? this.config.takeProfitRiskReward);
  }

  private async openPosition(
    symbol: string, side: 'LONG' | 'SHORT', entryPrice: number,
    quantity: number, stopLoss: number, takeProfit: number, strategy: string,
    meta?: JournalOpenMeta,
    tpRR?: number,
  ): Promise<Position> {
    const liquidation = this.riskManager.calculateLiquidationPrice(entryPrice, side, this.config.leverage);
    const position: Position = {
      id: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol, side, entryPrice, quantity,
      leverage: this.config.leverage,
      stopLoss, takeProfit,
      unrealizedPnL: 0, realizedPnL: 0,
      margin: (entryPrice * quantity) / this.config.leverage,
      liquidationPrice: liquidation,
      createdAt: Date.now(), updatedAt: Date.now(),
      status: 'OPEN', strategy,
      riskDistance: Math.abs(entryPrice - stopLoss),
      breakevenDone: false,
      partialDone: false,
      partialPnl: 0,
      partialFees: 0,
      initialRisk: Math.abs(entryPrice - stopLoss) * quantity,
    };
    this.positions.set(position.id, position);
    this.totalTrades++;
    if (meta) this.openMeta.set(position.id, meta);
    this.excursion.set(position.id, { mfe: 0, mae: 0 });
    this.persistPaper();

    const order: Order = {
      id: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol, side: side === 'LONG' ? 'BUY' : 'SELL',
      type: 'MARKET', quantity, status: 'FILLED',
      filledQuantity: quantity, avgFillPrice: entryPrice,
      createdAt: Date.now(), updatedAt: Date.now(),
      reduceOnly: false, positionSide: side,
    };
    this.orderHistory.unshift(order);

    this.emitLog('success', 'Position',
      `OPEN ${side} ${quantity.toFixed(5)} ${symbol} @ ${entryPrice} | SL ${stopLoss.toFixed(2)} | TP ${takeProfit.toFixed(2)} | R:R 1:${tpRR ?? this.config.takeProfitRiskReward} [${strategy}]`);
    this.broadcast('position:update', position);
    this.broadcast('order:update', order);
    this.broadcastPortfolio();
    this.logger.info(`Position opened ${position.id}`, position);
    return position;
  }

  private async closePosition(position: Position, exitPrice: number, reason: string): Promise<void> {
    // LIVE: cancel backstop, exit on the real book FIRST — books use the REAL fill.
    // If the real exit fails, the position stays OPEN (never pretend).
    if (this.live && this.exchangeAPI) {
      await this.cancelBackstop(position);
      try {
        const f = await this.ensureFilters(position.symbol);
        const qtyStr = f ? formatStep(position.quantity, f.stepSize) : position.quantity.toString();
        const exitSide = position.side === 'LONG' ? 'SELL' : 'BUY';
        const res = await this.exchangeAPI.placeOrder({ symbol: position.symbol, side: exitSide, type: 'MARKET', quantity: qtyStr, reduceOnly: this.config.market === 'futures' });
        const fills = (res.fills ?? []) as Array<{ price: string; qty: string }>;
        let fq = 0;
        let qp = 0;
        for (const fl of fills) {
          const q = parseFloat(fl.qty);
          fq += q;
          qp += q * parseFloat(fl.price);
        }
        if (!(fq > 0)) {
          fq = parseFloat(res.executedQty ?? '0');
          qp = parseFloat(res.cummulativeQuoteQty ?? '0');
        }
        if (!(fq > 0)) throw new Error('Çıkış emri dolmadı (executedQty=0)');
        exitPrice = qp / fq;
        position.quantity = fq;
        this.emitLog('success', 'Live', `GERÇEK ÇIKIŞ: ${position.side} ${position.symbol} @ ${exitPrice.toFixed(2)} (${reason})`);
      } catch (err) {
        this.emitLog('error', 'Live', `Gerçek çıkış BAŞARISIZ (${position.symbol}): ${this.errMsg(err)} — pozisyon AÇIK tutuluyor, backstop yenilendi`);
        await this.placeBackstop(position);
        return;
      }
    }
    // Fill math (slippage + proportional commission) + any banked partial profit
    const r = this.riskManager.computeClosePnl(
      position.entryPrice, exitPrice, position.quantity, position.side,
      this.effCommission, this.config.slippageBps || 0
    );
    const fillPrice = r.fillPrice;
    const commission = r.commission;
    const pnl = r.netPnl + (position.partialPnl ?? 0);
    position.realizedPnL = pnl;
    position.unrealizedPnL = 0;
    position.status = 'CLOSED';
    position.updatedAt = Date.now();

    this.realizedPnL += pnl;
    this.virtualBalance += pnl;
    if (pnl > 0) {
      this.winningTrades++;
      this.consecLosses = 0;
    } else {
      this.consecLosses++;
    }
    this.lastCloseAt.set(position.symbol, Date.now());
    this.lastClosePnl.set(position.symbol, pnl);

    const order: Order = {
      id: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol: position.symbol,
      side: position.side === 'LONG' ? 'SELL' : 'BUY',
      type: 'MARKET', quantity: position.quantity, status: 'FILLED',
      filledQuantity: position.quantity, avgFillPrice: fillPrice,
      createdAt: Date.now(), updatedAt: Date.now(),
      reduceOnly: true, positionSide: position.side,
    };
    this.orderHistory.unshift(order);

    this.emitLog(pnl >= 0 ? 'success' : 'error', 'Position',
      `CLOSE ${position.side} ${position.symbol} @ ${fillPrice.toFixed(2)} | PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} USDT (komisyon+slipaj -${commission.toFixed(2)}) | ${reason}`);

    // ── Journal: full trade record for later analysis ──
    try {
      const ex = this.excursion.get(position.id) ?? { mfe: pnl, mae: pnl };
      const mfe = Math.max(ex.mfe, pnl);
      const mae = Math.min(ex.mae, pnl);
      // R base = ORIGINAL risk (partial closes shrink qty but not the initial risk)
      const riskBase = position.initialRisk ?? (position.riskDistance ?? 0) * position.quantity;
      const meta = this.openMeta.get(position.id) ?? {};
      this.journal.recordClose({
        id: position.id,
        symbol: position.symbol,
        side: position.side,
        entryPrice: position.entryPrice,
        exitPrice,
        quantity: position.quantity,
        pnl,
        rMultiple: riskBase > 0 ? pnl / riskBase : 0,
        mfe,
        mfeR: riskBase > 0 ? mfe / riskBase : 0,
        mae,
        maeR: riskBase > 0 ? mae / riskBase : 0,
        holdMinutes: (Date.now() - position.createdAt) / 60000,
        entryReason: meta.reason ?? position.strategy,
        entryStrength: meta.strength ?? 0,
        rsi: meta.rsi ?? 0,
        macdHist: meta.macdHist ?? 0,
        atr: meta.atr ?? 0,
        aiBias: meta.aiBias ?? 'NONE',
        aiConfidence: meta.aiConfidence ?? 0,
        exitReason: reason,
        openedAt: position.createdAt,
        closedAt: Date.now(),
        fees: commission + (position.partialFees ?? 0),
      });
      this.journal.snapshotEquity(this.virtualBalance, `close ${position.symbol}`);
    } catch (err) {
      this.logger.error('Journal record failed', err);
    }
    this.openMeta.delete(position.id);
    this.excursion.delete(position.id);

    this.broadcast('position:update', { ...position });
    this.broadcast('order:update', order);
    this.positions.delete(position.id);
    this.broadcastPortfolio();
    this.persistPaper();
    this.checkDailyBreaker();
  }

  /** Manual close from the UI (market price). */
  async closePositionById(id: string, reason = 'MANUEL KAPATMA'): Promise<{ success: boolean; message: string }> {
    const position = this.positions.get(id);
    if (!position || position.status !== 'OPEN') {
      return { success: false, message: 'Pozisyon bulunamadı' };
    }
    const market = this.marketCache.get(position.symbol);
    const exitPrice = market?.price ?? position.entryPrice;
    await this.closePosition(position, exitPrice, reason);
    return { success: true, message: `${position.symbol} kapatıldı @ ${exitPrice.toFixed(2)}` };
  }

  private async checkMaxHold(symbol: string): Promise<void> {
    const maxMin = this.config.maxHoldMinutes || 0;
    if (maxMin <= 0) return;
    const now = Date.now();
    for (const position of [...this.positions.values()]) {
      if (position.symbol !== symbol || position.status !== 'OPEN') continue;
      if (now - position.createdAt > maxMin * 60000) {
        const market = this.marketCache.get(symbol);
        await this.closePosition(position, market?.price ?? position.entryPrice, `maks. taşıma süresi (${maxMin} dk)`);
      }
    }
  }

  /** Mean-reversion entry: support dip / resistance rejection in ranges. */
  private checkMeanReversion(symbol: string, price: number, candles: CandleData[], ind: IndicatorData): SignalData | null {
    const struct = analyzeStructure(candles);
    const side = meanReversionSide(struct, price, ind.atr, ind.rsi, ind.adx || 0, this.config.adxThreshold || 20);
    if (!side) return null;
    const level = side === 'BUY' ? struct.support! : struct.resistance!;
    return {
      symbol, side, price, strength: 2, indicators: ind,
      reason: `mean-reversion ${side === 'BUY' ? 'destek' : 'direnç'} ${level.toFixed(2)} + RSI ${ind.rsi.toFixed(1)}`,
      timestamp: Date.now(), strategy: 'mean-reversion', tpMultiplier: 1,
    };
  }

  /**
   * Higher-timeframe trend via EMA9/21. Returns null when data is missing —
   * fail-open by design: never block trades on missing HTF data.
   */
  private async getHTFTrend(symbol: string): Promise<'UP' | 'DOWN' | null> {
    try {
      const tf = this.config.htfTimeframe || '1h';
      const key = `${symbol}:${tf}`;
      let candles = this.candleCache.get(key);
      if (!candles || candles.length < 30) {
        await this.refreshCandles(symbol, tf, 60);
        candles = this.candleCache.get(key);
      }
      if (!candles || candles.length < 25) return null;
      const closes = candles.map((c) => c.close);
      const fast = TechnicalIndicators.calculateEMA(closes, 9);
      const slow = TechnicalIndicators.calculateEMA(closes, 21);
      const f = fast[fast.length - 1];
      const s = slow[slow.length - 1];
      if (!isFinite(f) || !isFinite(s) || f === s) return null;
      return f > s ? 'UP' : 'DOWN';
    } catch {
      return null;
    }
  }

  private getATR(symbol: string): number {
    const candles = this.candleCache.get(`${symbol}:${this.config.timeframe}`);
    if (!candles || candles.length < 20) return 0;
    const atr = TechnicalIndicators.calculateATR(
      candles.map((c) => c.high),
      candles.map((c) => c.low),
      candles.map((c) => c.close)
    );
    return atr.length ? atr[atr.length - 1] : 0;
  }

  // ── Gemini AI gate/assist ──────────────────────────────────
  private async applyAIGate(signal: SignalData): Promise<boolean> {
    try {
      const gemini = this.app.getSettingsService().getGemini();
      if (!gemini) {
        if (!this.aiWarnedNoKey) {
          this.emitLog('warn', 'AI', 'AI modu açık ama Gemini anahtarı yok — Ayarlar → Yapay Zekâ bölümünden ekleyin. Sinyaller teknik motorla devam ediyor.');
          this.aiWarnedNoKey = true;
        }
        return true;
      }
      const cached = this.aiVerdicts.get(signal.symbol);
      let verdict = cached && Date.now() - cached.at < 10 * 60000 ? cached.verdict : null;
      if (!verdict) {
        const existing = [...this.positions.values()].find((p) => p.symbol === signal.symbol && p.status === 'OPEN');
        const candles = this.candleCache.get(`${signal.symbol}:${this.config.timeframe}`) ?? [];
        // Analyst context: structure + flow + sentiment for the AI synthesis
        const struct = analyzeStructure(candles);
        const flow = this.flowCache.get(signal.symbol);
        const ctxLines: string[] = [
          `Yapı: ${struct.trend}${struct.bos ? `, BOS-${struct.bos}` : ''}` +
          (struct.resistance !== null ? `, direnç ${struct.resistance.toFixed(2)} (+${struct.resistanceDistPct?.toFixed(2)}%)` : '') +
          (struct.support !== null ? `, destek ${struct.support.toFixed(2)} (${struct.supportDistPct?.toFixed(2)}%)` : ''),
        ];
        const ob = this.orderBookCache.get(signal.symbol);
        if (ob) {
          const bids = ob.bids.slice(0, 10).reduce((s, b) => s + b[0] * b[1], 0);
          const asks = ob.asks.slice(0, 10).reduce((s, a) => s + a[0] * a[1], 0);
          if (bids + asks > 0) {
            const imb = (bids - asks) / (bids + asks);
            ctxLines.push(`Defter dengesizliği: ${imb >= 0 ? 'alıcı' : 'satıcı'} baskısı ${Math.abs(imb).toFixed(2)}`);
          }
        }
        if (flow?.funding != null) {
          ctxLines.push(`Funding: %${(flow.funding * 100).toFixed(4)} (${flow.funding > 0.0005 ? 'longlar kalabalık-dikkat' : flow.funding < -0.0005 ? 'shortlar kalabalık' : 'nötr'})`);
        }
        if (flow?.oi != null) ctxLines.push(`Open Interest: ${flow.oi.toFixed(0)} kontrat`);
        if (this.fearGreed) ctxLines.push(`Korku-Açgözlülük: ${this.fearGreed.value} (${this.fearGreed.label})`);
        verdict = await this.ai.analyze(gemini.apiKey, gemini.model, {
          symbol: signal.symbol,
          price: signal.price,
          timeframe: this.config.timeframe,
          indicators: signal.indicators,
          closes: candles.map((c) => c.close),
          position: existing ? { side: existing.side, entryPrice: existing.entryPrice, unrealizedPnL: existing.unrealizedPnL } : null,
          context: ctxLines.join('\n'),
        });
        if (verdict) this.aiVerdicts.set(signal.symbol, { verdict, at: Date.now() });
      }
      if (!verdict) return true; // AI failed → technical engine decides
      const confPct = Math.round(verdict.confidence * 100);
      if (this.config.aiMode === 'assist') {
        this.emitLog('info', 'AI', `${signal.symbol}: AI ${verdict.bias} (%${confPct}) — ${verdict.reason}`);
        return true;
      }
      // gate mode
      const agrees =
        (signal.side === 'BUY' && verdict.bias === 'LONG') ||
        (signal.side === 'SELL' && verdict.bias === 'SHORT');
      if (verdict.bias === 'NEUTRAL' || verdict.confidence < 0.6) {
        this.emitLog('info', 'AI', `${signal.symbol}: AI kararsız (${verdict.bias} %${confPct}) — teknik sinyal geçerli`);
        return true;
      }
      if (!agrees) {
        this.emitLog('warn', 'AI', `${signal.symbol}: AI vetosu — teknik ${signal.side} ama AI ${verdict.bias} (%${confPct}). ${verdict.reason}`);
        this.journal.recordSkip({
          t: Date.now(), symbol: signal.symbol, side: signal.side,
          price: signal.price, strength: signal.strength, category: 'ai-veto',
        });
        return false;
      }
      this.emitLog('success', 'AI', `${signal.symbol}: AI onayladı (${verdict.bias} %${confPct}) — ${verdict.reason}`);
      return true;
    } catch (err) {
      this.logger.error('AI gate failed', err);
      return true;
    }
  }

  getAIVerdict(symbol: string): AIVerdict | null {
    const cached = this.aiVerdicts.get(symbol.toUpperCase());
    return cached ? cached.verdict : null;
  }

  /**
   * Partial take-profit: close HALF at market, bank the profit, pull SL to
   * entry and let the runner work. Wins are NOT counted here — only the
   * final close decides win/loss (avoids double counting).
   */
  private async closePartial(position: Position, price: number): Promise<void> {
    let closeQty = position.quantity * 0.5;
    if (!(closeQty > 0)) return;
    // LIVE: real half-sell first; backstop re-issued for the runner
    if (this.live && this.exchangeAPI) {
      await this.cancelBackstop(position);
      try {
        const f = await this.ensureFilters(position.symbol);
        const qtyStr = f ? formatStep(closeQty, f.stepSize) : closeQty.toString();
        const res = await this.exchangeAPI.placeOrder({
          symbol: position.symbol,
          side: position.side === 'LONG' ? 'SELL' : 'BUY',
          type: 'MARKET', quantity: qtyStr,
          reduceOnly: this.config.market === 'futures',
        });
        const fills = (res.fills ?? []) as Array<{ price: string; qty: string }>;
        let fq = 0;
        let qp = 0;
        for (const fl of fills) {
          const q = parseFloat(fl.qty);
          fq += q;
          qp += q * parseFloat(fl.price);
        }
        if (!(fq > 0)) {
          fq = parseFloat(res.executedQty ?? '0');
          qp = parseFloat(res.cummulativeQuoteQty ?? '0');
        }
        if (!(fq > 0)) throw new Error('Kısmi çıkış dolmadı');
        price = qp / fq;
        closeQty = fq;
      } catch (err) {
        this.emitLog('error', 'Live', `Gerçek kısmi çıkış BAŞARISIZ (${position.symbol}): ${this.errMsg(err)} — backstop yenilendi`);
        await this.placeBackstop(position);
        return;
      }
    }
    const r = this.riskManager.computeClosePnl(
      position.entryPrice, price, closeQty, position.side,
      this.effCommission, this.config.slippageBps || 0
    );
    position.quantity -= closeQty;
    position.margin = (position.entryPrice * position.quantity) / this.config.leverage;
    position.realizedPnL += r.netPnl;
    this.realizedPnL += r.netPnl;
    this.virtualBalance += r.netPnl;
    position.partialPnl = (position.partialPnl ?? 0) + r.netPnl;
    position.partialFees = (position.partialFees ?? 0) + r.commission;
    position.partialDone = true;
    position.stopLoss = position.entryPrice; // runner is now risk-free
    position.updatedAt = Date.now();

    const order: Order = {
      id: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol: position.symbol,
      side: position.side === 'LONG' ? 'SELL' : 'BUY',
      type: 'MARKET', quantity: closeQty, status: 'FILLED',
      filledQuantity: closeQty, avgFillPrice: r.fillPrice,
      createdAt: Date.now(), updatedAt: Date.now(),
      reduceOnly: true, positionSide: position.side,
    };
    this.orderHistory.unshift(order);

    this.emitLog('success', 'Position',
      `KISMİ KÂR ${position.side} ${position.symbol} yarısı @ ${r.fillPrice.toFixed(2)} | +${r.netPnl.toFixed(2)} USDT bankaya | kalan koşuyor (SL girişte)`);
    await this.refreshBackstop(position);
    this.broadcast('position:update', { ...position });
    this.broadcast('order:update', order);
    this.broadcastPortfolio();
    this.persistPaper();
  }

  private async checkStopTakeProfit(symbol: string, price: number): Promise<void> {
    for (const position of [...this.positions.values()]) {
      if (position.symbol !== symbol || position.status !== 'OPEN') continue;
      // Fill resting limit orders first
      for (const order of [...this.openOrders.values()]) {
        if (order.symbol !== symbol || order.status !== 'NEW') continue;
        const touched = order.side === 'BUY' ? price <= (order.price ?? price) : price >= (order.price ?? price);
        if (touched && order.positionSide) {
          this.openOrders.delete(order.id);
          order.status = 'FILLED';
          order.filledQuantity = order.quantity;
          order.avgFillPrice = order.price ?? price;
          order.updatedAt = Date.now();
          this.orderHistory.unshift({ ...order });
          this.broadcast('order:update', { ...order });
          const atrGuess = Math.abs((order.price ?? price) - price) || price * 0.005;
          const sl = this.riskManager.calculateStopLoss(order.avgFillPrice, atrGuess, order.positionSide, this.config.stopLossATRMultiplier);
          const tp = this.riskManager.calculateTakeProfit(order.avgFillPrice, sl, order.positionSide, this.config.takeProfitRiskReward);
          await this.openPosition(symbol, order.positionSide, order.avgFillPrice, order.quantity, sl, tp, 'limit-fill');
        }
      }
      const validation = this.riskManager.validatePosition(position, {
        symbol, price, bid: price, ask: price, volume24h: 0,
        change24h: 0, changePercent24h: 0, high24h: price, low24h: price, timestamp: Date.now(),
      });
      if (validation.action === 'CLOSE') {
        await this.closePosition(position, price, validation.reason ?? 'SL/TP');
      }
    }
  }

  private async refreshPositionsPnL(): Promise<void> {
    let changed = false;
    for (const position of this.positions.values()) {
      const market = this.marketCache.get(position.symbol);
      if (!market) continue;
      const pnl = position.side === 'LONG'
        ? (market.price - position.entryPrice) * position.quantity
        : (position.entryPrice - market.price) * position.quantity;
      if (Math.abs(pnl - position.unrealizedPnL) > 1e-9) {
        position.unrealizedPnL = pnl;
        position.updatedAt = Date.now();
        changed = true;
      }
      // Partial take-profit: bank half at +NR, ride the rest with SL at entry
      const partialR = this.config.partialTPEnabled ? (this.config.partialTP_R ?? 1) : 0;
      if (partialR > 0 && !position.partialDone && (position.riskDistance ?? 0) > 0 && position.quantity > 0) {
        const targetProfit = position.riskDistance! * position.quantity * partialR;
        if (pnl >= targetProfit) {
          await this.closePartial(position, market.price);
          changed = true;
          continue; // trailing/breakeven re-evaluated next tick on the runner
        }
      }
      // MFE/MAE excursion tracking for the journal
      const ex = this.excursion.get(position.id);
      if (ex) {
        if (pnl > ex.mfe) { ex.mfe = pnl; changed = true; }
        if (pnl < ex.mae) { ex.mae = pnl; changed = true; }
      }
      // Trailing stop: follow price at ATR × multiplier once in profit
      if (this.config.trailingStopEnabled && market.price !== position.entryPrice) {
        const atr = this.getATR(position.symbol);
        if (atr > 0) {
          const trail = atr * (this.config.trailingATRMultiplier || 1.5);
          if (position.side === 'LONG' && market.price > position.entryPrice) {
            const newSL = market.price - trail;
            if (newSL > position.stopLoss) {
              position.stopLoss = newSL;
              changed = true;
              this.emitLog('debug', 'Trail', `${position.symbol} LONG SL → ${newSL.toFixed(2)}`);
            }
          } else if (position.side === 'SHORT' && market.price < position.entryPrice) {
            const newSL = market.price + trail;
            if (newSL < position.stopLoss) {
              position.stopLoss = newSL;
              changed = true;
              this.emitLog('debug', 'Trail', `${position.symbol} SHORT SL → ${newSL.toFixed(2)}`);
            }
          }
        }
      }
      // Breakeven: lock in entry once profit hits N×R
      const beR = this.config.breakevenTriggerR || 0;
      if (beR > 0 && !position.breakevenDone && (position.riskDistance ?? 0) > 0) {
        // Skip if SL is already at/beyond entry (e.g. partial TP locked it)
        const alreadyBE = position.side === 'LONG'
          ? position.stopLoss >= position.entryPrice
          : position.stopLoss <= position.entryPrice;
        if (alreadyBE) {
          position.breakevenDone = true;
        } else {
          const targetProfit = position.riskDistance! * position.quantity * beR;
          if (pnl >= targetProfit) {
            const lockedSide = position.side;
            position.stopLoss = position.entryPrice;
            position.breakevenDone = true;
            changed = true;
            this.emitLog('success', 'Risk', `${position.symbol} ${lockedSide} başabaş güvencesi — SL girişe çekildi (+${beR}R kârda)`);
          }
        }
      }
      if (changed) this.broadcast('position:update', { ...position });
    }
    if (changed) this.broadcastPortfolio();
  }

  // ── Public getters (used by IPC) ───────────────────────────
  async subscribeToSymbols(symbols: string[]): Promise<void> {
    symbols.forEach((s) => this.subscribedSymbols.add(s.toUpperCase()));
    if (this.running) {
      this.connectWebSocket();
      await this.refreshAllMarketData();
    }
  }

  async unsubscribeFromSymbols(symbols: string[]): Promise<void> {
    symbols.forEach((s) => this.subscribedSymbols.delete(s.toUpperCase()));
  }

  getMarketData(symbol: string) {
    return this.marketCache.get(symbol.toUpperCase()) ?? null;
  }

  getOrderBook(symbol: string) {
    return this.orderBookCache.get(symbol.toUpperCase()) ?? null;
  }

  async getRecentTrades(symbol: string, limit: number) {
    try {
      if (this.exchangeAPI) return await this.exchangeAPI.getRecentTrades(symbol.toUpperCase(), limit);
      const res = await this.fetchTimeout(`${this.marketApi('/trades')}?symbol=${symbol.toUpperCase()}&limit=${limit}`);
      if (!res.ok) return [];
      const raw = await res.json() as any[];
      return raw.map((t: any) => ({ price: parseFloat(t.price), quantity: parseFloat(t.qty), time: t.time, side: (t.isBuyerMaker ? 'sell' : 'buy') as 'buy' | 'sell' }));
    } catch { return []; }
  }

  getPositions(): Position[] {
    return [...this.positions.values()];
  }

  getOpenOrders(): Order[] {
    return [...this.openOrders.values()];
  }

  getOrderHistory(limit: number): Order[] {
    return this.orderHistory.slice(0, limit);
  }

  async placeOrder(order: Omit<Order, 'id' | 'status' | 'createdAt'>): Promise<{ success: boolean; orderId?: string; message: string }> {
    try {
      const full: Order = {
        ...order, id: `ord-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        status: 'FILLED', filledQuantity: order.quantity,
        avgFillPrice: order.price ?? this.marketCache.get(order.symbol)?.price ?? 0,
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      this.orderHistory.unshift(full);
      // Manual market order opens a position (simulated)
      const side: 'LONG' | 'SHORT' = order.side === 'BUY' ? 'LONG' : 'SHORT';
      const price = full.avgFillPrice;
      const atr = price * 0.005;
      const sl = this.riskManager.calculateStopLoss(price, atr, side, this.config.stopLossATRMultiplier);
      const tp = this.riskManager.calculateTakeProfit(price, sl, side, this.config.takeProfitRiskReward);
      await this.openPosition(order.symbol, side, price, order.quantity, sl, tp, 'manual');
      this.broadcast('order:update', full);
      return { success: true, orderId: full.id, message: 'Manual order executed (simulated)' };
    } catch (err) {
      return { success: false, message: String(err) };
    }
  }

  async cancelOrder(orderId: string): Promise<{ success: boolean; message: string }> {
    const order = this.openOrders.get(orderId);
    if (!order) return { success: false, message: 'Order not found' };
    order.status = 'CANCELED';
    order.updatedAt = Date.now();
    this.orderHistory.unshift({ ...order });
    this.openOrders.delete(orderId);
    this.broadcast('order:update', { ...order });
    this.persistPaper();
    return { success: true, message: 'Order canceled' };
  }

  getTotalBalance(): number {
    return this.virtualBalance;
  }

  getBalance(_asset: string): number {
    if (this.live && this.balanceCache) return this.balanceCache.usdtFree;
    return this.virtualBalance;
  }

  getPortfolioSummary(): PortfolioSummary {
    const positions = this.getPositions();
    const unrealized = positions.reduce((s, p) => s + p.unrealizedPnL, 0);
    if (this.live) {
      // Real money: cash = exchange USDT, positions marked to market
      const usdt = this.balanceCache?.usdtFree ?? this.virtualBalance;
      const posValue = positions.reduce(
        (s, p) => s + p.quantity * (this.marketCache.get(p.symbol)?.price ?? p.entryPrice),
        0
      );
      const totalValue = usdt + posValue;
      return {
        totalBalance: totalValue,
        availableBalance: usdt,
        unrealizedPnL: unrealized,
        realizedPnL: this.realizedPnL,
        totalPnL: this.realizedPnL + unrealized,
        totalValue,
        positions,
        dailyChange: this.realizedPnL + unrealized,
        dailyChangePercent: totalValue > 0 ? ((this.realizedPnL + unrealized) / totalValue) * 100 : 0,
      };
    }
    return {
      totalBalance: this.virtualBalance,
      availableBalance: this.virtualBalance - positions.reduce((s, p) => s + p.margin, 0),
      unrealizedPnL: unrealized,
      realizedPnL: this.realizedPnL,
      totalPnL: this.realizedPnL + unrealized,
      totalValue: this.virtualBalance + unrealized,
      positions,
      dailyChange: this.realizedPnL + unrealized,
      dailyChangePercent: ((this.realizedPnL + unrealized) / VIRTUAL_START_BALANCE) * 100,
    };
  }

  getIndicators(symbol: string, timeframe: string): IndicatorData {
    const candles = this.candleCache.get(`${symbol.toUpperCase()}:${timeframe}`);
    if (!candles || candles.length < 30) {
      return { rsi: 50, macd: { macd: 0, signal: 0, histogram: 0 }, ema: { fast: 0, slow: 0 }, atr: 0, bollinger: { upper: 0, middle: 0, lower: 0 }, volume: 0, vwap: 0, adx: 0 };
    }
    return TechnicalIndicators.calculateAllIndicators(candles);
  }

  /**
   * Candles for ANY symbol/timeframe — fetches on demand when the cache
   * is empty so chart TF buttons always work, not just the engine TF.
   */
  async getCandleData(symbol: string, timeframe: string, limit: number): Promise<CandleData[]> {
    const key = `${symbol.toUpperCase()}:${timeframe}`;
    let candles = this.candleCache.get(key) ?? [];
    if (candles.length < 50) {
      await this.refreshCandles(symbol.toUpperCase(), timeframe, Math.max(limit, 200));
      candles = this.candleCache.get(key) ?? [];
    }
    return candles.slice(-limit);
  }

  getStatus(): BotStatus {
    return {
      isRunning: this.running,
      live: this.live,
      currentStrategy: this.running ? 'EMA+MACD+RSI+ATR' : null,
      activeSymbols: [...this.subscribedSymbols],
      uptime: this.running ? Date.now() - this.startTime : 0,
      totalTrades: this.totalTrades,
      winRate: this.totalTrades > 0 ? (this.winningTrades / this.totalTrades) * 100 : 0,
      totalPnL: this.realizedPnL,
      lastSignal: this.lastSignal,
    };
  }

  // ── Paper persistence (bot memory) ─────────────────────────
  private persistPaper(): void {
    try {
      this.app.getSettingsService().savePaperState({
        version: 1,
        virtualBalance: this.virtualBalance,
        realizedPnL: this.realizedPnL,
        totalTrades: this.totalTrades,
        winningTrades: this.winningTrades,
        consecLosses: this.consecLosses,
        positions: [...this.positions.values()],
        openOrders: [...this.openOrders.values()],
        lastCloseAt: [...this.lastCloseAt.entries()],
        lastClosePnl: [...this.lastClosePnl.entries()],
        updatedAt: Date.now(),
      });
    } catch (err) {
      this.logger.error('Paper persist failed', err);
    }
  }

  async resetPaperAccount(): Promise<{ success: boolean; message: string }> {
    this.positions.clear();
    this.openOrders.clear();
    this.openMeta.clear();
    this.excursion.clear();
    const sb = Number(this.config.startBalance) || 0;
    this.virtualBalance = sb > 0 ? sb : VIRTUAL_START_BALANCE;
    this.realizedPnL = 0;
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.consecLosses = 0;
    this.lastCloseAt.clear();
    this.haltedForDay = false;
    this.resetDailyBreakerIfNeeded(true);
    this.persistPaper();
    this.journal.snapshotEquity(this.virtualBalance, `reset $${this.virtualBalance.toFixed(0)}`);
    this.emitLog('warn', 'Engine', `Simülasyon hesabı sıfırlandı: $${this.virtualBalance.toFixed(2)} (journal geçmişi korundu).`);
    this.broadcastPortfolio();
    this.broadcastStatus();
    return { success: true, message: `Hesap sıfırlandı ($${this.virtualBalance.toFixed(2)}). Journal geçmişi korundu.` };
  }

  /**
   * FULL testnet reset: new demo balance + positions wiped + journal wiped.
   * One click in Settings — no npm, no file hunting.
   */
  async resetEverything(startBalance: number): Promise<{ success: boolean; message: string }> {
    const sb = startBalance > 0 ? startBalance : 100;
    this.config.startBalance = sb;
    await this.app.getSettingsService().saveTradingConfig({ ...this.config });
    this.positions.clear();
    this.openOrders.clear();
    this.openMeta.clear();
    this.excursion.clear();
    this.virtualBalance = sb;
    this.realizedPnL = 0;
    this.totalTrades = 0;
    this.winningTrades = 0;
    this.consecLosses = 0;
    this.lastCloseAt.clear();
    this.lastClosePnl.clear();
    this.haltedForDay = false;
    this.resetDailyBreakerIfNeeded(true);
    this.journal.clearAll();
    this.persistPaper();
    this.journal.snapshotEquity(this.virtualBalance, 'full reset');
    this.emitLog('warn', 'Engine', `TAM SIFIRLAMA: $${sb.toFixed(2)} ile fresh start (hesap + journal temizlendi).`);
    this.broadcastPortfolio();
    this.broadcastStatus();
    return { success: true, message: `Her şey sıfırlandı — $${sb.toFixed(2)} ile fresh start! Botu başlatmayı unutma.` };
  }

  // ── Daily circuit breaker ──────────────────────────────────
  private todayKey(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private resetDailyBreakerIfNeeded(force = false): void {
    const key = this.todayKey();
    if (force || this.dayKey !== key) {
      const rolled = this.dayKey !== '' && this.dayKey !== key;
      this.dayKey = key;
      this.dayStartBalance = this.virtualBalance;
      this.haltedForDay = false;
      if (rolled) {
        this.emitLog('info', 'Risk', `Yeni gün — günlük zarar freni sıfırlandı (gün başı $${this.dayStartBalance.toFixed(2)}).`);
      }
    }
  }

  private checkDailyBreaker(): void {
    const limit = this.config.maxDailyLossPct || 0;
    if (limit <= 0 || this.haltedForDay) return;
    const dayPnlPct = this.dayStartBalance > 0
      ? (this.virtualBalance - this.dayStartBalance) / this.dayStartBalance
      : 0;
    if (dayPnlPct <= -limit) {
      this.haltedForDay = true;
      this.emitLog('error', 'Risk', `GÜNLÜK DEVRE KESİCİ: gün içi kayıp %${(-dayPnlPct * 100).toFixed(2)} (limit %${(limit * 100).toFixed(1)}). Yeni pozisyon açılmayacak — açık pozisyonlar SL/TP ile yönetilmeye devam edecek.`);
      this.broadcastStatus();
    }
  }

  // ── IPC emit helpers ───────────────────────────────────────
  private emitLog(level: 'info' | 'warn' | 'error' | 'debug' | 'success', context: string, message: string, meta?: any): void {
    const log = { id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, timestamp: Date.now(), level, context, message, meta };
    this.logger.info(`[${context}] ${message}`);
    const win = this.app.getMainWindow();
    win?.webContents.send('log:new', log);
  }

  private broadcast(channel: 'market:update' | 'position:update' | 'order:update' | 'portfolio:update' | 'bot:status-change', payload: unknown): void {
    const win = this.app.getMainWindow();
    win?.webContents.send(channel, payload);
  }

  private broadcastPortfolio(): void {
    this.broadcast('portfolio:update', this.getPortfolioSummary());
  }

  private broadcastStatus(): void {
    this.broadcast('bot:status-change', this.getStatus());
  }
}

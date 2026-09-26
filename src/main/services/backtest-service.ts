import { TechnicalIndicators } from './indicators/technical-indicators.js';
import { RiskManager } from './risk/risk-manager.js';
import { computeVotes } from './analysis/signal-votes.js';
import { analyzeStructure, meanReversionSide } from './analysis/market-structure.js';
import type {
  CandleData,
  TradingConfig,
  BacktestParams,
  BacktestResult,
  BacktestTrade,
  BacktestStats,
} from '../../renderer/types/trading.js';

const WARMUP = 200;

interface BTPosition {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  stopLoss: number;
  takeProfit: number;
  riskDistance: number;
  initialRisk: number;
  margin: number;
  entryTime: number;
  strategy: string;
  tpRR: number;
  partialDone: boolean;
  partialPnl: number;
  partialFees: number;
}

async function fetchJSON(url: string, timeoutMs = 15000): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function toCandles(raw: unknown): CandleData[] {
  const arr = raw as unknown[][];
  return arr.map((k) => ({
    time: k[0] as number,
    open: parseFloat(k[1] as string),
    high: parseFloat(k[2] as string),
    low: parseFloat(k[3] as string),
    close: parseFloat(k[4] as string),
    volume: parseFloat(k[5] as string),
  }));
}

/**
 * Walk-forward backtester. Replays historical klines through the SAME math
 * the live engine uses (votes, ATR SL, R:R TP, trailing, breakeven, partials,
 * fees, regime + HTF vetoes, cooldowns, circuit breaker).
 * AI layer is excluded (cannot be replayed) — noted in result.notes.
 */
export class BacktestService {
  private cancelled = false;

  cancel(): void {
    this.cancelled = true;
  }

  private async fetchKlines(symbol: string, interval: string, days: number): Promise<CandleData[]> {
    const out: CandleData[] = [];
    const endTime = Date.now();
    const startTime = endTime - days * 86400000;
    let curEnd = endTime;
    for (let page = 0; page < 400; page++) {
      const url =
        `https://testnet.binance.vision/api/v3/klines?symbol=${symbol.toUpperCase()}` +
        `&interval=${interval}&limit=1000&endTime=${curEnd}`;
      const raw = await fetchJSON(url);
      const batch = toCandles(raw);
      if (batch.length === 0) break;
      out.unshift(...batch);
      if (batch[0].time <= startTime || batch.length < 1000) break;
      curEnd = batch[0].time - 1;
      if (out.length > days * 2000) break; // safety
    }
    return out.filter((c) => c.time >= startTime);
  }

  private statsFor(trades: BacktestTrade[]): BacktestStats {
    const empty: BacktestStats = {
      total: 0, wins: 0, winRate: 0, totalPnL: 0, totalFees: 0,
      avgR: 0, profitFactor: 0, maxDrawdown: 0,
    };
    if (trades.length === 0) return empty;
    let grossP = 0, grossL = 0, sumR = 0, sumFees = 0;
    let peak = 0, running = 0, maxDD = 0;
    for (const t of trades) {
      if (t.pnl >= 0) grossP += t.pnl; else grossL += Math.abs(t.pnl);
      sumR += t.rMultiple;
      sumFees += t.fees;
      running += t.pnl;
      if (running > peak) peak = running;
      maxDD = Math.min(maxDD, running - peak);
    }
    const wins = trades.filter((t) => t.pnl >= 0).length;
    return {
      total: trades.length,
      wins,
      winRate: (wins / trades.length) * 100,
      totalPnL: trades.reduce((s, t) => s + t.pnl, 0),
      totalFees: sumFees,
      avgR: sumR / trades.length,
      profitFactor: grossL > 0 ? grossP / grossL : grossP > 0 ? Infinity : 0,
      maxDrawdown: maxDD,
    };
  }

  async run(
    params: BacktestParams,
    config: TradingConfig,
    onProgress: (phase: 'download' | 'run', percent: number, message: string) => void
  ): Promise<BacktestResult> {
    this.cancelled = false;
    const notes: string[] = [
      'AI katmanı backteste dahil değildir (tekrar oynatılamaz).',
      'Dolgu: sinyal mumu kapanışından; SL/TP aynı mumda tetiklenirse SL önce sayılır (muhafazakâr).',
    ];
    const symbols = params.symbols.map((s) => s.toUpperCase()).slice(0, 10);
    const days = Math.min(Math.max(params.days, 7), 180);
    const splitPct = Math.min(Math.max(params.splitPct || 70, 50), 90);
    const risk = new RiskManager(config);
    const startBalance = config.startBalance > 0 ? config.startBalance : 10000;

    // ── Download ──
    onProgress('download', 0, 'Mumlar indiriliyor…');
    const data = new Map<string, CandleData[]>();
    const htfData = new Map<string, CandleData[]>();
    let di = 0;
    for (const s of symbols) {
      if (this.cancelled) throw new Error('İptal edildi');
      data.set(s, await this.fetchKlines(s, params.timeframe, days));
      if (config.htfFilterEnabled) {
        htfData.set(s, await this.fetchKlines(s, config.htfTimeframe || '1h', days));
      }
      di++;
      onProgress('download', Math.round((di / symbols.length) * 100), `${s} indirildi`);
    }

    // Time grid: use the longest series as the spine
    let spine: CandleData[] = [];
    for (const arr of data.values()) {
      if (arr.length > spine.length) spine = arr;
    }
    if (spine.length < WARMUP + 10) {
      throw new Error('Yeterli mum verisi indirilemedi. Periyodu küçültüp tekrar deneyin.');
    }
    const splitTime = spine[0].time + ((spine[spine.length - 1].time - spine[0].time) * splitPct) / 100;

    // ── Walk ──
    let balance = startBalance;
    let realized = 0;
    let consecLosses = 0;
    const open: BTPosition[] = [];
    const trades: BacktestTrade[] = [];
    const equity: { t: number; balance: number }[] = [{ t: spine[WARMUP].time, balance }];
    const lastClose = new Map<string, { t: number; pnl: number }>();
    const htfPtr = new Map<string, number>();
    let dayKey = '';
    let dayStart = startBalance;
    let halted = false;

    const thresholdBase = config.minSignalStrength || 1;
    const effRisk = () => (config.adaptiveMode && consecLosses >= 2 ? config.riskPerTrade / 2 : config.riskPerTrade);

    const total = spine.length;
    for (let i = WARMUP; i < total; i++) {
      if (this.cancelled) throw new Error('İptal edildi');
      if (i % 200 === 0) {
        onProgress('run', Math.round((i / total) * 100), `İşleniyor… %${Math.round((i / total) * 100)}`);
      }
      const t = spine[i].time;
      const day = new Date(t).toISOString().slice(0, 10);
      if (day !== dayKey) {
        dayKey = day;
        dayStart = balance;
        halted = false;
      }

      for (const symbol of symbols) {
        const arr = data.get(symbol)!;
        // Align: find candle with time <= t (arrays share the grid; index map)
        const c = arr.length === total ? arr[i] : undefined;
        if (!c) continue; // symbol missing this slot (shorter history)
        const window = arr.slice(Math.max(0, i - WARMUP), i + 1);
        if (window.length < 50) continue;

        // 1) Manage open positions on this candle's range
        for (let pi = open.length - 1; pi >= 0; pi--) {
          const p = open[pi];
          if (p.symbol !== symbol) continue;
          const closeAt = (exitPrice: number, reason: string) => {
            const r = risk.computeClosePnl(p.entryPrice, exitPrice, p.quantity, p.side, config.commissionRate || 0, config.slippageBps || 0);
            const pnl = r.netPnl + p.partialPnl;
            const fees = r.commission + p.partialFees;
            balance += r.netPnl;
            realized += r.netPnl;
            if (pnl > 0) consecLosses = 0;
            else consecLosses++;
            lastClose.set(symbol, { t, pnl });
            const riskBase = p.initialRisk > 0 ? p.initialRisk : 1;
            trades.push({
              symbol, side: p.side, strategy: p.strategy,
              entryTime: p.entryTime, exitTime: t,
              entryPrice: p.entryPrice, exitPrice: r.fillPrice,
              quantity: p.quantity, pnl,
              rMultiple: pnl / riskBase, fees,
              exitReason: reason,
            });
            open.splice(pi, 1);
          };

          if (p.side === 'LONG') {
            if (c.low <= p.stopLoss) { closeAt(p.stopLoss, 'Stop loss'); continue; }
            if (c.high >= p.takeProfit) { closeAt(p.takeProfit, 'Take profit'); continue; }
            // partial at +partialR
            const pR = config.partialTPEnabled ? (config.partialTP_R ?? 1) : 0;
            if (pR > 0 && !p.partialDone && p.riskDistance > 0) {
              const trig = p.entryPrice + p.riskDistance * pR;
              if (c.high >= trig) {
                const q = p.quantity * 0.5;
                const r = risk.computeClosePnl(p.entryPrice, trig, q, p.side, config.commissionRate || 0, config.slippageBps || 0);
                p.quantity -= q;
                p.partialPnl += r.netPnl;
                p.partialFees += r.commission;
                p.partialDone = true;
                p.stopLoss = p.entryPrice;
                balance += r.netPnl;
                realized += r.netPnl;
              }
            }
            // trailing
            if (config.trailingStopEnabled && c.high > p.entryPrice) {
              const atrNow = TechnicalIndicators.calculateATR(
                window.map((x) => x.high), window.map((x) => x.low), window.map((x) => x.close)
              );
              const atr = atrNow[atrNow.length - 1] || 0;
              if (atr > 0) {
                const ns = c.high - atr * (config.trailingATRMultiplier || 1.5);
                if (ns > p.stopLoss) p.stopLoss = ns;
              }
            }
            // breakeven
            const beR = config.breakevenTriggerR || 0;
            if (beR > 0 && p.riskDistance > 0 && p.stopLoss < p.entryPrice) {
              if ((c.high - p.entryPrice) * p.quantity >= p.riskDistance * p.quantity * beR) {
                p.stopLoss = p.entryPrice;
              }
            }
          } else {
            if (c.high >= p.stopLoss) { closeAt(p.stopLoss, 'Stop loss'); continue; }
            if (c.low <= p.takeProfit) { closeAt(p.takeProfit, 'Take profit'); continue; }
            const pR = config.partialTPEnabled ? (config.partialTP_R ?? 1) : 0;
            if (pR > 0 && !p.partialDone && p.riskDistance > 0) {
              const trig = p.entryPrice - p.riskDistance * pR;
              if (c.low <= trig) {
                const q = p.quantity * 0.5;
                const r = risk.computeClosePnl(p.entryPrice, trig, q, p.side, config.commissionRate || 0, config.slippageBps || 0);
                p.quantity -= q;
                p.partialPnl += r.netPnl;
                p.partialFees += r.commission;
                p.partialDone = true;
                p.stopLoss = p.entryPrice;
                balance += r.netPnl;
                realized += r.netPnl;
              }
            }
            if (config.trailingStopEnabled && c.low < p.entryPrice) {
              const atrNow = TechnicalIndicators.calculateATR(
                window.map((x) => x.high), window.map((x) => x.low), window.map((x) => x.close)
              );
              const atr = atrNow[atrNow.length - 1] || 0;
              if (atr > 0) {
                const ns = c.low + atr * (config.trailingATRMultiplier || 1.5);
                if (ns < p.stopLoss) p.stopLoss = ns;
              }
            }
            const beR = config.breakevenTriggerR || 0;
            if (beR > 0 && p.riskDistance > 0 && p.stopLoss > p.entryPrice) {
              if ((p.entryPrice - c.low) * p.quantity >= p.riskDistance * p.quantity * beR) {
                p.stopLoss = p.entryPrice;
              }
            }
          }
          // max hold
          const maxHold = config.maxHoldMinutes || 0;
          if (maxHold > 0 && t - p.entryTime > maxHold * 60000) {
            closeAt(c.close, 'Max hold');
          }
        }

        // 2) Signals (indicators on closed window)
        const ind = TechnicalIndicators.calculateAllIndicators(window);
        const price = c.close;
        const { bullVotes, bearVotes } = computeVotes(config.strategies, price, window, ind);
        const atrPct = price > 0 ? ind.atr / price : 0;
        const threshold = config.adaptiveMode
          ? (atrPct > 0.015 ? Math.min(4, thresholdBase + 1) : thresholdBase)
          : thresholdBase;
        let sigSide: 'BUY' | 'SELL' | null = null;
        if (bullVotes >= threshold && bullVotes > bearVotes + 0.5) sigSide = 'BUY';
        else if (bearVotes >= threshold && bearVotes > bullVotes + 0.5) sigSide = 'SELL';

        // Mean-reversion path (mirrors live)
        let strategy = 'strategy';
        let tpRR = config.takeProfitRiskReward;
        if (!sigSide && (config.rangeTradingEnabled ?? true)) {
          const { analyzeStructure: _a, meanReversionSide: _m } = await import('./analysis/market-structure.js');
          void _a; void _m;
          const struct = (await import('./analysis/market-structure.js')).analyzeStructure(window);
          const mr = (await import('./analysis/market-structure.js')).meanReversionSide(
            struct, price, ind.atr, ind.rsi, ind.adx || 0, config.adxThreshold || 20
          );
          if (mr) {
            sigSide = mr;
            strategy = 'mean-reversion';
            tpRR = 1;
          }
        }
        if (!sigSide) continue;

        // Regime veto
        if (config.regimeFilterEnabled && (ind.adx || 0) < (config.adxThreshold || 20)) continue;
        // Structural veto (mirrors live; MR carries its own structural logic)
        {
          const sMode = config.structureFilterMode || 'off';
          if (sMode !== 'off' && strategy !== 'mean-reversion') {
            const st = analyzeStructure(window).trend;
            const sSide: 'LONG' | 'SHORT' = sigSide === 'BUY' ? 'LONG' : 'SHORT';
            const bad = sMode === 'veto-opposite'
              ? (sSide === 'LONG' && st === 'DOWNTREND') || (sSide === 'SHORT' && st === 'UPTREND')
              : (sSide === 'LONG' && st !== 'UPTREND') || (sSide === 'SHORT' && st !== 'DOWNTREND');
            if (bad) continue;
          }
        }
        // HTF veto
        if (config.htfFilterEnabled) {
          const htf = htfData.get(symbol) ?? [];
          let ptr = htfPtr.get(symbol) ?? 0;
          while (ptr < htf.length - 1 && htf[ptr + 1].time <= t) ptr++;
          htfPtr.set(symbol, ptr);
          if (ptr >= 24) {
            const closes = htf.slice(Math.max(0, ptr - 60), ptr + 1).map((x) => x.close);
            const f = TechnicalIndicators.calculateEMA(closes, 9);
            const s = TechnicalIndicators.calculateEMA(closes, 21);
            const fv = f[f.length - 1];
            const sv = s[s.length - 1];
            if (isFinite(fv) && isFinite(sv) && fv !== sv) {
              const up = fv > sv;
              if ((sigSide === 'BUY') !== up) continue;
            }
          }
        }
        // Gates: halt, max positions, duplicate, side, same-side, cooldown, margin, min-notional
        const dayPnlPct = (config.maxDailyLossPct || 0) > 0 && dayStart > 0
          ? (balance - dayStart) / dayStart : 0;
        if ((config.maxDailyLossPct || 0) > 0 && dayPnlPct <= -(config.maxDailyLossPct || 0)) continue;
        const openNow = open.filter((p) => true);
        if (openNow.length >= config.maxPositions) continue;
        if (openNow.some((p) => p.symbol === symbol)) continue;
        const side: 'LONG' | 'SHORT' = sigSide === 'BUY' ? 'LONG' : 'SHORT';
        if (config.tradingSide === 'long-only' && side === 'SHORT') continue;
        if (config.tradingSide === 'short-only' && side === 'LONG') continue;
        if (openNow.filter((p) => p.side === side).length >= (config.maxSameSide ?? 2)) continue;
        const cdMin = config.cooldownMinutes || 0;
        const lc = lastClose.get(symbol);
        if (cdMin > 0 && lc && (lc.pnl ?? 0) < 0 && (t - lc.t) / 60000 < cdMin) continue;

        const atr = ind.atr || price * 0.005;
        const sl = risk.calculateStopLoss(price, atr, side, config.stopLossATRMultiplier);
        const lev = Math.max(1, config.leverage);
        const effR = config.adaptiveMode && consecLosses >= 2 ? config.riskPerTrade / 2 : config.riskPerTrade;
        const metrics = risk.calculatePositionSize(balance, price, sl, lev, effR);
        const qty = metrics.positionSize / price;
        if (!(qty > 0) || !isFinite(qty)) continue;
        if ((config.minNotional ?? 0) > 0 && qty * price < (config.minNotional ?? 0)) continue;
        const expo = risk.checkExposure(balance, open.map((p) => p.margin), metrics.marginRequired);
        if (!expo.ok) continue;

        const tp = risk.calculateTakeProfit(price, sl, side, tpRR);
        open.push({
          symbol, side, entryPrice: price, quantity: qty,
          stopLoss: sl, takeProfit: tp,
          riskDistance: Math.abs(price - sl),
          initialRisk: Math.abs(price - sl) * qty,
          margin: (price * qty) / lev,
          entryTime: t, strategy, tpRR,
          partialDone: false, partialPnl: 0, partialFees: 0,
        });
      }

      if (i % 96 === 0) {
        equity.push({ t, balance });
      }
    }

    onProgress('run', 100, 'Tamamlandı');
    const inTrades = trades.filter((x) => x.entryTime < splitTime);
    const outTrades = trades.filter((x) => x.entryTime >= splitTime);
    return {
      params: { symbols, timeframe: params.timeframe, days, splitPct },
      inSample: this.statsFor(inTrades),
      outSample: this.statsFor(outTrades),
      equity,
      trades: trades.slice().reverse(),
      generatedAt: Date.now(),
      notes,
    };
  }
}

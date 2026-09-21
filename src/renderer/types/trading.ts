export interface APICredentials {
  exchange: 'binance' | 'bybit';
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
}

export interface TradingConfig {
  symbols: string[];
  timeframe: string;
  riskPerTrade: number;
  maxPositions: number;
  stopLossATRMultiplier: number;
  takeProfitRiskReward: number;
  useLimitOrders: boolean;
  leverage: number;
  strategies: {
    emaCross: boolean;
    macd: boolean;
    rsi: boolean;
    bollinger: boolean;
  };
  // ── Position management ──
  /** Required net signal votes (1..4). Higher = fewer but stronger trades. */
  minSignalStrength: number;
  /** Which directions the bot may open. */
  tradingSide: 'both' | 'long-only' | 'short-only';
  /** Minutes to wait before re-entering the same symbol after a close. 0 = off. */
  cooldownMinutes: number;
  /** Trail the stop behind price by ATR × multiplier. */
  trailingStopEnabled: boolean;
  trailingATRMultiplier: number;
  /** Move SL to entry once profit reaches N×R. 0 = off. */
  breakevenTriggerR: number;
  /** Force-close positions older than N minutes. 0 = off. */
  maxHoldMinutes: number;
  /** Let the engine auto-tune risk/strength from volatility + streaks. */
  adaptiveMode: boolean;
  /** Gemini AI layer: off | assist (opinion logged) | gate (can veto). */
  aiMode: 'off' | 'assist' | 'gate';
  /** Round-trip commission rate (e.g. 0.001 = 0.1%). Simulates real fees. */
  commissionRate: number;
  /** Market-order slippage in bps (100 bps = 1%). Worsens fills realistically. */
  slippageBps: number;
  /** Rest the bot when ADX shows a ranging (trendless) market. */
  regimeFilterEnabled: boolean;
  /** Minimum ADX to trade (below = ranging). Classic threshold: 20. */
  adxThreshold: number;
  /** Daily circuit breaker: halt new entries after losing N% in a day. 0 = off. */
  maxDailyLossPct: number;
  /** Require agreement with the higher-timeframe trend. */
  htfFilterEnabled: boolean;
  /** Higher timeframe for trend check (e.g. '1h'). */
  htfTimeframe: string;
}

export interface GeminiSettings {
  apiKey: string;
  model: string;
}

export interface AppPrefs {
  closeToTray: boolean;
  autoStart: boolean;
  /** "owner/repo" for GitHub Releases auto-update. Empty = disabled. */
  updateRepo: string;
  /** Last auto/manual update check (epoch ms). */
  lastUpdateCheck?: number;
}

export interface MarketData {
  symbol: string;
  price: number;
  bid: number;
  ask: number;
  volume24h: number;
  change24h: number;
  changePercent24h: number;
  high24h: number;
  low24h: number;
  timestamp: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  quantity: number;
  leverage: number;
  stopLoss: number;
  takeProfit: number;
  unrealizedPnL: number;
  realizedPnL: number;
  margin: number;
  liquidationPrice: number;
  createdAt: number;
  updatedAt: number;
  status: 'OPEN' | 'CLOSING' | 'CLOSED';
  strategy: string;
  /** Original risk distance (|entry − initial SL|) — for breakeven math. */
  riskDistance?: number;
  breakevenDone?: boolean;
}

export interface Order {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT';
  quantity: number;
  price?: number;
  stopPrice?: number;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'REJECTED' | 'EXPIRED';
  filledQuantity: number;
  avgFillPrice: number;
  createdAt: number;
  updatedAt: number;
  reduceOnly: boolean;
  positionSide?: 'LONG' | 'SHORT';
}

export interface PortfolioSummary {
  totalBalance: number;
  availableBalance: number;
  unrealizedPnL: number;
  realizedPnL: number;
  totalPnL: number;
  totalValue: number;
  positions: Position[];
  dailyChange: number;
  dailyChangePercent: number;
}

export interface BotStatus {
  isRunning: boolean;
  currentStrategy: string | null;
  activeSymbols: string[];
  uptime: number;
  totalTrades: number;
  winRate: number;
  totalPnL: number;
  lastSignal: {
    symbol: string;
    side: 'BUY' | 'SELL';
    price: number;
    indicators: IndicatorData;
    timestamp: number;
  } | null;
}

export interface IndicatorData {
  rsi: number;
  macd: {
    macd: number;
    signal: number;
    histogram: number;
  };
  ema: {
    fast: number;
    slow: number;
  };
  atr: number;
  bollinger: {
    upper: number;
    middle: number;
    lower: number;
  };
  volume: number;
  vwap: number;
  /** Average Directional Index — trend strength (0-100). */
  adx: number;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug' | 'success';
  context: string;
  message: string;
  meta?: any;
}

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SignalData {
  symbol: string;
  side: 'BUY' | 'SELL';
  price: number;
  strength: number;
  indicators: IndicatorData;
  reason: string;
  timestamp: number;
}

export interface RiskMetrics {
  positionSize: number;
  stopLoss: number;
  takeProfit: number;
  riskAmount: number;
  rewardAmount: number;
  riskRewardRatio: number;
  marginRequired: number;
}

export interface StrategyVotePart {
  key: string;
  label: string;
  bull: number;
  bear: number;
  note: string;
}

/** Live diagnostic snapshot of the bot's brain for one symbol. */
export interface StrategySnapshot {
  symbol: string;
  price: number;
  timestamp: number;
  bullVotes: number;
  bearVotes: number;
  threshold: number;
  parts: StrategyVotePart[];
  wouldSignal: 'BUY' | 'SELL' | null;
  blockedBy: string | null;
  cooldownSecLeft: number;
  openPositions: number;
  maxPositions: number;
  existingSide: string | null;
  indicators: IndicatorData;
  lastAnalysisAt: number;
  aiMode: string;
  adx: number;
  regime: 'TREND' | 'RANGE' | 'OFF';
  regimeBlocked: boolean;
  halted: boolean;
  htfTrend: 'UP' | 'DOWN' | null;
}
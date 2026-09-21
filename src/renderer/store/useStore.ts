import { create } from 'zustand';
import type {
  MarketData,
  Position,
  Order,
  PortfolioSummary,
  BotStatus,
  LogEntry,
  TradingConfig,
  IndicatorData,
} from '../types/trading';

export type ActiveView = 'terminal' | 'journal' | 'settings';

interface TerminalState {
  // selection
  selectedSymbol: string;
  setSelectedSymbol: (s: string) => void;
  timeframe: string;
  setTimeframe: (t: string) => void;
  activeView: ActiveView;
  setActiveView: (v: ActiveView) => void;

  // live data
  market: Record<string, MarketData>;
  upsertMarket: (m: MarketData) => void;
  positions: Position[];
  setPositions: (p: Position[]) => void;
  upsertPosition: (p: Position) => void;
  removePosition: (id: string) => void;
  orders: Order[];
  setOrders: (o: Order[]) => void;
  upsertOrder: (o: Order) => void;
  portfolio: PortfolioSummary;
  setPortfolio: (p: PortfolioSummary) => void;
  botStatus: BotStatus;
  setBotStatus: (b: BotStatus) => void;
  indicators: IndicatorData | null;
  setIndicators: (i: IndicatorData) => void;

  // logs
  logs: LogEntry[];
  pushLog: (l: LogEntry) => void;
  setLogs: (l: LogEntry[]) => void;
  clearLogs: () => void;

  // config
  tradingConfig: TradingConfig;
  setTradingConfig: (c: TradingConfig) => void;

  // updater
  updater: { phase: string; message: string; version?: string; percent?: number };
  setUpdater: (u: { phase: string; message: string; version?: string; percent?: number }) => void;

  // AI verdict (per selected symbol)
  aiVerdict: { bias: string; confidence: number; reason: string; model: string; timestamp: number } | null;
  setAiVerdict: (v: { bias: string; confidence: number; reason: string; model: string; timestamp: number } | null) => void;

  // Simulation mode (no exchange keys saved)
  simMode: boolean;
  setSimMode: (v: boolean) => void;
}

const defaultConfig: TradingConfig = {
  symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TRXUSDT'],
  timeframe: '5m',
  riskPerTrade: 0.02,
  maxPositions: 3,
  stopLossATRMultiplier: 2,
  takeProfitRiskReward: 2,
  useLimitOrders: false,
  leverage: 1,
  strategies: { emaCross: true, macd: true, rsi: true, bollinger: false },
  minSignalStrength: 1,
  tradingSide: 'both',
  cooldownMinutes: 5,
  trailingStopEnabled: true,
  trailingATRMultiplier: 1.5,
  breakevenTriggerR: 1,
  maxHoldMinutes: 0,
  adaptiveMode: true,
  aiMode: 'off',
  commissionRate: 0.001,
  slippageBps: 2,
  regimeFilterEnabled: true,
  adxThreshold: 20,
};

const defaultPortfolio: PortfolioSummary = {
  totalBalance: 10000,
  availableBalance: 10000,
  unrealizedPnL: 0,
  realizedPnL: 0,
  totalPnL: 0,
  totalValue: 10000,
  positions: [],
  dailyChange: 0,
  dailyChangePercent: 0,
};

export const useTerminal = create<TerminalState>((set) => ({
  selectedSymbol: 'BTCUSDT',
  setSelectedSymbol: (s) => set({ selectedSymbol: s }),
  timeframe: '5m',
  setTimeframe: (t) => set({ timeframe: t }),
  activeView: 'terminal',
  setActiveView: (v) => set({ activeView: v }),

  market: {},
  upsertMarket: (m) => set((st) => ({ market: { ...st.market, [m.symbol]: m } })),
  positions: [],
  setPositions: (p) => set({ positions: p }),
  upsertPosition: (p) =>
    set((st) => {
      if (p.status === 'CLOSED') {
        return { positions: st.positions.filter((x) => x.id !== p.id) };
      }
      const idx = st.positions.findIndex((x) => x.id === p.id);
      if (idx >= 0) {
        const next = [...st.positions];
        next[idx] = p;
        return { positions: next };
      }
      return { positions: [...st.positions, p] };
    }),
  removePosition: (id) => set((st) => ({ positions: st.positions.filter((x) => x.id !== id) })),
  orders: [],
  setOrders: (o) => set({ orders: o }),
  upsertOrder: (o) =>
    set((st) => {
      const idx = st.orders.findIndex((x) => x.id === o.id);
      if (idx >= 0) {
        const next = [...st.orders];
        next[idx] = o;
        return { orders: next };
      }
      return { orders: [o, ...st.orders].slice(0, 200) };
    }),
  portfolio: defaultPortfolio,
  setPortfolio: (p) => set({ portfolio: p }),
  botStatus: {
    isRunning: false,
    currentStrategy: null,
    activeSymbols: [],
    uptime: 0,
    totalTrades: 0,
    winRate: 0,
    totalPnL: 0,
    lastSignal: null,
  },
  setBotStatus: (b) => set({ botStatus: b }),
  indicators: null,
  setIndicators: (i) => set({ indicators: i }),

  logs: [],
  pushLog: (l) => set((st) => ({ logs: [...st.logs, l].slice(-500) })),
  setLogs: (l) => set({ logs: l }),
  clearLogs: () => set({ logs: [] }),

  tradingConfig: defaultConfig,
  setTradingConfig: (c) => set({ tradingConfig: c }),

  updater: { phase: 'idle', message: '' },
  setUpdater: (u) => set({ updater: u }),

  aiVerdict: null,
  setAiVerdict: (v) => set({ aiVerdict: v }),

  simMode: true,
  setSimMode: (v) => set({ simMode: v }),
}));

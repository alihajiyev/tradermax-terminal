import type {
  APICredentials,
  TradingConfig,
  Position,
  Order,
  MarketData,
  LogEntry,
  PortfolioSummary,
  BotStatus,
  IndicatorData,
  CandleData,
  StrategySnapshot,
} from './trading';

export interface JournalTrade {
  id: string; symbol: string; side: string;
  entryPrice: number; exitPrice: number; quantity: number;
  pnl: number; rMultiple: number;
  mfe: number; mfeR: number; mae: number; maeR: number;
  holdMinutes: number; entryReason: string; entryStrength: number;
  rsi: number; macdHist: number; atr: number;
  aiBias: string; aiConfidence: number;
  exitReason: string; openedAt: number; closedAt: number;
}

export interface JournalStats {
  total: number; wins: number; losses: number; winRate: number;
  totalPnL: number; avgR: number; profitFactor: number; expectancyR: number;
  best: number; worst: number; maxDrawdown: number; avgHoldMinutes: number;
  bySymbol: Record<string, { trades: number; wins: number; pnl: number; avgR: number }>;
}

export interface ElectronAPI {
  hasCredentials: () => Promise<boolean>;
  getCredentials: () => Promise<APICredentials | null>;
  saveCredentials: (c: APICredentials) => Promise<void>;
  deleteCredentials: () => Promise<void>;
  testConnection: (c: APICredentials) => Promise<{ success: boolean; message: string }>;
  getTradingConfig: () => Promise<TradingConfig>;
  saveTradingConfig: (c: TradingConfig) => Promise<void>;
  startBot: (c: TradingConfig) => Promise<{ success: boolean; message: string }>;
  stopBot: () => Promise<{ success: boolean; message: string }>;
  emergencyStop: () => Promise<{ success: boolean; message: string }>;
  getBotStatus: () => Promise<BotStatus>;
  subscribeMarketData: (s: string[]) => Promise<void>;
  unsubscribeMarketData: (s: string[]) => Promise<void>;
  getMarketData: (s: string) => Promise<MarketData | null>;
  getOrderBook: (s: string) => Promise<{ bids: [number, number][]; asks: [number, number][] } | null>;
  getRecentTrades: (s: string, limit: number) => Promise<{ price: number; quantity: number; time: number; side: 'buy' | 'sell' }[]>;
  getPositions: () => Promise<Position[]>;
  getOpenOrders: () => Promise<Order[]>;
  getOrderHistory: (limit: number) => Promise<Order[]>;
  placeOrder: (o: Omit<Order, 'id' | 'status' | 'createdAt'>) => Promise<{ success: boolean; orderId?: string; message: string }>;
  cancelOrder: (id: string) => Promise<{ success: boolean; message: string }>;
  closePosition: (positionId: string) => Promise<{ success: boolean; message: string }>;
  getAIVerdict: (s: string) => Promise<{ bias: string; confidence: number; reason: string; model: string; timestamp: number } | null>;
  getStrategyState: (s: string) => Promise<StrategySnapshot | null>;
  getJournal: (limit: number) => Promise<JournalTrade[]>;
  getJournalStats: () => Promise<JournalStats>;
  getJournalEquity: (limit: number) => Promise<{ t: number; balance: number; note: string }[]>;
  getJournalDir: () => Promise<string>;
  getGemini: () => Promise<{ configured: boolean; masked: string; model: string }>;
  saveGemini: (apiKey: string, model: string) => Promise<void>;
  deleteGemini: () => Promise<void>;
  testGemini: (apiKey: string, model: string) => Promise<{ success: boolean; message: string }>;
  importGemini: () => Promise<{ success: boolean; message: string; model?: string }>;
  getPrefs: () => Promise<{ closeToTray: boolean; autoStart: boolean; updateRepo: string }>;
  savePrefs: (p: { closeToTray: boolean; autoStart: boolean; updateRepo: string }) => Promise<void>;
  checkForUpdates: () => Promise<{ ok: boolean; message: string }>;
  installUpdate: () => Promise<void>;
  onUpdaterStatus: (cb: (s: { phase: string; message: string; version?: string; percent?: number }) => void) => () => void;
  getPortfolioSummary: () => Promise<PortfolioSummary>;
  getBalance: (a: string) => Promise<number>;
  getIndicators: (s: string, tf: string) => Promise<IndicatorData>;
  getCandleData: (s: string, tf: string, limit: number) => Promise<CandleData[]>;
  getLogs: (limit: number) => Promise<LogEntry[]>;
  clearLogs: () => Promise<void>;
  onLog: (cb: (l: LogEntry) => void) => () => void;
  onMarketDataUpdate: (cb: (m: MarketData) => void) => () => void;
  onPositionUpdate: (cb: (p: Position) => void) => () => void;
  onOrderUpdate: (cb: (o: Order) => void) => () => void;
  onBotStatusChange: (cb: (b: BotStatus) => void) => () => void;
  onPortfolioUpdate: (cb: (p: PortfolioSummary) => void) => () => void;
  getAppVersion: () => Promise<string>;
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;
  isMaximized: () => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

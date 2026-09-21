import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';
import type {
  APICredentials,
  TradingConfig,
  Position,
  Order,
  MarketData,
  LogEntry,
  PortfolioSummary,
  BotStatus,
  IndicatorData
} from '../renderer/types/trading.js';
interface ElectronAPI {
  // Settings & Credentials
  hasCredentials: () => Promise<boolean>;
  getCredentials: () => Promise<APICredentials | null>;
  saveCredentials: (credentials: APICredentials) => Promise<void>;
  deleteCredentials: () => Promise<void>;
  testConnection: (credentials: APICredentials) => Promise<{ success: boolean; message: string }>;
  
  // Trading Configuration
  getTradingConfig: () => Promise<TradingConfig>;
  saveTradingConfig: (config: TradingConfig) => Promise<void>;
  
  // Bot Control
  startBot: (config: TradingConfig) => Promise<{ success: boolean; message: string }>;
  stopBot: () => Promise<{ success: boolean; message: string }>;
  emergencyStop: () => Promise<{ success: boolean; message: string }>;
  getBotStatus: () => Promise<BotStatus>;
  
  // Market Data
  subscribeMarketData: (symbols: string[]) => Promise<void>;
  unsubscribeMarketData: (symbols: string[]) => Promise<void>;
  getMarketData: (symbol: string) => Promise<MarketData | null>;
  getOrderBook: (symbol: string) => Promise<{ bids: [number, number][]; asks: [number, number][] } | null>;
  getRecentTrades: (symbol: string, limit: number) => Promise<Array<{ price: number; quantity: number; time: number; side: 'buy' | 'sell' }>>;
  
  // Positions & Orders
  getPositions: () => Promise<Position[]>;
  getOpenOrders: () => Promise<Order[]>;
  getOrderHistory: (limit: number) => Promise<Order[]>;
  placeOrder: (order: Omit<Order, 'id' | 'status' | 'createdAt'>) => Promise<{ success: boolean; orderId?: string; message: string }>;
  cancelOrder: (orderId: string) => Promise<{ success: boolean; message: string }>;
  closePosition: (positionId: string) => Promise<{ success: boolean; message: string }>;
  getAIVerdict: (symbol: string) => Promise<{ bias: string; confidence: number; reason: string; model: string; timestamp: number } | null>;
  getStrategyState: (symbol: string) => Promise<import('../renderer/types/trading.js').StrategySnapshot | null>;
  
  // Portfolio
  getPortfolioSummary: () => Promise<PortfolioSummary>;
  getBalance: (asset: string) => Promise<number>;
  
  // Indicators & Analysis
  getIndicators: (symbol: string, timeframe: string) => Promise<IndicatorData>;
  getCandleData: (symbol: string, timeframe: string, limit: number) => Promise<Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }>>;
  
  // Logs
  getLogs: (limit: number) => Promise<LogEntry[]>;
  clearLogs: () => Promise<void>;
  onLog: (callback: (log: LogEntry) => void) => () => void;
  
  // Events
  onMarketDataUpdate: (callback: (data: MarketData) => void) => () => void;
  onPositionUpdate: (callback: (position: Position) => void) => () => void;
  onOrderUpdate: (callback: (order: Order) => void) => () => void;
  onBotStatusChange: (callback: (status: BotStatus) => void) => () => void;
  onPortfolioUpdate: (callback: (summary: PortfolioSummary) => void) => () => void;
  
  // Backtest
  runBacktest: (params: { symbols: string[]; timeframe: string; days: number; splitPct: number }) => Promise<{ ok: boolean; result?: import('../renderer/types/trading.js').BacktestResult; message?: string }>;
  cancelBacktest: () => Promise<{ ok: boolean }>;
  onBacktestProgress: (callback: (p: { phase: string; percent: number; message: string }) => void) => () => void;

  // Journal
  getPaper: () => Promise<Record<string, unknown> | null>;
  resetPaper: () => Promise<{ success: boolean; message: string }>;
  resetEverything: (startBalance: number) => Promise<{ success: boolean; message: string }>;
  getJournal: (limit: number) => Promise<Array<Record<string, unknown>>>;
  getJournalStats: () => Promise<Record<string, unknown>>;
  getJournalEquity: (limit: number) => Promise<Array<{ t: number; balance: number; note: string }>>;
  getJournalDir: () => Promise<string>;

  // Gemini
  getGemini: () => Promise<{ configured: boolean; masked: string; model: string }>;
  saveGemini: (apiKey: string, model: string) => Promise<void>;
  deleteGemini: () => Promise<void>;
  testGemini: (apiKey: string, model: string) => Promise<{ success: boolean; message: string }>;
  importGemini: () => Promise<{ success: boolean; message: string; model?: string }>;

  // App prefs
  getPrefs: () => Promise<{ closeToTray: boolean; autoStart: boolean; updateRepo: string }>;
  savePrefs: (prefs: { closeToTray: boolean; autoStart: boolean; updateRepo: string }) => Promise<void>;

  // Auto-update
  checkForUpdates: () => Promise<{ ok: boolean; message: string }>;
  installUpdate: () => Promise<void>;
  onUpdaterStatus: (callback: (s: { phase: string; message: string; version?: string; percent?: number }) => void) => () => void;

  // System
  getAppVersion: () => Promise<string>;
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
}

const electronAPI: ElectronAPI = {
  // Settings & Credentials
  hasCredentials: () => ipcRenderer.invoke('settings:has-credentials'),
  getCredentials: () => ipcRenderer.invoke('settings:get-credentials'),
  saveCredentials: (credentials) => ipcRenderer.invoke('settings:save-credentials', credentials),
  deleteCredentials: () => ipcRenderer.invoke('settings:delete-credentials'),
  testConnection: (credentials) => ipcRenderer.invoke('settings:test-connection', credentials),
  
  // Trading Configuration
  getTradingConfig: () => ipcRenderer.invoke('trading:get-config'),
  saveTradingConfig: (config) => ipcRenderer.invoke('trading:save-config', config),
  
  // Bot Control
  startBot: (config) => ipcRenderer.invoke('bot:start', config),
  stopBot: () => ipcRenderer.invoke('bot:stop'),
  emergencyStop: () => ipcRenderer.invoke('bot:emergency-stop'),
  getBotStatus: () => ipcRenderer.invoke('bot:get-status'),
  
  // Market Data
  subscribeMarketData: (symbols) => ipcRenderer.invoke('market:subscribe', symbols),
  unsubscribeMarketData: (symbols) => ipcRenderer.invoke('market:unsubscribe', symbols),
  getMarketData: (symbol) => ipcRenderer.invoke('market:get-data', symbol),
  getOrderBook: (symbol) => ipcRenderer.invoke('market:get-orderbook', symbol),
  getRecentTrades: (symbol, limit) => ipcRenderer.invoke('market:get-trades', symbol, limit),
  
  // Positions & Orders
  getPositions: () => ipcRenderer.invoke('trading:get-positions'),
  getOpenOrders: () => ipcRenderer.invoke('trading:get-open-orders'),
  getOrderHistory: (limit) => ipcRenderer.invoke('trading:get-order-history', limit),
  placeOrder: (order) => ipcRenderer.invoke('trading:place-order', order),
  cancelOrder: (orderId) => ipcRenderer.invoke('trading:cancel-order', orderId),
  closePosition: (positionId) => ipcRenderer.invoke('trading:close-position', positionId),
  getAIVerdict: (symbol) => ipcRenderer.invoke('ai:get-verdict', symbol),
  getStrategyState: (symbol) => ipcRenderer.invoke('strategy:get-state', symbol),
  
  // Portfolio
  getPortfolioSummary: () => ipcRenderer.invoke('portfolio:get-summary'),
  getBalance: (asset) => ipcRenderer.invoke('portfolio:get-balance', asset),
  
  // Indicators & Analysis
  getIndicators: (symbol, timeframe) => ipcRenderer.invoke('analysis:get-indicators', symbol, timeframe),
  getCandleData: (symbol, timeframe, limit) => ipcRenderer.invoke('analysis:get-candles', symbol, timeframe, limit),
  
  // Logs
  getLogs: (limit) => ipcRenderer.invoke('logs:get', limit),
  clearLogs: () => ipcRenderer.invoke('logs:clear'),
  onLog: (callback) => {
    const listener = (_event: IpcRendererEvent, log: LogEntry) => callback(log);
    ipcRenderer.on('log:new', listener);
    return () => ipcRenderer.off('log:new', listener);
  },
  
  // Events
  onMarketDataUpdate: (callback) => {
    const listener = (_event: IpcRendererEvent, data: MarketData) => callback(data);
    ipcRenderer.on('market:update', listener);
    return () => ipcRenderer.off('market:update', listener);
  },
  onPositionUpdate: (callback) => {
    const listener = (_event: IpcRendererEvent, position: Position) => callback(position);
    ipcRenderer.on('position:update', listener);
    return () => ipcRenderer.off('position:update', listener);
  },
  onOrderUpdate: (callback) => {
    const listener = (_event: IpcRendererEvent, order: Order) => callback(order);
    ipcRenderer.on('order:update', listener);
    return () => ipcRenderer.off('order:update', listener);
  },
  onBotStatusChange: (callback) => {
    const listener = (_event: IpcRendererEvent, status: BotStatus) => callback(status);
    ipcRenderer.on('bot:status-change', listener);
    return () => ipcRenderer.off('bot:status-change', listener);
  },
  onPortfolioUpdate: (callback) => {
    const listener = (_event: IpcRendererEvent, summary: PortfolioSummary) => callback(summary);
    ipcRenderer.on('portfolio:update', listener);
    return () => ipcRenderer.off('portfolio:update', listener);
  },
  
  // Backtest
  runBacktest: (params) => ipcRenderer.invoke('backtest:run', params),
  cancelBacktest: () => ipcRenderer.invoke('backtest:cancel'),
  onBacktestProgress: (callback) => {
    const listener = (_event: IpcRendererEvent, p: { phase: string; percent: number; message: string }) => callback(p);
    ipcRenderer.on('backtest:progress', listener);
    return () => ipcRenderer.off('backtest:progress', listener);
  },

  // Journal
  getPaper: () => ipcRenderer.invoke('paper:get'),
  resetPaper: () => ipcRenderer.invoke('paper:reset'),
  resetEverything: (startBalance) => ipcRenderer.invoke('paper:reset-full', startBalance),
  getJournal: (limit) => ipcRenderer.invoke('journal:get', limit),
  getJournalStats: () => ipcRenderer.invoke('journal:stats'),
  getJournalEquity: (limit) => ipcRenderer.invoke('journal:equity', limit),
  getJournalDir: () => ipcRenderer.invoke('journal:dir'),

  // Gemini
  getGemini: () => ipcRenderer.invoke('gemini:get'),
  saveGemini: (apiKey, model) => ipcRenderer.invoke('gemini:save', apiKey, model),
  deleteGemini: () => ipcRenderer.invoke('gemini:delete'),
  testGemini: (apiKey, model) => ipcRenderer.invoke('gemini:test', apiKey, model),
  importGemini: () => ipcRenderer.invoke('gemini:import'),

  // App prefs
  getPrefs: () => ipcRenderer.invoke('prefs:get'),
  savePrefs: (prefs) => ipcRenderer.invoke('prefs:save', prefs),

  // Auto-update
  checkForUpdates: () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdaterStatus: (callback) => {
    const listener = (_event: IpcRendererEvent, s: { phase: string; message: string; version?: string; percent?: number }) => callback(s);
    ipcRenderer.on('updater:status', listener);
    return () => ipcRenderer.off('updater:status', listener);
  },

  // System
  getAppVersion: () => ipcRenderer.invoke('system:get-version'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

// NOTE: window.electronAPI typing lives in src/renderer/types/electron.d.ts
// (preload tsconfig includes it, so no duplicate global declaration here).
export type { ElectronAPI };
import { ipcMain, IpcMainInvokeEvent, BrowserWindow } from 'electron';
import { TraderMaxApp } from '../main.js';
import { JournalService } from '../services/journal-service.js';
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
} from '../../renderer/types/trading.js';

export function setupSecureIPC(ipcMain: Electron.IpcMain, app: TraderMaxApp) {
  const logger = app.getLogger();
  const settingsService = app.getSettingsService();
  const journal = new JournalService();
  let activeBacktest: { cancel: () => void } | null = null;
  
  const validateEvent = (event: IpcMainInvokeEvent): boolean => {
    const sender = event.senderFrame;
    if (!sender) return false;
    return true;
  };

  // Settings & Credentials
  ipcMain.handle('settings:get-credentials', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return settingsService.getCredentials();
  });

  // Boolean only — secrets never cross into the renderer for this check
  ipcMain.handle('settings:has-credentials', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return settingsService.getCredentials() !== null;
  });

  ipcMain.handle('settings:save-credentials', async (event, credentials: APICredentials) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    await settingsService.saveCredentials(credentials);
    logger.info('API credentials saved');
  });

  ipcMain.handle('settings:delete-credentials', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    await settingsService.deleteCredentials();
    logger.info('API credentials deleted');
  });

  ipcMain.handle('settings:test-connection', async (event, credentials: APICredentials) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return settingsService.testConnection(credentials);
  });

  // Trading Configuration
  ipcMain.handle('trading:get-config', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return settingsService.getTradingConfig();
  });

  ipcMain.handle('trading:save-config', async (event, config: TradingConfig) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    await settingsService.saveTradingConfig(config);
    logger.info('Trading config saved');
  });

  // Bot Control
  ipcMain.handle('bot:start', async (event, config: TradingConfig) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine && engine.isRunning()) {
      return { success: false, message: 'Bot is already running' };
    }

    try {
      const { TradingEngine } = await import('../services/trading-engine.js');
      const tradingEngine = new TradingEngine(app, config);
      app.setTradingEngine(tradingEngine);
      await tradingEngine.start();
      return { success: true, message: 'Bot started successfully' };
    } catch (error) {
      logger.error('Failed to start bot:', error);
      return { success: false, message: `Failed to start bot: ${error}` };
    }
  });

  ipcMain.handle('bot:stop', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (!engine) {
      return { success: false, message: 'Bot is not running' };
    }

    try {
      await engine.stop();
      app.setTradingEngine(null);
      return { success: true, message: 'Bot stopped successfully' };
    } catch (error) {
      logger.error('Failed to stop bot:', error);
      return { success: false, message: `Failed to stop bot: ${error}` };
    }
  });

  ipcMain.handle('bot:emergency-stop', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (!engine) {
      return { success: false, message: 'Bot is not running' };
    }

    try {
      await engine.emergencyStop();
      return { success: true, message: 'Emergency stop executed - all positions closed' };
    } catch (error) {
      logger.error('Emergency stop failed:', error);
      return { success: false, message: `Emergency stop failed: ${error}` };
    }
  });

  ipcMain.handle('bot:get-status', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (!engine) {
      return { 
        isRunning: false, 
        currentStrategy: null,
        activeSymbols: [],
        uptime: 0,
        totalTrades: 0,
        winRate: 0,
        totalPnL: 0 
      };
    }

    return engine.getStatus();
  });

  // Market Data
  ipcMain.handle('market:subscribe', async (event, symbols: string[]) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      await engine.subscribeToSymbols(symbols);
    }
  });

  ipcMain.handle('market:unsubscribe', async (event, symbols: string[]) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      await engine.unsubscribeFromSymbols(symbols);
    }
  });

  ipcMain.handle('market:get-data', async (event, symbol: string) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getMarketData(symbol);
    }
    return null;
  });

  ipcMain.handle('market:get-orderbook', async (event, symbol: string) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getOrderBook(symbol);
    }
    return null;
  });

  ipcMain.handle('market:get-trades', async (event, symbol: string, limit: number) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getRecentTrades(symbol, limit);
    }
    return [];
  });

  // Positions & Orders
  ipcMain.handle('trading:get-positions', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getPositions();
    }
    return [];
  });

  ipcMain.handle('trading:get-open-orders', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getOpenOrders();
    }
    return [];
  });

  ipcMain.handle('trading:get-order-history', async (event, limit: number) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getOrderHistory(limit);
    }
    return [];
  });

  ipcMain.handle('trading:place-order', async (event, order: Omit<Order, 'id' | 'status' | 'createdAt'>) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.placeOrder(order);
    }
    return { success: false, message: 'Bot is not running' };
  });

  ipcMain.handle('trading:cancel-order', async (event, orderId: string) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.cancelOrder(orderId);
    }
    return { success: false, message: 'Bot is not running' };
  });

  ipcMain.handle('trading:close-position', async (event, positionId: string) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');

    const engine = app.getTradingEngine();
    if (engine) {
      return engine.closePositionById(positionId);
    }
    return { success: false, message: 'Bot is not running' };
  });

  ipcMain.handle('ai:get-verdict', async (event, symbol: string) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');

    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getAIVerdict(symbol);
    }
    return null;
  });

  ipcMain.handle('strategy:get-state', async (event, symbol: string) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');

    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getStrategySnapshot(symbol);
    }
    return null;
  });

  // Portfolio
  ipcMain.handle('portfolio:get-summary', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getPortfolioSummary();
    }
    return {
      totalBalance: 0,
      availableBalance: 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
      totalPnL: 0,
      totalValue: 0,
      positions: [],
      dailyChange: 0,
      dailyChangePercent: 0,
    };
  });

  ipcMain.handle('portfolio:get-balance', async (event, asset: string) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getBalance(asset);
    }
    return 0;
  });

  // Indicators & Analysis
  ipcMain.handle('analysis:get-indicators', async (event, symbol: string, timeframe: string) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getIndicators(symbol, timeframe);
    }
    return {
      rsi: 50,
      macd: { macd: 0, signal: 0, histogram: 0 },
      ema: { fast: 0, slow: 0 },
      atr: 0,
      bollinger: { upper: 0, middle: 0, lower: 0 },
      volume: 0,
    };
  });

  ipcMain.handle('analysis:get-candles', async (event, symbol: string, timeframe: string, limit: number) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.getCandleData(symbol, timeframe, limit);
    }
    return [];
  });

  // Logs
  ipcMain.handle('logs:get', async (event, limit: number) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return logger.getLogs(limit);
  });

  ipcMain.handle('logs:clear', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    logger.clearLogs();
  });

  // System
  ipcMain.handle('system:get-version', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return app.getAppVersion();
  });

  ipcMain.handle('window:minimize', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    const win = app.getMainWindow();
    if (win) win.minimize();
  });

  ipcMain.handle('window:maximize', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    const win = app.getMainWindow();
    if (win) {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
    }
  });

  ipcMain.handle('window:close', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    const win = app.getMainWindow();
    if (win) win.close();
  });

  ipcMain.handle('window:is-maximized', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    const win = app.getMainWindow();
    return win?.isMaximized() ?? false;
  });

  // Gemini settings (key never leaves main unencrypted; UI gets masked copy)
  ipcMain.handle('gemini:get', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return settingsService.getGeminiMasked();
  });

  ipcMain.handle('gemini:save', async (event, apiKey: string, model: string) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    await settingsService.saveGemini(apiKey, model);
    logger.info('Gemini settings saved');
  });

  ipcMain.handle('gemini:delete', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    await settingsService.deleteGemini();
    logger.info('Gemini settings deleted');
  });

  ipcMain.handle('gemini:test', async (event, apiKey: string, model: string) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    // Empty key → test with the saved (encrypted) key
    const key = apiKey || settingsService.getGemini()?.apiKey || '';
    if (!key) return { success: false, message: 'Test edilecek anahtar yok — önce girin veya kaydedin.' };
    return settingsService.testGemini(key, model);
  });

  ipcMain.handle('gemini:import', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return settingsService.importGeminiFromVideofolge();
  });

  // App prefs (tray, autostart, update repo)
  ipcMain.handle('prefs:get', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return settingsService.getPrefs();
  });

  ipcMain.handle('prefs:save', async (event, prefs: { closeToTray: boolean; autoStart: boolean; updateRepo: string; uiMode: 'full' | 'lite' }) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    await settingsService.savePrefs(prefs);
    app.applyPrefs();
    logger.info('App prefs saved');
  });

  // Trade journal (works even when the bot is stopped)
  ipcMain.handle('journal:get', async (event, limit: number) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return journal.getTrades(limit || 500);
  });

  ipcMain.handle('journal:stats', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return journal.getStats();
  });

  ipcMain.handle('journal:equity', async (event, limit: number) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return journal.getEquity(limit || 5000);
  });

  ipcMain.handle('journal:dir', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return journal.getDir();
  });

  // Backtest (walk-forward; one at a time)
  ipcMain.handle('backtest:run', async (event, params: { symbols: string[]; timeframe: string; days: number; splitPct: number }) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    if (activeBacktest) {
      return { ok: false as const, message: 'Zaten çalışan bir backtest var — bitmesini bekleyin veya durdurun.' };
    }
    const { BacktestService } = await import('../services/backtest-service.js');
    const bt = new BacktestService();
    activeBacktest = bt;
    const win = app.getMainWindow();
    try {
      const cfg = settingsService.getTradingConfig();
      const result = await bt.run(params, cfg, (phase, percent, message) => {
        win?.webContents.send('backtest:progress', { phase, percent, message });
      });
      win?.webContents.send('backtest:progress', { phase: 'done', percent: 100, message: 'Tamamlandı' });
      return { ok: true as const, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      win?.webContents.send('backtest:progress', { phase: 'error', percent: 0, message });
      return { ok: false as const, message };
    } finally {
      activeBacktest = null;
    }
  });

  ipcMain.handle('backtest:cancel', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    activeBacktest?.cancel();
    return { ok: true as const };
  });

  // Paper account (bot memory)
  ipcMain.handle('paper:get', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    return settingsService.getPaperState();
  });

  ipcMain.handle('paper:reset', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.resetPaperAccount();
    }
    settingsService.clearPaperState();
    return { success: true, message: 'Kayıtlı simülasyon hesabı temizlendi (sonraki başlatmada başlangıç bakiyesi). Journal korundu.' };
  });

  ipcMain.handle('paper:reset-full', async (event, startBalance: number) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    const engine = app.getTradingEngine();
    if (engine) {
      return engine.resetEverything(startBalance);
    }
    // Bot çalışmıyorken: kayıtlı config + paper + journal temizlenir
    const sb = startBalance > 0 ? startBalance : 100;
    const cfg = settingsService.getTradingConfig();
    await settingsService.saveTradingConfig({ ...cfg, startBalance: sb });
    settingsService.clearPaperState();
    journal.clearAll();
    return { success: true, message: `Her şey sıfırlandı — $${sb.toFixed(2)} ile fresh start! Botu başlatmayı unutma.` };
  });

  // Auto-update (GitHub Releases)
  ipcMain.handle('updater:check', async (event) => {
    if (!validateEvent(event)) throw new Error('Unauthorized');
    const updater = app.getUpdaterService();
    if (!updater) return { ok: false, message: 'Updater hazır değil.' };
    return updater.checkForUpdates();
  });

  ipcMain.handle('updater:install', async () => {
    const updater = app.getUpdaterService();
    updater?.quitAndInstall();
  });

  logger.info('Secure IPC handlers registered');
}
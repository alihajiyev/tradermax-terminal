import { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, nativeImage, Notification } from 'electron';
import { join } from 'path';
import { setupSecureIPC } from './ipc/secure-ipc.js';
import { TradingEngine } from './services/trading-engine.js';
import { SettingsService } from './services/settings-service.js';
import { UpdaterService } from './services/updater-service.js';
import { makeTrayIconPNG } from './utils/tray-icon.js';
import { Logger } from './utils/logger.js';

declare const __dirname: string;
const isDev = process.env.NODE_ENV === 'development' || !process.resourcesPath;

export class TraderMaxApp {
  private mainWindow: BrowserWindow | null = null;
  private tradingEngine: TradingEngine | null = null;
  private settingsService: SettingsService;
  private updaterService: UpdaterService | null = null;
  private tray: Tray | null = null;
  private logger: Logger;
  private quitting = false;

  constructor() {
    this.settingsService = new SettingsService();
    this.logger = new Logger('Main');
  }

  async initialize() {
    await this.settingsService.initialize();
    this.applyAutoStart();
    this.setupAppEvents();
    await this.createWindow();
    this.setupTray();
    this.setupIPC();
    this.updaterService = new UpdaterService(this);
  }

  private applyAutoStart() {
    try {
      const prefs = this.settingsService.getPrefs();
      app.setLoginItemSettings({ openAtLogin: prefs.autoStart });
    } catch (err) {
      this.logger.error('Failed to apply auto-start setting', err);
    }
  }

  applyPrefs() {
    this.applyAutoStart();
  }

  private setupAppEvents() {
    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        this.shutdown();
        app.quit();
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        this.createWindow();
      }
    });

    app.on('before-quit', () => {
      this.shutdown();
    });
  }

  private async createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1920,
      height: 1080,
      minWidth: 1400,
      minHeight: 900,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#0a0e17',
        symbolColor: '#00d4aa',
        height: 36,
      },
      backgroundColor: '#0a0e17',
      webPreferences: {
        preload: join(__dirname, '../preload/preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        experimentalFeatures: false,
      },
      icon: join(__dirname, '../../resources/icon.png'),
    });

    if (isDev) {
      await this.mainWindow.loadURL('http://localhost:5173');
      this.mainWindow.webContents.openDevTools({ mode: 'detach' });
    } else {
      await this.mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
    }

    this.mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: 'deny' };
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    // Close → tray (if enabled): bot keeps running in background
    this.mainWindow.on('close', (event) => {
      if (this.quitting) return;
      try {
        const prefs = this.settingsService.getPrefs();
        const botRunning = this.tradingEngine?.isRunning() ?? false;
        if (prefs.closeToTray && botRunning) {
          event.preventDefault();
          this.mainWindow?.hide();
          new Notification({
            title: 'TraderMax arka planda çalışıyor',
            body: 'Bot çalışmaya devam ediyor. Tepsi simgesinden geri açabilirsiniz.',
          }).show();
          this.logger.info('Window hidden to tray (bot keeps running)');
        }
      } catch (err) {
        this.logger.error('Close-to-tray failed', err);
      }
    });
  }

  private setupTray() {
    try {
      if (this.tray) return;
      const icon = nativeImage.createFromBuffer(makeTrayIconPNG());
      this.tray = new Tray(icon);
      this.tray.setToolTip('TraderMax Terminal');
      const rebuildMenu = () => {
        const running = this.tradingEngine?.isRunning() ?? false;
        this.tray?.setContextMenu(Menu.buildFromTemplate([
          { label: running ? '● Bot ÇALIŞIYOR' : '○ Bot duruyor', enabled: false },
          { type: 'separator' },
          {
            label: 'Terminali Aç', click: () => {
              this.mainWindow?.show();
              this.mainWindow?.focus();
            },
          },
          {
            label: 'KILL SWITCH (tümünü kapat)', click: () => {
              void this.tradingEngine?.emergencyStop().catch((e) => this.logger.error('Tray kill switch failed', e));
            },
          },
          { type: 'separator' },
          {
            label: 'Çıkış', click: () => {
              this.quitting = true;
              app.quit();
            },
          },
        ]));
      };
      rebuildMenu();
      setInterval(rebuildMenu, 5000).unref?.();
      this.tray.on('click', () => {
        this.mainWindow?.show();
        this.mainWindow?.focus();
      });
    } catch (err) {
      this.logger.error('Tray setup failed', err);
    }
  }

  private setupIPC() {
    setupSecureIPC(ipcMain, this);
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  getTradingEngine(): TradingEngine | null {
    return this.tradingEngine;
  }

  setTradingEngine(engine: TradingEngine | null) {
    this.tradingEngine = engine;
  }

  getAppVersion(): string {
    return app.getVersion();
  }

  getSettingsService(): SettingsService {
    return this.settingsService;
  }

  getUpdaterService(): UpdaterService | null {
    return this.updaterService;
  }

  getLogger(): Logger {
    return this.logger;
  }

  async shutdown() {
    if (this.tradingEngine) {
      await this.tradingEngine.stop();
      this.tradingEngine = null;
    }
    this.logger.info('Application shutdown complete');
  }
}

const traderMaxApp = new TraderMaxApp();

// Single instance: tray-hiding means "close" doesn't quit — a second launch
// must focus the running window instead of starting a duplicate bot.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = traderMaxApp.getMainWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    traderMaxApp.initialize().catch((error) => {
      console.error('Failed to initialize application:', error);
      app.quit();
    });
  });
}

export { traderMaxApp };
import Store from 'electron-store';
import CryptoJS from 'crypto-js';
import { join } from 'path';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { app } from 'electron';
import type { APICredentials, TradingConfig, AppPrefs, GeminiSettings } from '../../renderer/types/trading.js';
import { PaperStore, type PaperState } from './paper-store.js';
import { Logger } from '../utils/logger.js';

const ENCRYPTION_KEY = 'tradermax-terminal-encryption-key-2024';

interface StoredCredentials {
  encrypted: string;
  iv: string;
}

interface StoredData {
  credentials?: StoredCredentials;
  gemini?: StoredCredentials;
  tradingConfig?: TradingConfig;
  prefs?: AppPrefs;
  symbolsMigratedV10?: boolean;
  defaultsMigratedV141?: boolean;
  defaultsMigratedV170?: boolean;
  defaultsMigratedV220?: boolean;
  defaultsMigratedV410?: boolean;
}

/** Top-10 high-volume Binance pairs, all verified on testnet. */
export const DEFAULT_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TRXUSDT',
];
const LEGACY_SYMBOLS = ['BTCUSDT', 'ETHUSDT'];

export const DEFAULT_TRADING_CONFIG: TradingConfig = {
  symbols: [...DEFAULT_SYMBOLS],
  timeframe: '5m',
  riskPerTrade: 0.02,
  maxPositions: 3,
  stopLossATRMultiplier: 2.5,
  takeProfitRiskReward: 2,
  useLimitOrders: false,
  leverage: 1,
  strategies: {
    emaCross: true,
    macd: true,
    rsi: true,
    bollinger: false,
  },
  minSignalStrength: 1,
  tradingSide: 'both',
  cooldownMinutes: 3,
  trailingStopEnabled: true,
  trailingATRMultiplier: 2.5,
  breakevenTriggerR: 1,
  maxHoldMinutes: 0,
  adaptiveMode: true,
  aiMode: 'off',
  commissionRate: 0.001,
  slippageBps: 2,
  regimeFilterEnabled: true,
  adxThreshold: 20,
  maxDailyLossPct: 0.03,
  htfFilterEnabled: true,
  htfTimeframe: '15m',
  maxPositionPct: 0.12,
  maxTotalExposurePct: 0.5,
  startBalance: 10000,
  minNotional: 5,
  rangeTradingEnabled: true,
  structureFilterMode: 'veto-opposite',
  maxSameSide: 2,
  partialTPEnabled: true,
  partialTP_R: 1,
  liveTrading: false,
  useBnbDiscount: false,
  market: 'spot',
};

export const DEFAULT_UPDATE_REPO = 'alihajiyev/tradermax-terminal';

export const DEFAULT_PREFS: AppPrefs = {
  closeToTray: true,
  autoStart: false,
  updateRepo: DEFAULT_UPDATE_REPO,
  uiMode: 'full',
};

export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

export class SettingsService {
  private store: Store<StoredData>;
  private paper: PaperStore;
  private logger: Logger;

  constructor() {
    this.logger = new Logger('SettingsService');
    this.store = new Store<StoredData>({
      name: 'settings',
      encryptionKey: ENCRYPTION_KEY,
      cwd: join(app.getPath('userData'), 'tradermax'),
      defaults: {
        tradingConfig: DEFAULT_TRADING_CONFIG,
        prefs: DEFAULT_PREFS,
      },
    });
    this.paper = new PaperStore(app.getPath('userData'));
  }

  async initialize(): Promise<void> {
    // One-time migration: users stuck on the old 2-coin default get the top-10 list
    try {
      if (!this.store.get('symbolsMigratedV10')) {
        const stored = this.store.get('tradingConfig');
        const s = stored?.symbols ?? [];
        if (s.length === LEGACY_SYMBOLS.length && LEGACY_SYMBOLS.every((x, i) => s[i] === x)) {
          this.store.set('tradingConfig', { ...stored!, symbols: [...DEFAULT_SYMBOLS] });
          this.logger.info('Migrated default symbols to top-10 list');
        }
        this.store.set('symbolsMigratedV10', true);
      }
      // v1.4.1: old installs saved the legacy threshold 2; the tuned default is 1.
      // Only migrate untouched defaults (user-customized 3/4 are left alone).
      if (!this.store.get('defaultsMigratedV141')) {
        const storedCfg = this.store.get('tradingConfig');
        if (storedCfg && storedCfg.minSignalStrength === 2) {
          this.store.set('tradingConfig', { ...storedCfg, minSignalStrength: 1 });
          this.logger.info('Migrated minSignalStrength 2 → 1');
        }
        this.store.set('defaultsMigratedV141', true);
      }
      // v1.7.0: cooldown is now loss-aware; shrink untouched legacy 5 → 3.
      if (!this.store.get('defaultsMigratedV170')) {
        const storedCfg = this.store.get('tradingConfig');
        if (storedCfg && storedCfg.cooldownMinutes === 5) {
          this.store.set('tradingConfig', { ...storedCfg, cooldownMinutes: 3 });
          this.logger.info('Migrated cooldownMinutes 5 → 3');
        }
        this.store.set('defaultsMigratedV170', true);
      }
      // v2.2.0 (data-driven): HTF 1h lagged so badly it vetoed 4370 SELLs into
      // a -5% bleed → 15m; trailing 1.5x capped winners at ~1R → 2.5x.
      // Only untouched defaults migrate; user-customized values are left alone.
      if (!this.store.get('defaultsMigratedV220')) {
        const storedCfg = this.store.get('tradingConfig');
        if (storedCfg) {
          const next = { ...storedCfg };
          let changed = false;
          if (next.htfTimeframe === '1h') { next.htfTimeframe = '15m'; changed = true; }
          if (next.trailingATRMultiplier === 1.5) { next.trailingATRMultiplier = 2.5; changed = true; }
          if (changed) {
            this.store.set('tradingConfig', next);
            this.logger.info('Migrated HTF 1h→15m, trailing 1.5→2.5');
          }
        }
        this.store.set('defaultsMigratedV220', true);
      }
      // v4.1.0 (micro-account discipline): single-trade cap 25%→12%,
      // total exposure 75%→50%, ATR stop 2→2.5x (backtest: OUT avgR improved
      // monotonically -0.66→-0.49→-0.41). Only untouched defaults migrate.
      if (!this.store.get('defaultsMigratedV410')) {
        const storedCfg = this.store.get('tradingConfig');
        if (storedCfg) {
          const next = { ...storedCfg };
          let changed = false;
          if (next.maxPositionPct === 0.25) { next.maxPositionPct = 0.12; changed = true; }
          if (next.maxTotalExposurePct === 0.75) { next.maxTotalExposurePct = 0.5; changed = true; }
          if (next.stopLossATRMultiplier === 2) { next.stopLossATRMultiplier = 2.5; changed = true; }
          if (changed) {
            this.store.set('tradingConfig', next);
            this.logger.info('Migrated caps 25/75→12/50, SL 2→2.5x ATR');
          }
        }
        this.store.set('defaultsMigratedV410', true);
      }
    } catch (err) {
      this.logger.error('Symbol migration failed', err);
    }
    this.logger.info('Settings service initialized');
  }

  // ── Generic AES helpers ────────────────────────────────────
  private encryptJSON(value: unknown): StoredCredentials {
    const iv = CryptoJS.lib.WordArray.random(16);
    const encrypted = CryptoJS.AES.encrypt(JSON.stringify(value), ENCRYPTION_KEY, { iv }).toString();
    return { encrypted, iv: iv.toString(CryptoJS.enc.Hex) };
  }

  private decryptJSON<T>(stored: StoredCredentials | undefined): T | null {
    if (!stored) return null;
    try {
      const bytes = CryptoJS.AES.decrypt(stored.encrypted, ENCRYPTION_KEY, {
        iv: CryptoJS.enc.Hex.parse(stored.iv),
      });
      return JSON.parse(bytes.toString(CryptoJS.enc.Utf8)) as T;
    } catch (error) {
      this.logger.error('Failed to decrypt stored secret:', error);
      return null;
    }
  }

  // ── Exchange credentials ───────────────────────────────────
  getCredentials(): APICredentials | null {
    return this.decryptJSON<APICredentials>(this.store.get('credentials'));
  }

  async saveCredentials(credentials: APICredentials): Promise<void> {
    try {
      this.store.set('credentials', this.encryptJSON(credentials));
    } catch (error) {
      this.logger.error('Failed to encrypt credentials:', error);
      throw new Error('Failed to save credentials');
    }
  }

  async deleteCredentials(): Promise<void> {
    this.store.delete('credentials');
  }

  async testConnection(credentials: APICredentials): Promise<{ success: boolean; message: string }> {
    try {
      const { ExchangeAPI } = await import('./exchange-api.js');
      const api = new ExchangeAPI(credentials);
      const result = await api.testConnection();
      return result;
    } catch (error) {
      return { success: false, message: `Connection test failed: ${error}` };
    }
  }

  // ── Trading config (merged with defaults for forward-compat) ──
  getTradingConfig(): TradingConfig {
    const stored = this.store.get('tradingConfig');
    return {
      ...DEFAULT_TRADING_CONFIG,
      ...stored,
      strategies: { ...DEFAULT_TRADING_CONFIG.strategies, ...stored?.strategies },
    };
  }

  async saveTradingConfig(config: TradingConfig): Promise<void> {
    this.store.set('tradingConfig', config);
  }

  // ── Gemini settings ────────────────────────────────────────
  getGemini(): GeminiSettings | null {
    return this.decryptJSON<GeminiSettings>(this.store.get('gemini'));
  }

  /** Masked copy for the UI (never sends the full key to the renderer). */
  getGeminiMasked(): { configured: boolean; masked: string; model: string } {
    const g = this.getGemini();
    if (!g) return { configured: false, masked: '', model: DEFAULT_GEMINI_MODEL };
    const k = g.apiKey;
    const masked = k.length > 8 ? `${k.slice(0, 4)}…${k.slice(-4)}` : '••••';
    return { configured: true, masked, model: g.model || DEFAULT_GEMINI_MODEL };
  }

  async saveGemini(apiKey: string, model: string): Promise<void> {
    this.store.set('gemini', this.encryptJSON({ apiKey, model } satisfies GeminiSettings));
  }

  async deleteGemini(): Promise<void> {
    this.store.delete('gemini');
  }

  async testGemini(apiKey: string, model: string): Promise<{ success: boolean; message: string }> {
    try {
      const { AIAnalyst } = await import('./ai-analyst.js');
      return await new AIAnalyst().testKey(apiKey, model);
    } catch (error) {
      return { success: false, message: `Gemini test failed: ${error}` };
    }
  }

  /**
   * One-click import: scans ~/Desktop/videofolge for a Gemini API key
   * (AIza… – 39 chars) in .txt/.json/.env/.md files.
   */
  async importGeminiFromVideofolge(): Promise<{ success: boolean; message: string; model?: string }> {
    try {
      const dir = join(app.getPath('desktop'), 'videofolge');
      if (!existsSync(dir)) {
        return { success: false, message: 'Masaüstünde "videofolge" klasörü bulunamadı.' };
      }
      const files = readdirSync(dir).filter((f) => /\.(txt|json|env|md|js|ts)$/i.test(f));
      const keyRe = /AIza[0-9A-Za-z\-_]{35}/;
      const modelRe = /gemini-[0-9a-z.\-]+/i;
      let foundKey: string | null = null;
      let foundModel: string | null = null;
      for (const file of files.slice(0, 50)) {
        try {
          const content = readFileSync(join(dir, file), 'utf8');
          const km = content.match(keyRe);
          if (km && !foundKey) foundKey = km[0];
          const mm = content.match(modelRe);
          if (mm && !foundModel) foundModel = mm[0];
          if (foundKey && foundModel) break;
        } catch { /* skip unreadable files */ }
      }
      if (!foundKey) {
        return { success: false, message: `"videofolge" içinde API anahtarı (AIza…) bulunamadı (${files.length} dosya tarandı).` };
      }
      await this.saveGemini(foundKey, foundModel ?? DEFAULT_GEMINI_MODEL);
      return {
        success: true,
        message: `Gemini anahtarı şifreli olarak içe aktarıldı (••••${foundKey.slice(-4)}).`,
        model: foundModel ?? DEFAULT_GEMINI_MODEL,
      };
    } catch (error) {
      return { success: false, message: `İçe aktarma hatası: ${String(error)}` };
    }
  }

  // ── App prefs ──────────────────────────────────────────────
  getPrefs(): AppPrefs {
    const stored = this.store.get('prefs');
    return {
      ...DEFAULT_PREFS,
      ...stored,
      // Empty = never configured → fall back to the baked-in repo
      updateRepo: stored?.updateRepo?.trim() || DEFAULT_UPDATE_REPO,
    };
  }

  async savePrefs(prefs: AppPrefs): Promise<void> {
    this.store.set('prefs', prefs);
  }

  resetToDefaults(): void {
    this.store.clear();
  }

  // ── Paper account persistence (bot memory) ─────────────────
  getPaperState(): PaperState | null {
    return this.paper.load();
  }

  savePaperState(state: PaperState): void {
    try {
      this.paper.save(state);
    } catch (error) {
      this.logger.error('Failed to save paper state:', error);
    }
  }

  clearPaperState(): void {
    try {
      this.paper.clear();
    } catch (error) {
      this.logger.error('Failed to clear paper state:', error);
    }
  }
}

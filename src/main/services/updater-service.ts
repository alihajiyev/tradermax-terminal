import { autoUpdater } from 'electron-updater';
import type { TraderMaxApp } from '../main.js';
import { Logger } from '../utils/logger.js';

export type UpdaterPhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'not-available'
  | 'error';

export interface UpdaterStatus {
  phase: UpdaterPhase;
  message: string;
  version?: string;
  percent?: number;
}

/**
 * GitHub Releases tabanlı otomatik güncelleme.
 * Repo Ayarlar → Güncellemeler bölümünden "owner/repo" olarak verilir.
 */
export class UpdaterService {
  private app: TraderMaxApp;
  private logger: Logger;
  private configuredRepo = '';

  constructor(app: TraderMaxApp) {
    this.app = app;
    this.logger = new Logger('Updater');
    autoUpdater.autoDownload = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    autoUpdater.logger = {
      info: (msg: unknown) => this.logger.info(String(msg)),
      warn: (msg: unknown) => this.logger.warn(String(msg)),
      error: (msg: unknown) => this.logger.error(String(msg)),
      debug: (msg: unknown) => this.logger.debug(String(msg)),
    } as any;

    autoUpdater.on('checking-for-update', () => {
      this.send({ phase: 'checking', message: 'Güncellemeler denetleniyor…' });
    });
    autoUpdater.on('update-available', (info) => {
      this.logger.info(`Update available: ${info.version}`);
      this.send({ phase: 'available', message: `Yeni sürüm bulundu: v${info.version} — indiriliyor…`, version: info.version });
      void autoUpdater.downloadUpdate().catch((err) => {
        this.send({ phase: 'error', message: `İndirme hatası: ${String(err)}` });
      });
    });
    autoUpdater.on('update-not-available', (info) => {
      this.send({ phase: 'not-available', message: `Zaten güncel sürümdesiniz (v${info.version}).`, version: info.version });
    });
    autoUpdater.on('download-progress', (p) => {
      this.send({ phase: 'downloading', message: `İndiriliyor… %${Math.round(p.percent)}`, percent: Math.round(p.percent) });
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.send({ phase: 'downloaded', message: `v${info.version} hazır — "Kur ve Yeniden Başlat"a basın.`, version: info.version });
    });
    autoUpdater.on('error', (err) => {
      this.logger.error('AutoUpdater error', err);
      this.send({ phase: 'error', message: `Güncelleme hatası: ${err?.message ?? String(err)}` });
    });
  }

  /** Returns false if repo string is invalid. */
  configure(repo: string): boolean {
    const m = repo.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
    if (!m) {
      this.configuredRepo = '';
      return false;
    }
    this.configuredRepo = `${m[1]}/${m[2]}`;
    autoUpdater.setFeedURL({ provider: 'github', owner: m[1], repo: m[2] });
    this.logger.info(`Update feed configured: ${this.configuredRepo}`);
    return true;
  }

  async checkForUpdates(): Promise<{ ok: boolean; message: string }> {
    const prefs = this.app.getSettingsService().getPrefs();
    const repo = (prefs.updateRepo || '').trim();
    if (!repo) {
      const msg = 'Önce Ayarlar → Güncellemeler bölümüne GitHub repo adresini yazın (örn: kullaniciadi/tradermax).';
      this.send({ phase: 'error', message: msg });
      return { ok: false, message: msg };
    }
    if (repo !== this.configuredRepo && !this.configure(repo)) {
      const msg = 'Repo formatı hatalı. "owner/repo" biçiminde yazın.';
      this.send({ phase: 'error', message: msg });
      return { ok: false, message: msg };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true, message: 'Denetim başlatıldı.' };
    } catch (err) {
      const msg = `Denetim başarısız: ${String(err)}`;
      this.send({ phase: 'error', message: msg });
      return { ok: false, message: msg };
    }
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall(false, true);
  }

  private send(status: UpdaterStatus): void {
    this.app.getMainWindow()?.webContents.send('updater:status', status);
  }
}

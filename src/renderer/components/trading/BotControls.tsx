import { useState } from 'react';
import { Play, Square, OctagonX, Loader2 } from 'lucide-react';
import { useTerminal } from '../../store/useStore';

export function BotControls({ compact = false }: { compact?: boolean }) {
  const { botStatus, tradingConfig, setBotStatus } = useTerminal();
  const [busy, setBusy] = useState<'start' | 'stop' | 'kill' | null>(null);
  const running = botStatus.isRunning;

  const handle = async (action: 'start' | 'stop' | 'kill') => {
    const api = window.electronAPI;
    if (!api) return;
    setBusy(action);
    try {
      if (action === 'start') {
        const cfg = useTerminal.getState().tradingConfig;
        if (cfg.liveTrading) {
          const ok = confirm('⛔ SON UYARI: Bot GERÇEK PARAYLA çalışacak ve Binance hesabınıza gerçek emirler gönderecek. Başlatılsın mı?');
          if (!ok) { setBusy(null); return; }
        }
        await api.saveTradingConfig(cfg);
        const res = await api.startBot(cfg);
        if (!res.success) alert(res.message);
      } else if (action === 'stop') {
        await api.stopBot();
      } else {
        if (!confirm('ACİL DURUM: Tüm pozisyonlar kapatılsın mı?')) { setBusy(null); return; }
        await api.emergencyStop();
      }
      const status = await api.getBotStatus();
      setBotStatus(status);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(null);
    }
  };

  const btn = 'w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded text-xs font-bold transition disabled:opacity-50';
  void tradingConfig;

  return (
    <div className={`space-y-1.5 ${compact ? '' : 'panel p-3'}`}>
      {!compact && <div className="text-xs font-bold uppercase tracking-wider text-terminal-textMuted mb-2">Bot Kontrolü</div>}
      {!running ? (
        <button className={`${btn} bg-terminal-accent text-black hover:bg-terminal-accentHover`} disabled={busy !== null} onClick={() => handle('start')}>
          {busy === 'start' ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          Botu Başlat
        </button>
      ) : (
        <>
          <button className={`${btn} bg-terminal-bgTertiary border border-terminal-border text-terminal-text hover:border-terminal-borderHover`} disabled={busy !== null} onClick={() => handle('stop')}>
            {busy === 'stop' ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
            Botu Durdur
          </button>
          <button className={`${btn} bg-terminal-danger text-white hover:bg-terminal-dangerHover`} disabled={busy !== null} onClick={() => handle('kill')}>
            {busy === 'kill' ? <Loader2 size={14} className="animate-spin" /> : <OctagonX size={14} />}
            KILL SWITCH
          </button>
        </>
      )}
    </div>
  );
}

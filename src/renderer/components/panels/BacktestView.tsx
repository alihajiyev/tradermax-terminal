import { useEffect, useState } from 'react';
import { Play, Square, FlaskConical } from 'lucide-react';
import { useTerminal } from '../../store/useStore';
import { Card, EquityCurve } from './JournalView';
import type { BacktestResult, BacktestStats } from '../../types/trading';

function StatGrid({ stats, title }: { stats: BacktestStats; title: string }) {
  return (
    <div>
      <div className="text-[11px] font-bold uppercase tracking-wider text-terminal-textMuted mb-1">{title}</div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Card label="PnL" value={`${stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toFixed(2)}`} sub={`${stats.total} işlem · komisyon -${stats.totalFees.toFixed(2)}`} accent={stats.totalPnL >= 0 ? 'up' : 'down'} />
        <Card label="Win Rate" value={`%${stats.winRate.toFixed(1)}`} sub={`${stats.wins}W`} />
        <Card label="Ort. R" value={`${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R`} accent={stats.avgR >= 0 ? 'up' : 'down'} />
        <Card label="Profit Factor" value={isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'} sub={`DD ${stats.maxDrawdown.toFixed(0)}`} />
      </div>
    </div>
  );
}

export function BacktestView() {
  const { tradingConfig } = useTerminal();
  const [timeframe, setTimeframe] = useState('5m');
  const [days, setDays] = useState(30);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; percent: number; message: string } | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    const off = api.onBacktestProgress((p) => {
      setProgress(p);
      if (p.phase === 'done' || p.phase === 'error') setRunning(false);
    });
    return off;
  }, []);

  const run = async () => {
    const api = window.electronAPI;
    if (!api || running) return;
    setRunning(true);
    setError(null);
    setResult(null);
    setProgress({ phase: 'download', percent: 0, message: 'Başlıyor…' });
    try {
      const res = await api.runBacktest({ symbols: tradingConfig.symbols, timeframe, days, splitPct: 70 });
      if (!res.ok) {
        setError(res.message ?? 'Backtest başarısız');
        setRunning(false);
        return;
      }
      setResult(res.result ?? null);
    } catch (e) {
      setError(String(e));
      setRunning(false);
    }
  };

  const cancel = async () => {
    await window.electronAPI?.cancelBacktest();
  };

  const out = result?.outSample;
  const passed = out && out.total >= 10 && out.profitFactor > 1.2 && out.avgR > 0;

  return (
    <div className="space-y-3">
      <div className="panel p-3">
        <div className="flex items-center gap-2 flex-wrap">
          <FlaskConical size={14} className="text-terminal-accent" />
          <span className="text-xs font-bold">Zaman makinesi — mevcut ayarlarla geçmişte test et</span>
          <div className="flex gap-1 ml-1">
            {(['5m', '15m', '1h'] as const).map((t) => (
              <button key={t} onClick={() => setTimeframe(t)} disabled={running}
                className={`px-2 py-0.5 rounded text-[11px] font-mono ${timeframe === t ? 'bg-terminal-accent text-black font-bold' : 'text-terminal-textMuted hover:bg-white/10'}`}>
                {t}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {([14, 30, 60, 90] as const).map((d) => (
              <button key={d} onClick={() => setDays(d)} disabled={running}
                className={`px-2 py-0.5 rounded text-[11px] font-mono ${days === d ? 'bg-terminal-accent text-black font-bold' : 'text-terminal-textMuted hover:bg-white/10'}`}>
                {d}g
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            {!running ? (
              <button className="btn-accent !text-xs !py-1" onClick={run}>
                <Play size={13} /> Başlat ({tradingConfig.symbols.length} sembol)
              </button>
            ) : (
              <button className="btn-danger !text-xs !py-1" onClick={cancel}>
                <Square size={13} /> Durdur
              </button>
            )}
          </div>
        </div>
        {progress && running && (
          <div className="mt-2">
            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div className="h-full bg-terminal-accent transition-all" style={{ width: `${progress.percent}%` }} />
            </div>
            <div className="text-[11px] font-mono text-terminal-textMuted mt-1">{progress.message}</div>
          </div>
        )}
        {error && <div className="mt-2 text-xs font-mono text-terminal-danger">{error}</div>}
        <p className="mt-2 text-[11px] text-terminal-textDim">
          İlk %70 ayar içindir, son %30'a hiç dokunulmaz — hüküm sadece <b>OUT-SAMPLE</b>'a göre verilir.
          Geçer: ≥10 işlem, PF&gt;1.2, ort. R&gt;0.
        </p>
      </div>

      {result && out && (
        <>
          <div className={`panel p-3 text-sm font-bold ${passed ? 'text-terminal-accent' : 'text-terminal-warning'}`}>
            {passed
              ? `✅ OUT-SAMPLE GEÇTİ — bu ayar geçmişte çalışmış (PF ${out.profitFactor.toFixed(2)}, ${out.avgR.toFixed(2)}R). Canlıda da şansı var, yine de küçük başla.`
              : `⚠️ OUT-SAMPLE KALDI — bu ayar geçmişte para kazandırmamış (PF ${isFinite(out.profitFactor) ? out.profitFactor.toFixed(2) : '∞'}, ${out.avgR.toFixed(2)}R). Ayıp değil, veri bu — ayarı değiştirip tekrar dene.`}
          </div>
          <StatGrid stats={result.inSample} title={`IN-SAMPLE (ilk %${result.params.splitPct})`} />
          <StatGrid stats={out} title="OUT-SAMPLE (son %30 — hüküm burada)" />
          <div className="panel">
            <div className="panel-header"><span>Backtest Equity</span></div>
            <div className="p-2"><EquityCurve points={result.equity} /></div>
          </div>
          <div className="panel">
            <div className="panel-header"><span>İşlemler ({result.trades.length})</span></div>
            <div className="overflow-auto max-h-72">
              <table className="w-full text-left">
                <thead className="sticky top-0 bg-terminal-bgTertiary text-[10px] uppercase tracking-wider text-terminal-textMuted">
                  <tr>
                    <th className="grid-cell">Zaman</th>
                    <th className="grid-cell">Sembol</th>
                    <th className="grid-cell">Yön</th>
                    <th className="grid-cell text-right">PnL</th>
                    <th className="grid-cell text-right">R</th>
                    <th className="grid-cell">Çıkış</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.slice(0, 150).map((t, i) => (
                    <tr key={i} className="border-t border-terminal-border/60 hover:bg-terminal-bgTertiary/40">
                      <td className="grid-cell text-terminal-textMuted">{new Date(t.exitTime).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                      <td className="grid-cell font-bold">{t.symbol}</td>
                      <td className={`grid-cell font-bold ${t.side === 'LONG' ? 'text-terminal-accent' : 'text-terminal-danger'}`}>{t.side}</td>
                      <td className={`grid-cell text-right font-bold ${t.pnl >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}`}>{t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}</td>
                      <td className="grid-cell text-right">{t.rMultiple.toFixed(2)}</td>
                      <td className="grid-cell text-terminal-textMuted">{t.exitReason} · {t.strategy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="panel p-3 text-[11px] text-terminal-textMuted">
            <div className="font-bold mb-1">Notlar</div>
            <ul className="list-disc ml-4 space-y-0.5">
              {result.notes.map((n, i) => <li key={i}>{n}</li>)}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}

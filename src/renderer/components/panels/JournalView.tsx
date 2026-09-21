import { useCallback, useEffect, useState } from 'react';
import { RefreshCw, Download, Trophy, Target, FlaskConical } from 'lucide-react';
import type { JournalTrade, JournalStats } from '../../types/electron';
import { BacktestView } from './BacktestView';

export function Card({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: 'up' | 'down' }) {
  return (
    <div className="panel p-3">
      <div className="text-[10px] uppercase tracking-wider text-terminal-textDim font-bold">{label}</div>
      <div className={`text-xl font-bold font-mono tnum ${accent === 'up' ? 'text-terminal-accent' : accent === 'down' ? 'text-terminal-danger' : 'text-terminal-text'}`}>
        {value}
      </div>
      {sub && <div className="text-[11px] text-terminal-textMuted font-mono">{sub}</div>}
    </div>
  );
}

export function EquityCurve({ points }: { points: { t: number; balance: number }[] }) {
  if (points.length < 2) return <div className="text-xs text-terminal-textDim p-3">Equity verisi henüz yok — ilk kapanan işlemde oluşur.</div>;
  const W = 640;
  const H = 120;
  const min = Math.min(...points.map((p) => p.balance));
  const max = Math.max(...points.map((p) => p.balance));
  const span = max - min || 1;
  const xy = points.map((p, i) => [
    (i / (points.length - 1)) * (W - 8) + 4,
    H - 8 - ((p.balance - min) / span) * (H - 24),
  ]);
  const d = xy.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const up = points[points.length - 1].balance >= points[0].balance;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28">
      <path d={d} fill="none" stroke={up ? '#00d4aa' : '#ff4444'} strokeWidth="2" />
      <path d={`${d} L${W - 4},${H} L4,${H} Z`} fill={up ? 'rgba(0,212,170,0.12)' : 'rgba(255,68,68,0.12)'} stroke="none" />
    </svg>
  );
}

export function JournalView() {
  const [tab, setTab] = useState<'live' | 'backtest'>('live');
  const [stats, setStats] = useState<JournalStats | null>(null);
  const [trades, setTrades] = useState<JournalTrade[]>([]);
  const [equity, setEquity] = useState<{ t: number; balance: number; note: string }[]>([]);
  const [dir, setDir] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const api = window.electronAPI;
    if (!api) return;
    setLoading(true);
    try {
      const [s, t, e, d] = await Promise.all([
        api.getJournalStats(),
        api.getJournal(200),
        api.getJournalEquity(2000),
        api.getJournalDir(),
      ]);
      setStats(s); setTrades(t); setEquity(e); setDir(d);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const exportCSV = () => {
    const header = 'id,symbol,side,entry,exit,qty,pnl,fees,R,mfeR,maeR,holdMin,strength,rsi,macdHist,atr,aiBias,aiConf,exitReason,openedAt,closedAt';
    const rows = trades.map((t) => [
      t.id, t.symbol, t.side, t.entryPrice, t.exitPrice, t.quantity,
      t.pnl.toFixed(2), (t.fees ?? 0).toFixed(2), t.rMultiple.toFixed(2), t.mfeR.toFixed(2), t.maeR.toFixed(2),
      t.holdMinutes.toFixed(1), t.entryStrength, t.rsi.toFixed(1), t.macdHist.toFixed(4),
      t.atr.toFixed(2), t.aiBias, t.aiConfidence.toFixed(2),
      `"${t.exitReason.replace(/"/g, "'")}"`,
      new Date(t.openedAt).toISOString(), new Date(t.closedAt).toISOString(),
    ].join(','));
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `tradermax-journal-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="flex-1 overflow-y-auto p-3">
      <div className="max-w-5xl mx-auto space-y-3 pb-6">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold flex items-center gap-1.5">
            <Trophy size={15} className="text-terminal-warning" /> İşlem Günlüğü — kazanan formül avı
          </h2>
          <div className="flex gap-1 ml-2">
            {(['live', 'backtest'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold flex items-center gap-1 transition ${
                  tab === t
                    ? 'bg-terminal-accentDim text-terminal-accent border border-terminal-accent/40'
                    : 'text-terminal-textMuted border border-transparent hover:bg-white/5'
                }`}
              >
                {t === 'backtest' && <FlaskConical size={12} />}
                {t === 'live' ? 'Canlı' : 'Backtest'}
              </button>
            ))}
          </div>
          <div className="ml-auto flex gap-2">
            <button className="btn-ghost !text-xs" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Yenile
            </button>
            <button className="btn-ghost !text-xs" onClick={exportCSV} disabled={trades.length === 0}>
              <Download size={13} /> CSV İndir
            </button>
          </div>
        </div>

        {tab === 'backtest' ? (
          <BacktestView />
        ) : (
          <>
        <p className="text-xs text-terminal-textMuted">
          Her açılan/kapanan işlem diske yazılır (<span className="font-mono">{dir || '…'}</span>).
          1 hafta sonunda buradaki <b>R-multiple</b>, <b>MFE/MAE</b> ve <b>sembol kırılımları</b> hangi ayarın para kazandırdığını gösterir.
        </p>

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <Card label="Toplam PnL (net)" value={`${stats.totalPnL >= 0 ? '+' : ''}${stats.totalPnL.toFixed(2)}`} sub={`${stats.total} işlem · komisyon -${(stats.totalFees ?? 0).toFixed(2)}`} accent={stats.totalPnL >= 0 ? 'up' : 'down'} />
            <Card label="Win Rate" value={`%${stats.winRate.toFixed(1)}`} sub={`${stats.wins}W / ${stats.losses}L`} />
            <Card label="Ort. R" value={`${stats.avgR >= 0 ? '+' : ''}${stats.avgR.toFixed(2)}R`} sub={`beklenti ${stats.expectancyR.toFixed(2)}R`} accent={stats.avgR >= 0 ? 'up' : 'down'} />
            <Card label="Profit Factor" value={isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞'} sub="hedef > 1.2" />
            <Card label="Max Drawdown" value={stats.maxDrawdown.toFixed(0)} sub="kasanın gördüğü en derin çukur — canlıya geçmeden izle" accent={stats.maxDrawdown < -500 ? 'down' : undefined} />
            <Card label="En İyi / En Kötü" value={`${stats.best.toFixed(0)} / ${stats.worst.toFixed(0)}`} />
            <Card label="Ort. Taşıma" value={`${stats.avgHoldMinutes.toFixed(0)} dk`} />
            <div className="panel p-3 col-span-2">
              <div className="text-[10px] uppercase tracking-wider text-terminal-textDim font-bold mb-1">Sembol Kırılımı</div>
              {Object.keys(stats.bySymbol).length === 0 && <div className="text-xs text-terminal-textDim">henüz yok</div>}
              {Object.entries(stats.bySymbol).map(([s, v]) => (
                <div key={s} className="flex justify-between text-xs font-mono tnum py-0.5">
                  <span className="font-bold">{s}</span>
                  <span>{v.trades} işlem · %{v.trades ? ((v.wins / v.trades) * 100).toFixed(0) : 0} · <b className={v.pnl >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}>{v.pnl >= 0 ? '+' : ''}{v.pnl.toFixed(1)}</b> · {v.avgR.toFixed(2)}R</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panel-header"><span className="flex items-center gap-1.5"><Target size={12} /> Equity Eğrisi</span></div>
          <div className="p-2"><EquityCurve points={equity} /></div>
        </div>

        <div className="panel">
          <div className="panel-header"><span>Kapalı İşlemler ({trades.length})</span></div>
          <div className="overflow-auto max-h-80">
            <table className="w-full text-left">
              <thead className="sticky top-0 bg-terminal-bgTertiary text-[10px] uppercase tracking-wider text-terminal-textMuted">
                <tr>
                  <th className="grid-cell">Zaman</th>
                  <th className="grid-cell">Sembol</th>
                  <th className="grid-cell">Yön</th>
                  <th className="grid-cell text-right">PnL</th>
                  <th className="grid-cell text-right">R</th>
                  <th className="grid-cell text-right">MFE/MAE (R)</th>
                  <th className="grid-cell text-right">Süre</th>
                  <th className="grid-cell">Çıkış</th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-t border-terminal-border/60 hover:bg-terminal-bgTertiary/40" title={`${t.entryReason} | RSI ${t.rsi.toFixed(1)} | AI ${t.aiBias}`}>
                    <td className="grid-cell text-terminal-textMuted">{new Date(t.closedAt).toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</td>
                    <td className="grid-cell font-bold">{t.symbol}</td>
                    <td className={`grid-cell font-bold ${t.side === 'LONG' ? 'text-terminal-accent' : 'text-terminal-danger'}`}>{t.side}</td>
                    <td className={`grid-cell text-right font-bold ${t.pnl >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}`}>{t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}</td>
                    <td className="grid-cell text-right">{t.rMultiple.toFixed(2)}</td>
                    <td className="grid-cell text-right text-terminal-textMuted">{t.mfeR.toFixed(1)} / {t.maeR.toFixed(1)}</td>
                    <td className="grid-cell text-right">{t.holdMinutes.toFixed(0)}dk</td>
                    <td className="grid-cell text-terminal-textMuted truncate max-w-40">{t.exitReason}</td>
                  </tr>
                ))}
                {trades.length === 0 && (
                  <tr><td colSpan={8} className="grid-cell text-center text-terminal-textDim py-4">Henüz kapalı işlem yok — bot çalışınca burada birikir.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
          </>
        )}
      </div>
    </div>
  );
}

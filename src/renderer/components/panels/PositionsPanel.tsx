import { useState } from 'react';
import { X } from 'lucide-react';
import { useTerminal } from '../../store/useStore';

function fmtUSD(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return `$${(n / 1000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export function PositionsPanel() {
  const { positions, market } = useTerminal();
  const [closing, setClosing] = useState<string | null>(null);

  const closePosition = async (id: string, symbol: string) => {
    if (!confirm(`${symbol} pozisyonu market fiyatından kapatılsın mı?`)) return;
    setClosing(id);
    try {
      const res = await window.electronAPI?.closePosition(id);
      if (!res?.success) alert(res?.message ?? 'Kapatma başarısız');
    } finally {
      setClosing(null);
    }
  };

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Açık Pozisyonlar ({positions.length})</span>
      </div>
      <div className="flex-1 overflow-auto min-h-0">
        {positions.length === 0 ? (
          <div className="p-3 text-xs text-terminal-textDim">Açık pozisyon yok.</div>
        ) : (
          <table className="w-full text-left">
            <thead className="sticky top-0 bg-terminal-bgTertiary text-[10px] uppercase tracking-wider text-terminal-textMuted">
              <tr>
                <th className="grid-cell">Sembol</th>
                <th className="grid-cell">Yön</th>
                <th className="grid-cell text-right">Giriş</th>
                <th className="grid-cell text-right">Mark</th>
                <th className="grid-cell text-right">Boyut</th>
                <th className="grid-cell text-right">SL / TP</th>
                <th className="grid-cell text-right">uPnL</th>
                <th className="grid-cell text-right">İşlem</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const mark = market[p.symbol]?.price ?? p.entryPrice;
                const pnl = p.side === 'LONG' ? (mark - p.entryPrice) * p.quantity : (p.entryPrice - mark) * p.quantity;
                const long = p.side === 'LONG';
                const asset = p.symbol.replace(/USDT$/, '');
                const notional = p.quantity * p.entryPrice;
                const riskDist = p.riskDistance ?? Math.abs(p.entryPrice - p.stopLoss);
                const riskUsd = riskDist * p.quantity;
                return (
                  <tr key={p.id} className="border-t border-terminal-border/60 hover:bg-terminal-bgTertiary/40">
                    <td className="grid-cell font-bold">{p.symbol}</td>
                    <td className={`grid-cell font-bold ${long ? 'text-terminal-accent' : 'text-terminal-danger'}`}>{p.side}</td>
                    <td className="grid-cell text-right">{p.entryPrice.toFixed(2)}</td>
                    <td className="grid-cell text-right">{mark.toFixed(2)}</td>
                    <td className="grid-cell text-right" title={`Margin: ${fmtUSD(p.margin)} · Riske atılan: ${fmtUSD(riskUsd)}`}>
                      <div className="font-bold">{p.quantity.toFixed(p.quantity < 1 ? 5 : 3)} {asset}</div>
                      <div className="text-terminal-textMuted">{fmtUSD(notional)} · risk {fmtUSD(riskUsd)}</div>
                    </td>
                    <td className="grid-cell text-right text-terminal-textMuted">
                      {p.stopLoss.toFixed(1)} / {p.takeProfit.toFixed(1)}
                    </td>
                    <td className={`grid-cell text-right font-bold ${pnl >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}`}>
                      {pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}
                    </td>
                    <td className="grid-cell text-right">
                      <button
                        title="Pozisyonu kapat"
                        disabled={closing === p.id}
                        onClick={() => closePosition(p.id, p.symbol)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-bold bg-terminal-danger/15 text-terminal-danger border border-terminal-danger/30 hover:bg-terminal-danger hover:text-white transition disabled:opacity-40"
                      >
                        <X size={11} /> {closing === p.id ? '…' : 'Kapat'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { useTerminal } from '../../store/useStore';

export function OrderBookPanel() {
  const { selectedSymbol } = useTerminal();
  const [book, setBook] = useState<{ bids: [number, number][]; asks: [number, number][] } | null>(null);

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let alive = true;
    const load = async () => {
      try {
        const ob = await api.getOrderBook(selectedSymbol);
        if (alive && ob) setBook(ob);
      } catch { /* ignore */ }
    };
    load();
    const t = setInterval(load, 3000);
    return () => { alive = false; clearInterval(t); };
  }, [selectedSymbol]);

  const maxAsk = Math.max(...(book?.asks.slice(0, 12).map((a) => a[1]) ?? [0]));
  const maxBid = Math.max(...(book?.bids.slice(0, 12).map((b) => b[1]) ?? [0]));

  const Row = ({ price, qty, max, side }: { price: number; qty: number; max: number; side: 'ask' | 'bid' }) => (
    <div className="relative grid grid-cols-2 px-2 py-[2px] font-mono text-[11px] tnum">
      <div
        className={`absolute inset-y-0 right-0 ${side === 'ask' ? 'bg-terminal-danger/15' : 'bg-terminal-accent/15'}`}
        style={{ width: `${max > 0 ? (qty / max) * 100 : 0}%` }}
      />
      <span className={`relative ${side === 'ask' ? 'text-terminal-danger' : 'text-terminal-accent'}`}>{price.toFixed(2)}</span>
      <span className="relative text-right text-terminal-text">{qty.toFixed(4)}</span>
    </div>
  );

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header"><span>Emir Defteri · {selectedSymbol}</span></div>
      <div className="flex-1 overflow-y-auto min-h-0 py-1">
        <div className="px-2 text-[10px] uppercase text-terminal-textDim font-bold">Asks</div>
        {book?.asks.slice(0, 12).reverse().map(([p, q], i) => <Row key={`a${i}`} price={p} qty={q} max={maxAsk} side="ask" />) ?? <div className="p-2 text-xs text-terminal-textDim">Yükleniyor…</div>}
        <div className="px-2 text-[10px] uppercase text-terminal-textDim font-bold mt-1">Bids</div>
        {book?.bids.slice(0, 12).map(([p, q], i) => <Row key={`b${i}`} price={p} qty={q} max={maxBid} side="bid" />)}
      </div>
    </div>
  );
}

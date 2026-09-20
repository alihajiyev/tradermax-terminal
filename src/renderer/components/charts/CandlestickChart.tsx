import { useEffect, useRef, useState } from 'react';
import type { CandleData } from '../../types/trading';
import { useTerminal } from '../../store/useStore';

const TFs = ['1m', '5m', '15m', '1h', '4h'];

export function CandlestickChart() {
  const { selectedSymbol, timeframe, setTimeframe, market, indicators } = useTerminal();
  const [candles, setCandles] = useState<CandleData[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef<{ x: number; y: number } | null>(null);

  // Fetch candles
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let alive = true;
    const load = async () => {
      try {
        const data = await api.getCandleData(selectedSymbol, timeframe, 120);
        if (alive && data?.length) setCandles(data);
      } catch { /* ignore */ }
    };
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [selectedSymbol, timeframe]);

  // Append live price into last candle visually
  const livePrice = market[selectedSymbol]?.price;
  const view: CandleData[] = (() => {
    if (!candles.length) return candles;
    if (!livePrice) return candles;
    const next = [...candles];
    const last = { ...next[next.length - 1] };
    last.close = livePrice;
    last.high = Math.max(last.high, livePrice);
    last.low = Math.min(last.low, livePrice);
    next[next.length - 1] = last;
    return next;
  })();

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const W = wrap.clientWidth;
    const H = wrap.clientHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);

    // bg grid
    ctx.fillStyle = '#0f141f';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#1e293b';
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.6;
    for (let i = 1; i < 6; i++) {
      const y = (H / 6) * i;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    for (let i = 1; i < 8; i++) {
      const x = (W / 8) * i;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    if (view.length < 2) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px Inter';
      ctx.fillText('Mum verisi bekleniyor...', 16, 24);
      return;
    }

    const padR = 64; // price axis
    const padB = 22; // time axis + volume
    const volH = Math.round(H * 0.14);
    const plotW = W - padR;
    const plotH = H - padB - volH - 8;

    let min = Infinity, max = -Infinity, maxVol = 0;
    for (const c of view) {
      min = Math.min(min, c.low);
      max = Math.max(max, c.high);
      maxVol = Math.max(maxVol, c.volume);
    }
    const span = max - min || 1;
    min -= span * 0.08;
    max += span * 0.08;

    const x = (i: number) => (i + 0.5) * (plotW / view.length);
    const y = (p: number) => 8 + (1 - (p - min) / (max - min)) * plotH;
    const cw = Math.max(2, (plotW / view.length) * 0.62);

    // volume bars
    view.forEach((c, i) => {
      const up = c.close >= c.open;
      ctx.fillStyle = up ? 'rgba(0,212,170,0.28)' : 'rgba(255,68,68,0.28)';
      const vh = maxVol > 0 ? (c.volume / maxVol) * volH : 0;
      ctx.fillRect(x(i) - cw / 2, H - padB - vh, cw, vh);
    });

    // candles
    view.forEach((c, i) => {
      const up = c.close >= c.open;
      const col = up ? '#00d4aa' : '#ff4444';
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(i), y(c.high));
      ctx.lineTo(x(i), y(c.low));
      ctx.stroke();
      const bTop = y(Math.max(c.open, c.close));
      const bBot = y(Math.min(c.open, c.close));
      ctx.fillRect(x(i) - cw / 2, bTop, cw, Math.max(1, bBot - bTop));
    });

    // EMA9 / EMA21 overlay
    const ema = (period: number) => {
      const k = 2 / (period + 1);
      let e = view[0].close;
      return view.map((c) => { e = c.close * k + e * (1 - k); return e; });
    };
    const drawLine = (vals: number[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      vals.forEach((v, i) => { const px = x(i), py = y(v); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
      ctx.stroke();
    };
    drawLine(ema(9), '#ffaa00');
    drawLine(ema(21), '#00aaff');

    // Last price line
    const lp = view[view.length - 1].close;
    const up = lp >= view[view.length - 1].open;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = up ? '#00d4aa' : '#ff4444';
    ctx.beginPath(); ctx.moveTo(0, y(lp)); ctx.lineTo(plotW, y(lp)); ctx.stroke();
    ctx.setLineDash([]);

    // Price axis labels
    ctx.fillStyle = '#0f141f';
    ctx.fillRect(plotW, 0, padR, H);
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono"';
    for (let i = 0; i <= 6; i++) {
      const p = min + ((max - min) / 6) * i;
      ctx.fillText(p.toFixed(p > 1000 ? 0 : 2), plotW + 6, H - padB - ((H - padB - 8) / 6) * i - 2);
    }
    // last price tag
    ctx.fillStyle = up ? '#00d4aa' : '#ff4444';
    const tagY = Math.min(Math.max(y(lp) - 8, 0), H - 20);
    ctx.fillRect(plotW, tagY, padR, 16);
    ctx.fillStyle = '#000';
    ctx.font = 'bold 10px "JetBrains Mono"';
    ctx.fillText(lp.toFixed(2), plotW + 6, tagY + 11);

    // Time labels
    ctx.fillStyle = '#64748b';
    ctx.font = '10px "JetBrains Mono"';
    const step = Math.ceil(view.length / 6);
    view.forEach((c, i) => {
      if (i % step === 0) {
        const d = new Date(c.time);
        ctx.fillText(`${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`, x(i) - 12, H - 6);
      }
    });

    // Crosshair
    const mpos = mouseRef.current;
    if (mpos && mpos.x < plotW) {
      ctx.strokeStyle = 'rgba(226,232,240,0.35)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(mpos.x, 0); ctx.lineTo(mpos.x, H - padB); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, mpos.y); ctx.lineTo(plotW, mpos.y); ctx.stroke();
      ctx.setLineDash([]);
    }
  });

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <div className="flex items-center gap-2 normal-case">
          <span className="text-terminal-text font-bold">{selectedSymbol}</span>
          <span className="text-terminal-accent font-mono tnum">
            {livePrice ? `$${livePrice.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : ''}
          </span>
          {indicators && (
            <span className="hidden xl:inline text-[10px] font-mono text-terminal-textDim">
              RSI {indicators.rsi.toFixed(1)} · MACD {indicators.macd.histogram.toFixed(3)} · ATR {indicators.atr.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <span className="flex items-center gap-1 text-[10px] mr-2">
            <span className="w-2 h-0.5 bg-[#ffaa00] inline-block" /> EMA9
            <span className="w-2 h-0.5 bg-[#00aaff] inline-block ml-1" /> EMA21
          </span>
          {TFs.map((t) => (
            <button
              key={t}
              onClick={() => setTimeframe(t)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono ${timeframe === t ? 'bg-terminal-accent text-black font-bold' : 'text-terminal-textMuted hover:text-terminal-text hover:bg-terminal-bgTertiary'}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div ref={wrapRef} className="relative flex-1 min-h-0">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 cursor-crosshair"
          onMouseMove={(e) => {
            const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
            mouseRef.current = { x: e.clientX - r.left, y: e.clientY - r.top };
          }}
          onMouseLeave={() => { mouseRef.current = null; }}
        />
      </div>
    </div>
  );
}

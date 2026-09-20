import { useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Crosshair } from 'lucide-react';
import type { CandleData } from '../../types/trading';
import { useTerminal } from '../../store/useStore';
import {
  defaultViewport,
  zoomViewport,
  panViewport,
  followLive,
  isAtLiveEdge,
  visibleRange,
  type Viewport,
} from './chart-viewport';

const TFs = ['1m', '5m', '15m', '1h', '4h'] as const;
const DEFAULT_COUNT = 60;

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  let e = values[0] ?? 0;
  return values.map((v) => (e = v * k + e * (1 - k)));
}

/** Nice axis step: 1 / 2 / 2.5 / 5 × 10ⁿ */
function niceStep(range: number, targetTicks: number): number {
  if (!(range > 0)) return 1;
  const raw = range / targetTicks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : 1;
  return step * mag;
}

interface HoverCandle {
  x: number;
  y: number;
  index: number; // index into full candle array
}

export function CandlestickChart() {
  const { selectedSymbol, timeframe, setTimeframe, market, indicators } = useTerminal();
  const [candles, setCandles] = useState<CandleData[]>([]);
  const [vp, setVp] = useState<Viewport>({ endIndex: 0, count: DEFAULT_COUNT });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<HoverCandle | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const prevLenRef = useRef(0);
  const vpRef = useRef(vp);
  vpRef.current = vp;
  const dragRef = useRef<{ startX: number; startEnd: number; moved: boolean } | null>(null);

  // Reset viewport on symbol/TF change
  useEffect(() => {
    setVp({ endIndex: 0, count: DEFAULT_COUNT });
    prevLenRef.current = 0;
    setCandles([]);
  }, [selectedSymbol, timeframe]);

  // Fetch candles
  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let alive = true;
    const load = async () => {
      try {
        const data = await api.getCandleData(selectedSymbol, timeframe, 200);
        if (alive && data?.length) setCandles(data);
      } catch { /* ignore */ }
    };
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [selectedSymbol, timeframe]);

  // Follow live edge as new candles arrive
  useEffect(() => {
    const prev = prevLenRef.current;
    prevLenRef.current = candles.length;
    if (candles.length === 0) return;
    if (prev === 0) {
      const fresh = defaultViewport(candles.length, DEFAULT_COUNT);
      setVp(fresh);
      return;
    }
    setVp((cur) => followLive(cur, prev, candles.length));
  }, [candles]);

  // Live price patched into the last candle (visual only)
  const livePrice = market[selectedSymbol]?.price;
  const view: CandleData[] = useMemo(() => {
    if (!candles.length) return candles;
    if (!livePrice) return candles;
    const next = [...candles];
    const last = { ...next[next.length - 1] };
    last.close = livePrice;
    last.high = Math.max(last.high, livePrice);
    last.low = Math.min(last.low, livePrice);
    next[next.length - 1] = last;
    return next;
  }, [candles, livePrice]);

  const ema9 = useMemo(() => emaSeries(view.map((c) => c.close), 9), [view]);
  const ema21 = useMemo(() => emaSeries(view.map((c) => c.close), 21), [view]);

  const following = isAtLiveEdge(vp, view.length) && view.length > 0;

  // Resize observer
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    });
    ro.observe(wrap);
    setSize({ w: wrap.clientWidth, h: wrap.clientHeight });
    return () => ro.disconnect();
  }, []);

  // ── Draw ───────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.w === 0 || size.h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const W = size.w;
    const H = size.h;
    ctx.fillStyle = 'rgba(10, 14, 23, 0.55)';
    ctx.fillRect(0, 0, W, H);

    const { start, end } = visibleRange(vp, view.length);
    const items = view.slice(start, end);
    if (items.length < 2) {
      ctx.fillStyle = '#64748b';
      ctx.font = '12px Inter, sans-serif';
      ctx.fillText('Mum verisi bekleniyor… (tekerlek: zoom, sürükle: kaydır)', 16, 28);
      return;
    }

    const padR = 68;
    const padB = 22;
    const volH = Math.round(H * 0.13);
    const plotW = W - padR;
    const plotH = H - padB - volH - 10;

    let min = Infinity, max = -Infinity, maxVol = 0;
    for (const c of items) {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
      if (c.volume > maxVol) maxVol = c.volume;
    }
    const span = max - min || 1;
    min -= span * 0.07;
    max += span * 0.07;

    const n = items.length;
    const stepX = plotW / n;
    const x = (i: number) => (i + 0.5) * stepX;
    const y = (p: number) => 10 + (1 - (p - min) / (max - min)) * plotH;
    const cw = Math.max(2, Math.min(24, stepX * 0.62));

    // grid + price labels
    const pStep = niceStep(max - min, 6);
    ctx.font = '10px "JetBrains Mono", monospace';
    ctx.lineWidth = 1;
    for (let p = Math.ceil(min / pStep) * pStep; p <= max; p += pStep) {
      const py = Math.round(y(p)) + 0.5;
      ctx.strokeStyle = 'rgba(30, 41, 59, 0.7)';
      ctx.beginPath(); ctx.moveTo(0, py); ctx.lineTo(plotW, py); ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.fillText(p.toLocaleString('en-US', { maximumFractionDigits: pStep < 1 ? 4 : 2 }), plotW + 6, py + 3);
    }
    // time labels
    ctx.fillStyle = '#64748b';
    const tickEvery = Math.max(1, Math.floor(n / 5));
    for (let i = 0; i < n; i += tickEvery) {
      const d = new Date(items[i].time);
      const label = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
      ctx.fillText(label, Math.max(2, x(i) - 14), H - 6);
    }

    // volume
    items.forEach((c, i) => {
      const up = c.close >= c.open;
      ctx.fillStyle = up ? 'rgba(0,212,170,0.25)' : 'rgba(255,68,68,0.25)';
      const vh = maxVol > 0 ? (c.volume / maxVol) * volH : 0;
      ctx.fillRect(x(i) - cw / 2, H - padB - vh, Math.max(1, cw), vh);
    });

    // candles
    items.forEach((c, i) => {
      const up = c.close >= c.open;
      const col = up ? '#00d4aa' : '#ff4444';
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = Math.max(1, cw * 0.15);
      ctx.beginPath();
      ctx.moveTo(x(i), y(c.high));
      ctx.lineTo(x(i), y(c.low));
      ctx.stroke();
      const bTop = y(Math.max(c.open, c.close));
      const bBot = y(Math.min(c.open, c.close));
      ctx.fillRect(x(i) - cw / 2, bTop, cw, Math.max(1.5, bBot - bTop));
    });

    // EMA overlays (sliced from full-series computation)
    const drawLine = (vals: number[], color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      vals.forEach((_v, i) => {
        const gi = start + i;
        if (gi < 0 || gi >= vals.length) return;
        const px = x(i), py = y(vals[gi]);
        if (!started) { ctx.moveTo(px, py); started = true; }
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    };
    if (ema9.length === view.length) {
      drawLine(ema9, '#ffaa00');
      drawLine(ema21, '#00aaff');
    }

    // Last price line + tag
    const lp = items[items.length - 1].close;
    const lpUp = lp >= items[items.length - 1].open;
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = lpUp ? 'rgba(0,212,170,0.8)' : 'rgba(255,68,68,0.8)';
    ctx.beginPath(); ctx.moveTo(0, y(lp)); ctx.lineTo(plotW, y(lp)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lpUp ? '#00d4aa' : '#ff4444';
    const tagY = Math.min(Math.max(y(lp) - 8, 0), H - 18);
    ctx.fillRect(plotW, tagY, padR, 16);
    ctx.fillStyle = '#04120d';
    ctx.font = 'bold 10px "JetBrains Mono", monospace';
    ctx.fillText(lp.toFixed(lp > 1000 ? 1 : 2), plotW + 5, tagY + 11.5);

    // Crosshair
    if (hover && hover.x < plotW && hover.y < H - padB) {
      ctx.strokeStyle = 'rgba(226,232,240,0.35)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(hover.x, 0); ctx.lineTo(hover.x, H - padB); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, hover.y); ctx.lineTo(plotW, hover.y); ctx.stroke();
      ctx.setLineDash([]);
      // hovered candle highlight
      const relIdx = Math.floor(hover.x / stepX);
      if (relIdx >= 0 && relIdx < n) {
        ctx.strokeStyle = 'rgba(226,232,240,0.6)';
        ctx.strokeRect(x(relIdx) - cw / 2 - 1.5, 8, cw + 3, plotH + 4);
      }
    }
  });

  // ── Interactions: wheel zoom (non-passive) + drag pan ──
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const plotW = rect.width - 68;
      const anchor = Math.min(1, Math.max(0, (e.clientX - rect.left) / Math.max(1, plotW)));
      const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
      setVp((cur) => zoomViewport(cur, prevLenRef.current, factor, anchor));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  const plotW = () => (wrapRef.current ? wrapRef.current.clientWidth - 68 : 1);

  const onMouseDown = (e: React.MouseEvent) => {
    dragRef.current = { startX: e.clientX, startEnd: vpRef.current.endIndex, moved: false };
  };
  const onMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const drag = dragRef.current;
    if (drag) {
      const dx = e.clientX - drag.startX;
      if (Math.abs(dx) > 3) drag.moved = true;
      if (drag.moved) {
        const candleW = plotW() / Math.max(1, vpRef.current.count);
        const deltaEnd = -(dx / Math.max(1, candleW));
        setVp((cur) => panViewport({ ...cur, endIndex: drag.startEnd }, prevLenRef.current, deltaEnd));
      }
    }
    // hover readout
    const n = visibleRange(vpRef.current, prevLenRef.current).end - visibleRange(vpRef.current, prevLenRef.current).start;
    const relIdx = Math.floor((mx / Math.max(1, plotW())) * Math.max(1, n));
    const { start } = visibleRange(vpRef.current, prevLenRef.current);
    setHover({ x: mx, y: my, index: start + relIdx });
  };
  const onMouseUp = () => { dragRef.current = null; };
  const onMouseLeave = () => { dragRef.current = null; setHover(null); };

  const resetView = () => {
    if (view.length) setVp(defaultViewport(view.length, DEFAULT_COUNT));
  };

  const hoverCandle = hover && hover.index >= 0 && hover.index < view.length ? view[hover.index] : null;
  const hoverChg = hoverCandle ? ((hoverCandle.close - hoverCandle.open) / hoverCandle.open) * 100 : 0;

  return (
    <div className="panel glass flex flex-col h-full">
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
          <span className="hidden lg:flex items-center gap-1 text-[10px] mr-2">
            <span className="w-2 h-0.5 bg-[#ffaa00] inline-block" /> EMA9
            <span className="w-2 h-0.5 bg-[#00aaff] inline-block ml-1" /> EMA21
          </span>
          <button title="Uzaklaş" onClick={() => setVp((c) => zoomViewport(c, view.length, 1.3, 0.5))} className="chart-btn"><ZoomOut size={13} /></button>
          <button title="Yakınlaş" onClick={() => setVp((c) => zoomViewport(c, view.length, 1 / 1.3, 0.5))} className="chart-btn"><ZoomIn size={13} /></button>
          <button title="Sıfırla / Canlı takip" onClick={resetView} className="chart-btn"><Maximize2 size={13} /></button>
          {!following && view.length > 0 && (
            <button title="Canlı fiyata dön" onClick={resetView} className="chart-btn-live"><Crosshair size={12} /> CANLI</button>
          )}
          <span className="w-px h-4 bg-terminal-border mx-1" />
          {TFs.map((t) => (
            <button
              key={t}
              onClick={() => setTimeframe(t)}
              className={`px-2 py-0.5 rounded text-[11px] font-mono transition ${timeframe === t ? 'bg-terminal-accent text-black font-bold shadow-glow-accent' : 'text-terminal-textMuted hover:text-terminal-text hover:bg-white/10'}`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>
      <div ref={wrapRef} className="relative flex-1 min-h-0">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 cursor-grab active:cursor-grabbing"
          style={{ width: '100%', height: '100%' }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseLeave}
          onDoubleClick={resetView}
        />
        {/* OHLC legend */}
        {hoverCandle && (
          <div className="absolute top-2 left-2 pointer-events-none font-mono text-[11px] tnum px-2 py-1 rounded-md glass-legend">
            <span className="text-terminal-textDim">O</span> <span className="text-terminal-text">{hoverCandle.open.toFixed(2)}</span>{' '}
            <span className="text-terminal-textDim">H</span> <span className="text-terminal-accent">{hoverCandle.high.toFixed(2)}</span>{' '}
            <span className="text-terminal-textDim">L</span> <span className="text-terminal-danger">{hoverCandle.low.toFixed(2)}</span>{' '}
            <span className="text-terminal-textDim">C</span> <span className="text-terminal-text">{hoverCandle.close.toFixed(2)}</span>{' '}
            <span className={hoverChg >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}>
              {hoverChg >= 0 ? '+' : ''}{hoverChg.toFixed(2)}%
            </span>
          </div>
        )}
        {!following && view.length > 0 && (
          <div className="absolute bottom-2 right-2 pointer-events-none text-[10px] font-mono text-terminal-warning glass-legend px-2 py-0.5 rounded">
            Geçmiş görünüm — sürükle ya da CANLI'ya bas
          </div>
        )}
      </div>
    </div>
  );
}

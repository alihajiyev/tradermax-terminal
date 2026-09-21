import { useEffect, useState } from 'react';
import { Brain, ChevronDown, ChevronUp, Hourglass } from 'lucide-react';
import { useTerminal } from '../../store/useStore';
import type { StrategySnapshot } from '../../types/trading';

const FLIP_HINTS_BUY: Record<string, string> = {
  ema: "EMA9'un EMA21 üzerine çıkması",
  macd: 'MACD histogramın pozitife dönmesi',
  rsi: "RSI'nın 50 üzerine çıkması",
  bb: 'Fiyatın alt banda inmesi',
};

const FLIP_HINTS_SELL: Record<string, string> = {
  ema: "EMA9'un EMA21 altına inmesi",
  macd: 'MACD histogramın negatife dönmesi',
  rsi: "RSI'nın 50 altına inmesi",
  bb: 'Fiyatın üst banda çıkması',
};

function timeAgo(ts: number, now: number): string {
  if (!ts) return 'henüz yok';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 2 ? 'az önce' : `${s} sn önce`;
}

export function StrategyBrain() {
  const { selectedSymbol, botStatus } = useTerminal();
  const [open, setOpen] = useState(true);
  const [snap, setSnap] = useState<StrategySnapshot | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const api = window.electronAPI;
    if (!api) return;
    let alive = true;
    const load = async () => {
      try {
        const s = await api.getStrategyState(selectedSymbol);
        if (alive) setSnap(s);
      } catch { /* ignore */ }
    };
    setSnap(null);
    load();
    const t = setInterval(load, 3000);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { alive = false; clearInterval(t); clearInterval(clock); };
  }, [selectedSymbol]);

  const maxVotes = Math.max(snap?.bullVotes ?? 0, snap?.bearVotes ?? 0, snap?.threshold ?? 1, 0.5);

  const hints = (() => {
    if (!snap || snap.wouldSignal) return [];
    const buySide = snap.bullVotes >= snap.bearVotes;
    const table = buySide ? FLIP_HINTS_BUY : FLIP_HINTS_SELL;
    return snap.parts
      .filter((p) => (buySide ? p.bull < 1 : p.bear < 1) && p.note !== 'Kapalı')
      .slice(0, 3)
      .map((p) => table[p.key] ?? p.label);
  })();

  const deficit = snap && !snap.wouldSignal ? Math.max(0, snap.threshold - Math.max(snap.bullVotes, snap.bearVotes)) : 0;

  return (
    <div className="panel glass shrink-0">
      <button onClick={() => setOpen((o) => !o)} className="w-full panel-header hover:text-terminal-text transition normal-case">
        <span className="flex items-center gap-1.5">
          <Brain size={13} className="text-terminal-accent" />
          Bot Beyni · {selectedSymbol}
          {!botStatus.isRunning && <span className="text-terminal-warning normal-case">(bot duruyor — son bilinen durum)</span>}
        </span>
        <span className="flex items-center gap-2">
          {snap && (
            <span className="font-mono normal-case">
              boğa <b className="text-terminal-accent">{snap.bullVotes.toFixed(2)}</b>
              {' '}ayı <b className="text-terminal-danger">{snap.bearVotes.toFixed(2)}</b>
              {' '}baraj <b className="text-terminal-warning">{snap.threshold}</b>
            </span>
          )}
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && (
        <div className="px-3 py-2 text-[11px]">
          {!snap ? (
            <div className="text-terminal-textDim py-1">
              {botStatus.isRunning
                ? 'Analiz verisi bekleniyor… (mumlar yüklenince burada oylamalar belirir)'
                : 'Bot çalışmıyor. "Botu Başlat"a basın — beyin o zaman konuşur.'}
            </div>
          ) : (
            <>
              {/* Vote bars */}
              <div className="flex items-center gap-2 mb-2">
                <div className="flex-1 h-2.5 rounded-full bg-white/5 overflow-hidden flex">
                  <div className="h-full bg-gradient-to-r from-emerald-500 to-terminal-accent transition-all duration-500" style={{ width: `${(snap.bullVotes / (maxVotes * 2)) * 100}%`, marginLeft: 'auto' }} />
                </div>
                <span className="font-mono text-[10px] text-terminal-textDim whitespace-nowrap">baraj {snap.threshold}</span>
                <div className="flex-1 h-2.5 rounded-full bg-white/5 overflow-hidden flex">
                  <div className="h-full bg-gradient-to-r from-terminal-danger to-red-500 transition-all duration-500" style={{ width: `${(snap.bearVotes / (maxVotes * 2)) * 100}%` }} />
                </div>
              </div>

              {/* Parts */}
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-1.5 mb-2">
                {snap.parts.map((p) => (
                  <div key={p.key} className="rounded-md border border-white/10 bg-black/20 px-2 py-1">
                    <div className="flex justify-between font-bold">
                      <span>{p.label}</span>
                      <span className="font-mono">
                        {p.bull > 0 && <span className="text-terminal-accent">+{p.bull}</span>}
                        {p.bear > 0 && <span className="text-terminal-danger">-{p.bear}</span>}
                        {p.bull === 0 && p.bear === 0 && <span className="text-terminal-textDim">0</span>}
                      </span>
                    </div>
                    <div className="text-terminal-textMuted truncate" title={p.note}>{p.note}</div>
                  </div>
                ))}
              </div>

              {/* Regime */}
              {snap.regime !== 'OFF' && (
                <div className={`mb-1.5 flex items-center gap-1.5 text-[11px] font-bold px-2 py-1 rounded-md border w-fit ${
                  snap.regime === 'TREND'
                    ? 'text-terminal-accent border-terminal-accent/30 bg-terminal-accentDim'
                    : 'text-terminal-warning border-terminal-warning/30 bg-terminal-warningDim'
                }`}>
                  ADX {snap.adx.toFixed(1)} · {snap.regime === 'TREND' ? 'TREND VAR — işlem izni' : 'YATAY PİYASA — bot dinleniyor'}
                </div>
              )}

              {/* Circuit breaker */}
              {snap.halted && (
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-bold px-2 py-1 rounded-md border w-fit text-terminal-danger border-terminal-danger/40 bg-terminal-dangerDim">
                  ⛔ GÜNLÜK ZARAR FRENİ AKTİF — bugün yeni pozisyon açılmayacak, açıklar SL/TP ile yönetiliyor
                </div>
              )}

              {/* Analyst: structure + flow */}
              <div className="mb-1.5 flex flex-wrap gap-1.5 text-[10px] font-mono">
                {snap.structure && (
                  <span className={`px-2 py-0.5 rounded-md border ${
                    snap.structure.trend === 'UPTREND'
                      ? 'text-terminal-accent border-terminal-accent/30 bg-terminal-accentDim'
                      : snap.structure.trend === 'DOWNTREND'
                        ? 'text-terminal-danger border-terminal-danger/30 bg-terminal-dangerDim'
                        : 'text-terminal-textMuted border-white/10 bg-white/5'
                  }`}>
                    Yapı: {snap.structure.trend === 'UPTREND' ? 'YÜKSELEN' : snap.structure.trend === 'DOWNTREND' ? 'DÜŞEN' : 'YATAY'}
                    {snap.structure.bos && ` · BOS-${snap.structure.bos}`}
                    {snap.structure.resistance !== null && ` · Dir +${snap.structure.resistanceDistPct?.toFixed(2)}%`}
                    {snap.structure.support !== null && ` · Des -${Math.abs(snap.structure.supportDistPct ?? 0).toFixed(2)}%`}
                  </span>
                )}
                {snap.bookImbalance !== null && (
                  <span className="px-2 py-0.5 rounded-md border border-white/10 bg-white/5 text-terminal-textMuted">
                    Defter {snap.bookImbalance >= 0 ? 'alıcı' : 'satıcı'} {Math.abs(snap.bookImbalance).toFixed(2)}
                  </span>
                )}
                {snap.fundingRate !== null && (
                  <span className={`px-2 py-0.5 rounded-md border ${Math.abs(snap.fundingRate) > 0.0005 ? 'text-terminal-warning border-terminal-warning/30 bg-terminal-warningDim' : 'text-terminal-textMuted border-white/10 bg-white/5'}`}>
                    Fund %{(snap.fundingRate * 100).toFixed(4)}
                  </span>
                )}
                {snap.fearGreed && (
                  <span className="px-2 py-0.5 rounded-md border border-white/10 bg-white/5 text-terminal-textMuted">
                    {snap.fearGreed.label === 'Extreme Greed' ? '🤑' : snap.fearGreed.label === 'Greed' ? '🙂' : snap.fearGreed.label === 'Fear' ? '😨' : snap.fearGreed.label === 'Extreme Fear' ? '😱' : '😐'} {snap.fearGreed.value}
                  </span>
                )}
              </div>

              {/* Verdict */}
              {snap.wouldSignal ? (
                snap.regimeBlocked ? (
                  <div className="text-terminal-warning">
                    🛌 <b>{snap.wouldSignal === 'BUY' ? 'ALIM' : 'SATIM'} sinyali oluştu</b> ama <b>rejim filtresi veto etti</b> (ADX {snap.adx.toFixed(1)} — yatay piyasa, kırbaç riski). Trend başlayınca otomatik devam.
                  </div>
                ) : snap.blockedBy ? (
                  <div className="flex items-center gap-1.5 text-terminal-warning">
                    <Hourglass size={13} />
                    <span>
                      <b>{snap.wouldSignal === 'BUY' ? 'ALIM' : 'SATIM'} sinyali oluştu</b> ama engellendi: {snap.blockedBy}
                      {snap.cooldownSecLeft > 0 && ` (${snap.cooldownSecLeft} sn)`}
                    </span>
                  </div>
                ) : (
                  <div className="text-terminal-accent font-bold">
                    ● {snap.wouldSignal === 'BUY' ? 'ALIM' : 'SATIM'} sinyali aktif — pozisyon açılıyor/açıldı ✓
                    {snap.aiMode === 'gate' && <span className="text-terminal-textMuted font-normal"> (AI onayı soruluyor…)</span>}
                  </div>
                )
              ) : (
                <div className="text-terminal-textMuted">
                  ⏳ Sinyale <b className="text-terminal-text">{deficit.toFixed(2)} oy</b> kaldı.
                  {hints.length > 0 && <> Beklenen: <b className="text-terminal-text">{hints.join(' · ')}</b></>}
                </div>
              )}

              <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-terminal-textDim">
                <span>son analiz: {timeAgo(snap.lastAnalysisAt, now)} (döngü ~15 sn)</span>
                <span>pozisyon: {snap.openPositions}/{snap.maxPositions}{snap.existingSide ? ` (${snap.existingSide} açık)` : ''}</span>
                <span>RSI {snap.indicators.rsi.toFixed(1)} · ATR {snap.indicators.atr.toFixed(2)} · 1h {snap.htfTrend === 'UP' ? '↑' : snap.htfTrend === 'DOWN' ? '↓' : '—'} · ${(snap.price).toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

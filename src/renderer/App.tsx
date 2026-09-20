import { useEffect, useState } from 'react';
import { useLiveSync } from './hooks/useLiveSync';
import { useTerminal } from './store/useStore';
import { TitleBar } from './components/ui/TitleBar';
import { Sidebar } from './components/ui/Sidebar';
import { PortfolioBar } from './components/trading/PortfolioBar';
import { CandlestickChart } from './components/charts/CandlestickChart';
import { LogsPanel } from './components/panels/LogsPanel';
import { PositionsPanel } from './components/panels/PositionsPanel';
import { OrderBookPanel } from './components/panels/OrderBookPanel';
import { SettingsPanel } from './components/settings/SettingsPanel';
import { JournalView } from './components/panels/JournalView';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { BotControls } from './components/trading/BotControls';

export default function App() {
  useLiveSync();
  const { activeView, indicators, botStatus, selectedSymbol, aiVerdict, setAiVerdict, tradingConfig } = useTerminal();
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => {
    window.electronAPI?.getAppVersion().then(setAppVersion).catch(() => undefined);
  }, []);

  // Poll AI verdict for the selected symbol (cheap, engine caches 10 min)
  useEffect(() => {
    const api = window.electronAPI;
    if (!api || tradingConfig.aiMode === 'off') { setAiVerdict(null); return; }
    let alive = true;
    const fetchVerdict = async () => {
      try {
        const v = await api.getAIVerdict(selectedSymbol);
        if (alive) setAiVerdict(v);
      } catch { /* ignore */ }
    };
    fetchVerdict();
    const t = setInterval(fetchVerdict, 30000);
    return () => { alive = false; clearInterval(t); };
  }, [selectedSymbol, tradingConfig.aiMode, setAiVerdict]);

  return (
    <div className="h-screen flex flex-col bg-transparent text-terminal-text">
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <PortfolioBar />
          {activeView === 'settings' ? (
            <ErrorBoundary name="Ayarlar"><SettingsPanel /></ErrorBoundary>
          ) : activeView === 'journal' ? (
            <ErrorBoundary name="Rapor"><JournalView /></ErrorBoundary>
          ) : (
            <div className="flex-1 flex flex-col min-h-0 p-2 gap-2 overflow-hidden">
              {/* Indicator strip */}
              <div className="flex items-center gap-4 px-3 py-1.5 panel text-[11px] font-mono tnum shrink-0 overflow-x-auto">
                <span className="text-terminal-textDim font-sans font-bold uppercase tracking-wider text-[10px]">İndikatörler</span>
                {indicators ? (
                  <>
                    <span>RSI <b className={indicators.rsi > 70 ? 'text-terminal-danger' : indicators.rsi < 30 ? 'text-terminal-accent' : 'text-terminal-text'}>{indicators.rsi.toFixed(1)}</b></span>
                    <span>MACD <b className={indicators.macd.histogram >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}>{indicators.macd.histogram.toFixed(4)}</b></span>
                    <span>EMA9/21 <b>{indicators.ema.fast.toFixed(1)} / {indicators.ema.slow.toFixed(1)}</b></span>
                    <span>ATR <b className="text-terminal-warning">{indicators.atr.toFixed(2)}</b></span>
                    <span>BB <b>{indicators.bollinger.lower.toFixed(1)} – {indicators.bollinger.upper.toFixed(1)}</b></span>
                    {aiVerdict && (
                      <span title={aiVerdict.reason}>
                        AI <b className={aiVerdict.bias === 'LONG' ? 'text-terminal-accent' : aiVerdict.bias === 'SHORT' ? 'text-terminal-danger' : 'text-terminal-warning'}>
                          {aiVerdict.bias} %{Math.round(aiVerdict.confidence * 100)}
                        </b>
                      </span>
                    )}
                    {botStatus.lastSignal && (
                      <span className="ml-auto text-terminal-textDim">
                        Son sinyal: <b className={botStatus.lastSignal.side === 'BUY' ? 'text-terminal-accent' : 'text-terminal-danger'}>
                          {botStatus.lastSignal.side} {botStatus.lastSignal.symbol} @ {botStatus.lastSignal.price.toFixed(2)}
                        </b>
                      </span>
                    )}
                  </>
                ) : (
                  <span className="text-terminal-textDim">hesaplanıyor…</span>
                )}
                <div className="ml-auto flex gap-2">
                  <BotControls compact />
                </div>
              </div>

              {/* Chart */}
              <div className="flex-[1.4] min-h-0">
                <CandlestickChart />
              </div>

              {/* Bottom grid */}
              <div className="flex-1 min-h-0 grid grid-cols-12 gap-2">
                <div className="col-span-5 min-h-0"><LogsPanel /></div>
                <div className="col-span-4 min-h-0"><PositionsPanel /></div>
                <div className="col-span-3 min-h-0"><OrderBookPanel /></div>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* Status bar */}
      <div className="h-6 shrink-0 glass-bar border-t border-white/10 flex items-center px-3 gap-4 text-[10px] font-mono text-terminal-textDim">
        <span>v{appVersion || '…'}</span>
        <span className="text-terminal-accent">● TESTNET</span>
        <span className="ml-auto">EMA · MACD · RSI · ATR · BB | SL=ATR×{tradingConfig.stopLossATRMultiplier} · TP 1:{tradingConfig.takeProfitRiskReward} · Risk %{(tradingConfig.riskPerTrade * 100).toFixed(1)}{tradingConfig.adaptiveMode ? ' · ADAPTİF' : ''}{tradingConfig.aiMode !== 'off' ? ` · AI:${tradingConfig.aiMode.toUpperCase()}` : ''}</span>
      </div>
    </div>
  );
}

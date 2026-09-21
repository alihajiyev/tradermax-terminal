import { LayoutDashboard, BarChart3, Settings as SettingsIcon, Feather } from 'lucide-react';
import { useTerminal, type ActiveView } from '../../store/useStore';
import { TitleBar } from '../ui/TitleBar';
import { PortfolioBar } from '../trading/PortfolioBar';
import { BotControls } from '../trading/BotControls';
import { PositionsPanel } from '../panels/PositionsPanel';
import { LogsPanel } from '../panels/LogsPanel';
import { JournalView } from '../panels/JournalView';
import { SettingsPanel } from '../settings/SettingsPanel';
import { ErrorBoundary } from '../ui/ErrorBoundary';

const NAV: { id: ActiveView; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'terminal', label: 'Terminal', icon: LayoutDashboard },
  { id: 'journal', label: 'Rapor', icon: BarChart3 },
  { id: 'settings', label: 'Ayarlar', icon: SettingsIcon },
];

/**
 * Lite mode: same engine, numbers only. No canvas chart, no blur/glass,
 * no indicator polling — minimal CPU/GPU/RAM footprint for weak machines.
 */
export function LiteView() {
  const { activeView, setActiveView, botStatus, portfolio } = useTerminal();
  const pnlUp = portfolio.totalPnL >= 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <PortfolioBar />
      {/* Lite nav */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 shrink-0 border-b border-white/10">
        <span className="flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded bg-terminal-accentDim text-terminal-accent border border-terminal-accent/30">
          <Feather size={11} /> LITE
        </span>
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-bold transition ${
                active
                  ? 'bg-terminal-accentDim text-terminal-accent border border-terminal-accent/30'
                  : 'text-terminal-textMuted hover:text-terminal-text hover:bg-white/5 border border-transparent'
              }`}
            >
              <Icon size={13} />
              {item.label}
            </button>
          );
        })}
        <span className={`ml-auto flex items-center gap-1.5 text-[11px] font-bold px-2 py-0.5 rounded-full border ${
          botStatus.isRunning
            ? 'text-terminal-accent border-terminal-accent/40 bg-terminal-accentDim'
            : 'text-terminal-textMuted border-white/10'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${botStatus.isRunning ? 'bg-terminal-accent animate-pulse' : 'bg-terminal-textDim'}`} />
          {botStatus.isRunning ? 'BOT LIVE' : 'DURUYOR'}
        </span>
        <span className={`text-xs font-mono tnum font-bold ${pnlUp ? 'text-terminal-accent' : 'text-terminal-danger'}`}>
          {pnlUp ? '+' : ''}{portfolio.totalPnL.toFixed(2)}
        </span>
      </div>

      <div className="flex-1 flex flex-col min-h-0 p-2 gap-2 overflow-hidden">
        {activeView === 'settings' ? (
          <ErrorBoundary name="Ayarlar"><SettingsPanel /></ErrorBoundary>
        ) : activeView === 'journal' ? (
          <ErrorBoundary name="Rapor"><JournalView /></ErrorBoundary>
        ) : (
          <>
            <BotControls />
            <div className="flex-1 min-h-0 grid grid-cols-12 gap-2">
              <div className="col-span-7 min-h-0"><PositionsPanel /></div>
              <div className="col-span-5 min-h-0"><LogsPanel limit={60} /></div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function LiteShell() {
  const { uiMode } = useTerminal();
  return (
    <div className={`h-screen flex flex-col text-terminal-text ${uiMode === 'lite' ? 'lite bg-[#0a0e17]' : 'bg-transparent'}`}>
      <TitleBar />
      <div className="flex flex-1 min-h-0">
        <LiteView />
      </div>
      <div className="h-6 shrink-0 border-t border-white/10 flex items-center px-3 gap-3 text-[10px] font-mono text-terminal-textDim bg-[#0a0e17]">
        <span>LITE · düşük güç modu (grafik yok, motor aynı)</span>
      </div>
    </div>
  );
}

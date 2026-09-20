import { LayoutDashboard, Settings as SettingsIcon, Activity, BarChart3 } from 'lucide-react';
import { useTerminal, type ActiveView } from '../../store/useStore';
import { BotControls } from '../trading/BotControls';

const NAV: { id: ActiveView; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'terminal', label: 'Terminal', icon: LayoutDashboard },
  { id: 'journal', label: 'Rapor', icon: BarChart3 },
  { id: 'settings', label: 'Ayarlar', icon: SettingsIcon },
];

export function Sidebar() {
  const { activeView, setActiveView, botStatus, tradingConfig, selectedSymbol, setSelectedSymbol } = useTerminal();

  return (
    <aside className="w-56 shrink-0 glass-bar border-r border-white/10 flex flex-col">
      <nav className="p-2 space-y-1">
        {NAV.map((item) => {
          const Icon = item.icon;
          const active = activeView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setActiveView(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-sm font-medium transition ${
                active
                  ? 'bg-terminal-accentDim text-terminal-accent border border-terminal-accent/30'
                  : 'text-terminal-textMuted hover:text-terminal-text hover:bg-terminal-bgTertiary border border-transparent'
              }`}
            >
              <Icon size={16} />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-terminal-textDim">
        Symbols
      </div>
      <div className="px-2 space-y-1 overflow-y-auto">
        {tradingConfig.symbols.map((s) => {
          const active = selectedSymbol === s;
          const m = useTerminal.getState().market[s];
          return (
            <button
              key={s}
              onClick={() => setSelectedSymbol(s)}
              className={`w-full text-left px-3 py-1.5 rounded border transition ${
                active
                  ? 'bg-terminal-bgTertiary border-terminal-accent/40'
                  : 'border-transparent hover:bg-terminal-bgTertiary/60'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className={`text-xs font-bold ${active ? 'text-terminal-accent' : 'text-terminal-text'}`}>{s}</span>
                <Activity size={12} className={botStatus.isRunning ? 'text-terminal-accent' : 'text-terminal-textDim'} />
              </div>
              <div className="text-[11px] font-mono tnum text-terminal-textMuted">
                {m ? `$${m.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-auto p-2 border-t border-terminal-border">
        <BotControls compact />
        <div className="mt-2 px-1 text-[10px] font-mono text-terminal-textDim flex justify-between">
          <span>Trades: {botStatus.totalTrades}</span>
          <span>Win: {botStatus.winRate.toFixed(0)}%</span>
        </div>
      </div>
    </aside>
  );
}

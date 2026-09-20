import { Minus, Square, X } from 'lucide-react';

export function TitleBar() {
  const api = window.electronAPI;
  return (
    <div className="drag-region h-9 flex items-center justify-between glass-bar border-b border-white/10 px-3 shrink-0">
      <div className="flex items-center gap-2">
        <div className="w-2.5 h-2.5 rounded-sm bg-terminal-accent shadow-glow-accent" />
        <span className="text-xs font-bold tracking-widest text-terminal-text">
          TRADER<span className="text-terminal-accent">MAX</span>
        </span>
        <span className="text-[10px] text-terminal-textDim border border-terminal-border rounded px-1.5 py-0.5 ml-1">
          TESTNET · ALGO TERMINAL
        </span>
      </div>
      <div className="no-drag flex items-center gap-1">
        <button className="p-1.5 rounded hover:bg-terminal-bgTertiary text-terminal-textMuted hover:text-terminal-text" onClick={() => api?.minimizeWindow()}>
          <Minus size={14} />
        </button>
        <button className="p-1.5 rounded hover:bg-terminal-bgTertiary text-terminal-textMuted hover:text-terminal-text" onClick={() => api?.maximizeWindow()}>
          <Square size={12} />
        </button>
        <button className="p-1.5 rounded hover:bg-terminal-danger/20 text-terminal-textMuted hover:text-terminal-danger" onClick={() => api?.closeWindow()}>
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

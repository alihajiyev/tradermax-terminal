import { useEffect, useRef } from 'react';
import { Trash2 } from 'lucide-react';
import { useTerminal } from '../../store/useStore';

const LEVEL_COLOR: Record<string, string> = {
  info: 'text-terminal-info',
  success: 'text-terminal-accent',
  warn: 'text-terminal-warning',
  error: 'text-terminal-danger',
  debug: 'text-terminal-textDim',
};

export function LogsPanel({ limit = 500 }: { limit?: number }) {
  const { logs, clearLogs } = useTerminal();
  const bottomRef = useRef<HTMLDivElement>(null);
  const visible = logs.slice(-limit);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [logs.length]);

  return (
    <div className="panel flex flex-col h-full">
      <div className="panel-header">
        <span>Canlı İşlem Logları ({logs.length})</span>
        <button
          className="flex items-center gap-1 text-terminal-textDim hover:text-terminal-danger text-[11px]"
          onClick={() => { window.electronAPI?.clearLogs(); clearLogs(); }}
        >
          <Trash2 size={12} /> Temizle
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2 space-y-0.5 font-mono text-[11px] leading-relaxed min-h-0">
        {visible.length === 0 && <div className="text-terminal-textDim">Log bekleniyor — botu başlatın.</div>}
        {visible.map((l) => (
          <div key={l.id} className="flex gap-2 hover:bg-terminal-bgTertiary/50 px-1 rounded">
            <span className="text-terminal-textDim shrink-0 tnum">
              {new Date(l.timestamp).toLocaleTimeString('tr-TR', { hour12: false })}
            </span>
            <span className={`font-bold shrink-0 w-14 ${LEVEL_COLOR[l.level] ?? 'text-terminal-text'}`}>
              [{l.level.toUpperCase()}]
            </span>
            <span className="text-terminal-info shrink-0">[{l.context}]</span>
            <span className="text-terminal-text break-words">{l.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

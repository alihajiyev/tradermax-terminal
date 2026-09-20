import { Component, type ReactNode } from 'react';

/** Catches render crashes and shows the error instead of a blank screen. */
export class ErrorBoundary extends Component<{ children: ReactNode; name: string }, { error: string | null }> {
  constructor(props: { children: ReactNode; name: string }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(err: unknown): { error: string } {
    return { error: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err) };
  }

  componentDidCatch(err: unknown): void {
    console.error(`[ErrorBoundary:${this.props.name}]`, err);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex-1 overflow-auto p-4">
          <div className="max-w-2xl mx-auto panel p-4 border-terminal-danger/50">
            <h2 className="text-sm font-bold text-terminal-danger mb-2">Bu panel çöktü ({this.props.name})</h2>
            <p className="text-xs text-terminal-textMuted mb-2">
              Bu hatanın ekran görüntüsünü gönderin — düzelteyim. Uygulamanın geri kalanı çalışıyor.
            </p>
            <pre className="text-[11px] font-mono bg-terminal-bg rounded border border-terminal-border p-2 whitespace-pre-wrap break-words">
              {this.state.error}
            </pre>
            <button className="btn-ghost mt-3" onClick={() => this.setState({ error: null })}>
              Tekrar Dene
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

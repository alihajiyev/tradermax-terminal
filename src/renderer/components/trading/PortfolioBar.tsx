import { Wallet, TrendingUp, TrendingDown } from 'lucide-react';
import { useTerminal } from '../../store/useStore';

function fmt(n: number, d = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function PortfolioBar() {
  const { portfolio, market, selectedSymbol, botStatus, simMode } = useTerminal();
  const m = market[selectedSymbol];
  const pnlUp = portfolio.totalPnL >= 0;

  return (
    <div className="h-14 shrink-0 glass-bar border-b border-white/10 flex items-stretch px-4 gap-6 overflow-x-auto">
      <div className="flex items-center gap-2 py-2">
        <Wallet size={16} className="text-terminal-accent" />
        <div>
          <div className="text-[10px] uppercase tracking-wider text-terminal-textDim font-semibold">Total Value</div>
          <div className="text-base font-bold font-mono tnum leading-tight">${fmt(portfolio.totalValue)}</div>
        </div>
      </div>

      <div className="w-px bg-terminal-border my-2" />

      <div className="flex items-center py-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-terminal-textDim font-semibold">Available</div>
          <div className="text-sm font-mono tnum">${fmt(portfolio.availableBalance)}</div>
        </div>
      </div>

      <div className="flex items-center py-2">
        <div>
          <div className="text-[10px] uppercase tracking-wider text-terminal-textDim font-semibold">uPnL / rPnL</div>
          <div className="text-sm font-mono tnum">
            <span className={portfolio.unrealizedPnL >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}>
              {portfolio.unrealizedPnL >= 0 ? '+' : ''}{fmt(portfolio.unrealizedPnL)}
            </span>
            <span className="text-terminal-textDim"> / </span>
            <span className={portfolio.realizedPnL >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}>
              {portfolio.realizedPnL >= 0 ? '+' : ''}{fmt(portfolio.realizedPnL)}
            </span>
          </div>
        </div>
      </div>

      <div className="w-px bg-terminal-border my-2" />

      <div className="flex items-center gap-2 py-2">
        {pnlUp ? <TrendingUp size={16} className="text-terminal-accent" /> : <TrendingDown size={16} className="text-terminal-danger" />}
        <div>
          <div className="text-[10px] uppercase tracking-wider text-terminal-textDim font-semibold">{selectedSymbol} · 24h</div>
          <div className="text-sm font-mono tnum font-bold">
            {m ? `$${fmt(m.price)} ` : '— '}
            {m && (
              <span className={m.changePercent24h >= 0 ? 'text-terminal-accent' : 'text-terminal-danger'}>
                {m.changePercent24h >= 0 ? '+' : ''}{m.changePercent24h.toFixed(2)}%
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="ml-auto flex items-center gap-2 py-2">
        <span className={`flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full border ${
          botStatus.live
            ? 'text-white border-terminal-danger bg-terminal-danger animate-pulse'
            : simMode
              ? 'text-terminal-warning border-terminal-warning/40 bg-terminal-warningDim'
              : 'text-terminal-info border-terminal-info/40 bg-terminal-infoDim'
        }`} title={botStatus.live ? 'GERÇEK PARA — gerçek emirler gönderiliyor!' : simMode ? 'Borsa hesabı bağlı değil — sanal bakiye ile simülasyon' : 'Testnet hesabı bağlı (simülasyon)'}>
          {botStatus.live ? '⛔ GERÇEK PARA' : simMode ? 'SİMÜLASYON' : 'TESTNET CANLI'}
        </span>
        <span className={`flex items-center gap-1.5 text-[11px] font-bold px-2.5 py-1 rounded-full border ${
          botStatus.isRunning
            ? 'text-terminal-accent border-terminal-accent/40 bg-terminal-accentDim'
            : 'text-terminal-textMuted border-terminal-border bg-terminal-bgTertiary'
        }`}>
          <span className={`w-1.5 h-1.5 rounded-full ${botStatus.isRunning ? 'bg-terminal-accent animate-pulse' : 'bg-terminal-textDim'}`} />
          {botStatus.isRunning ? 'BOT LIVE' : 'BOT STOPPED'}
        </span>
      </div>
    </div>
  );
}

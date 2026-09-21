import Store from 'electron-store';
import { join } from 'path';
import type { Position, Order } from '../../renderer/types/trading.js';

/**
 * Paper-trading account persistence (plain JSON on disk — no secrets here).
 * This is what gives the bot "memory": balance, stats and OPEN positions
 * survive restarts and app updates. Real-exchange mode later mirrors this
 * pattern (exchange = source of truth), so no behavior surprises.
 */
export interface PaperState {
  version: 1;
  virtualBalance: number;
  realizedPnL: number;
  totalTrades: number;
  winningTrades: number;
  consecLosses: number;
  positions: Position[];
  openOrders: Order[];
  lastCloseAt: [string, number][];
  lastClosePnl: [string, number][];
  updatedAt: number;
}

export class PaperStore {
  private store: Store<{ state?: PaperState }>;

  constructor(userDataPath: string) {
    this.store = new Store<{ state?: PaperState }>({
      name: 'paper-account',
      cwd: join(userDataPath, 'tradermax'),
    });
  }

  load(): PaperState | null {
    try {
      const s = this.store.get('state');
      if (!s || s.version !== 1) return null;
      return s;
    } catch {
      return null;
    }
  }

  save(state: PaperState): void {
    this.store.set('state', state);
  }

  clear(): void {
    this.store.delete('state');
  }
}

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { Logger } from '../utils/logger.js';

export interface JournalOpenMeta {
  reason?: string;
  strength?: number;
  rsi?: number;
  macdHist?: number;
  emaFast?: number;
  emaSlow?: number;
  atr?: number;
  aiBias?: string;
  aiConfidence?: number;
}

export interface JournalTrade {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  /** PnL in R multiples (pnl / initial risk). */
  rMultiple: number;
  /** Max favorable excursion (USDT and R). */
  mfe: number;
  mfeR: number;
  /** Max adverse excursion (USDT and R). */
  mae: number;
  maeR: number;
  holdMinutes: number;
  entryReason: string;
  entryStrength: number;
  rsi: number;
  macdHist: number;
  atr: number;
  aiBias: string;
  aiConfidence: number;
  exitReason: string;
  openedAt: number;
  closedAt: number;
  /** Round-trip commission + slippage cost deducted from pnl. */
  fees: number;
}

export interface JournalSkip {
  t: number;
  symbol: string;
  side: string;
  price: number;
  strength: number;
  category: 'max-positions' | 'duplicate' | 'side-filter' | 'cooldown' | 'ai-veto' | 'regime' | 'halted' | 'htf' | 'no-margin' | 'exposure' | 'min-notional' | 'side-cap' | 'structure';
}

export interface JournalStats {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnL: number;
  totalFees: number;
  avgR: number;
  profitFactor: number;
  expectancyR: number;
  best: number;
  worst: number;
  maxDrawdown: number;
  avgHoldMinutes: number;
  bySymbol: Record<string, { trades: number; wins: number; pnl: number; avgR: number }>;
}

/**
 * Persistent trade journal (JSONL). Every open/close/skip is appended to disk
 * so weeks of bot behavior can be analyzed for the "winning formula".
 * Location: %APPDATA%/tradermax/journal/
 */
export class JournalService {
  private logger: Logger;
  private dir: string;
  private tradesFile: string;
  private skipsFile: string;
  private equityFile: string;

  constructor() {
    this.logger = new Logger('Journal');
    this.dir = join(app.getPath('userData'), 'tradermax', 'journal');
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    this.tradesFile = join(this.dir, 'trades.jsonl');
    this.skipsFile = join(this.dir, 'skips.jsonl');
    this.equityFile = join(this.dir, 'equity.jsonl');
  }

  getDir(): string {
    return this.dir;
  }

  /** Full wipe: trades + skips + equity (fresh testnet start). */
  clearAll(): void {
    for (const file of [this.tradesFile, this.skipsFile, this.equityFile]) {
      try {
        if (existsSync(file)) unlinkSync(file);
      } catch (err) {
        this.logger.error(`Journal clear failed (${file})`, err);
      }
    }
  }

  private append(file: string, obj: unknown): void {
    try {
      appendFileSync(file, JSON.stringify(obj) + '\n');
    } catch (err) {
      this.logger.error(`Journal append failed (${file})`, err);
    }
  }

  private readAll<T>(file: string): T[] {
    try {
      if (!existsSync(file)) return [];
      return readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as T);
    } catch (err) {
      this.logger.error(`Journal read failed (${file})`, err);
      return [];
    }
  }

  recordSkip(skip: JournalSkip): void {
    this.append(this.skipsFile, skip);
  }

  recordClose(trade: JournalTrade): void {
    this.append(this.tradesFile, trade);
  }

  snapshotEquity(balance: number, note: string): void {
    this.append(this.equityFile, { t: Date.now(), balance, note });
  }

  getTrades(limit = 500): JournalTrade[] {
    return this.readAll<JournalTrade>(this.tradesFile).slice(-limit).reverse();
  }

  getSkips(limit = 500): JournalSkip[] {
    return this.readAll<JournalSkip>(this.skipsFile).slice(-limit).reverse();
  }

  getEquity(limit = 5000): { t: number; balance: number; note: string }[] {
    return this.readAll<{ t: number; balance: number; note: string }>(this.equityFile).slice(-limit);
  }

  getStats(): JournalStats {
    const trades = this.readAll<JournalTrade>(this.tradesFile);
    const empty: JournalStats = {
      total: 0, wins: 0, losses: 0, winRate: 0, totalPnL: 0, totalFees: 0, avgR: 0,
      profitFactor: 0, expectancyR: 0, best: 0, worst: 0, maxDrawdown: 0,
      avgHoldMinutes: 0, bySymbol: {},
    };
    if (trades.length === 0) return empty;

    let grossProfit = 0;
    let grossLoss = 0;
    let sumR = 0;
    let sumHold = 0;
    let sumFees = 0;
    const bySymbol: JournalStats['bySymbol'] = {};
    for (const t of trades) {
      if (t.pnl >= 0) { grossProfit += t.pnl; } else { grossLoss += Math.abs(t.pnl); }
      sumR += t.rMultiple;
      sumHold += t.holdMinutes;
      sumFees += t.fees ?? 0;
      const s = (bySymbol[t.symbol] ??= { trades: 0, wins: 0, pnl: 0, avgR: 0 });
      s.trades++;
      if (t.pnl >= 0) s.wins++;
      s.pnl += t.pnl;
      s.avgR += t.rMultiple;
    }
    for (const s of Object.values(bySymbol)) s.avgR /= s.trades;

    // Max drawdown from equity curve (fallback: cumulative trade PnL)
    let peak = -Infinity;
    let maxDD = 0;
    let running = 0;
    const equity = this.getEquity();
    if (equity.length > 0) {
      for (const p of equity) {
        if (p.balance > peak) peak = p.balance;
        maxDD = Math.min(maxDD, p.balance - peak);
      }
    } else {
      for (const t of trades) {
        running += t.pnl;
        if (running > peak) peak = running;
        maxDD = Math.min(maxDD, running - peak);
      }
    }

    const wins = trades.filter((t) => t.pnl >= 0).length;
    return {
      total: trades.length,
      wins,
      losses: trades.length - wins,
      winRate: (wins / trades.length) * 100,
      totalPnL: trades.reduce((s, t) => s + t.pnl, 0),
      totalFees: sumFees,
      avgR: sumR / trades.length,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      expectancyR: sumR / trades.length,
      best: Math.max(...trades.map((t) => t.pnl)),
      worst: Math.min(...trades.map((t) => t.pnl)),
      maxDrawdown: maxDD,
      avgHoldMinutes: sumHold / trades.length,
      bySymbol,
    };
  }
}

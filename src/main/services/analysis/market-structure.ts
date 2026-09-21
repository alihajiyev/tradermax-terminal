import type { CandleData } from '../../../renderer/types/trading.js';

/**
 * Market-structure reader (pure functions — node-tested).
 * What pro traders actually watch: swing highs/lows, HH/HL/LH/LL trend
 * state, break-of-structure (BOS) and nearest support/resistance zones.
 */

export interface SwingPoint {
  index: number;
  time: number;
  price: number;
  type: 'H' | 'L';
}

export type TrendState = 'UPTREND' | 'DOWNTREND' | 'RANGE';

export interface MarketStructure {
  trend: TrendState;
  swings: number;
  lastHigh: number | null;
  lastLow: number | null;
  support: number | null;
  resistance: number | null;
  supportDistPct: number | null;
  resistanceDistPct: number | null;
  /** Close beyond the last swing = break of structure. */
  bos: 'BULL' | 'BEAR' | null;
}

/**
 * Fractal swings: candle[i] is the highest/lowest of [i-k, i+k].
 * Tolerates ONE equal neighbor (ties are common at real turning points)
 * but rejects flat plateaus: must beat at least (2k-1) of 2k neighbors.
 */
export function findSwings(candles: CandleData[], k = 2): SwingPoint[] {
  const swings: SwingPoint[] = [];
  const need = 2 * k - 1;
  for (let i = k; i < candles.length - k; i++) {
    let highBeats = 0;
    let highOk = true;
    let lowBeats = 0;
    let lowOk = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high) highOk = false;
      else if (candles[j].high < candles[i].high) highBeats++;
      if (candles[j].low < candles[i].low) lowOk = false;
      else if (candles[j].low > candles[i].low) lowBeats++;
    }
    if (highOk && highBeats >= need) {
      swings.push({ index: i, time: candles[i].time, price: candles[i].high, type: 'H' });
    }
    if (lowOk && lowBeats >= need) {
      swings.push({ index: i, time: candles[i].time, price: candles[i].low, type: 'L' });
    }
  }
  // Deduplicate: tie-tolerance can mark twin fractals at one turning point.
  // Merge same-type swings closer than k, keeping the most extreme.
  const filtered: SwingPoint[] = [];
  for (const s of swings) {
    const last = filtered[filtered.length - 1];
    if (last && last.type === s.type && s.index - last.index <= k) {
      if (s.type === 'H' && s.price > last.price) filtered[filtered.length - 1] = s;
      else if (s.type === 'L' && s.price < last.price) filtered[filtered.length - 1] = s;
    } else {
      filtered.push(s);
    }
  }
  return filtered;
}

export function detectTrend(swings: SwingPoint[]): TrendState {
  const highs = swings.filter((s) => s.type === 'H').slice(-2);
  const lows = swings.filter((s) => s.type === 'L').slice(-2);
  if (highs.length < 2 || lows.length < 2) return 'RANGE';
  const [h1, h2] = highs;
  const [l1, l2] = lows;
  if (h2.price > h1.price && l2.price > l1.price) return 'UPTREND';
  if (h2.price < h1.price && l2.price < l1.price) return 'DOWNTREND';
  return 'RANGE';
}

/**
 * Mean-reversion entry check (pure — node-tested).
 * ONLY fires in ranging markets near a level: buy support dips, sell
 * resistance rejections. Never fades a trend. Returns the side or null.
 */
export function meanReversionSide(
  struct: MarketStructure,
  price: number,
  atr: number,
  rsi: number,
  adx: number,
  adxThreshold: number
): 'BUY' | 'SELL' | null {
  if (price <= 0) return null;
  if (adx >= adxThreshold) return null; // trending → trend-following owns it
  if (struct.trend !== 'RANGE') return null; // never fade a structural trend
  const prox = 0.5 * ((atr > 0 ? atr : price * 0.005) / price); // within half ATR of the level
  if (
    struct.support !== null &&
    Math.abs(price - struct.support) / price <= prox &&
    rsi < 45
  ) {
    return 'BUY';
  }
  if (
    struct.resistance !== null &&
    Math.abs(price - struct.resistance) / price <= prox &&
    rsi > 55
  ) {
    return 'SELL';
  }
  return null;
}

export function analyzeStructure(candles: CandleData[], k = 2, lookback = 12): MarketStructure {
  const empty: MarketStructure = {
    trend: 'RANGE', swings: 0, lastHigh: null, lastLow: null,
    support: null, resistance: null, supportDistPct: null, resistanceDistPct: null, bos: null,
  };
  if (candles.length < 2 * k + 3) return empty;
  const price = candles[candles.length - 1].close;
  const swings = findSwings(candles, k);
  if (swings.length === 0) return empty;

  const recent = swings.slice(-lookback);
  const highs = recent.filter((s) => s.type === 'H');
  const lows = recent.filter((s) => s.type === 'L');
  const lastHigh = highs.length ? highs[highs.length - 1].price : null;
  const lastLow = lows.length ? lows[lows.length - 1].price : null;

  const resistances = highs.map((s) => s.price).filter((p) => p > price).sort((a, b) => a - b);
  const supports = lows.map((s) => s.price).filter((p) => p < price).sort((a, b) => b - a);
  const resistance = resistances.length ? resistances[0] : null;
  const support = supports.length ? supports[0] : null;

  let bos: 'BULL' | 'BEAR' | null = null;
  if (lastHigh !== null && price > lastHigh) bos = 'BULL';
  else if (lastLow !== null && price < lastLow) bos = 'BEAR';

  return {
    trend: detectTrend(swings),
    swings: swings.length,
    lastHigh,
    lastLow,
    support,
    resistance,
    supportDistPct: support !== null && price > 0 ? ((price - support) / price) * 100 : null,
    resistanceDistPct: resistance !== null && price > 0 ? ((resistance - price) / price) * 100 : null,
    bos,
  };
}

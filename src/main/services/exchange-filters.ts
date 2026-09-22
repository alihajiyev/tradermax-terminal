/**
 * Binance exchange filters (LOT_SIZE / PRICE_FILTER / NOTIONAL).
 * Real orders are REJECTED unless quantity/price obey stepSize/tickSize and
 * notional minimums — this module is what makes live trading possible.
 * Pure functions are node-tested; fetching is fail-soft (null).
 */

export interface SymbolFilters {
  symbol: string;
  stepSize: number;
  tickSize: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
}

export const FALLBACK_FILTERS: SymbolFilters = {
  symbol: '',
  stepSize: 0.00001,
  tickSize: 0.01,
  minQty: 0,
  maxQty: 0,
  minNotional: 5,
};

function decimalsOf(step: string): number {
  if (!step.includes('.')) return 0;
  const frac = step.split('.')[1].replace(/0+$/, '');
  return frac.length;
}

export function parseFilters(symbol: string, exchangeInfo: unknown): SymbolFilters | null {
  try {
    const data = exchangeInfo as { symbols?: Array<{ symbol: string; filters: Array<{ filterType: string; [k: string]: string }> }> };
    const s = data?.symbols?.find((x) => x.symbol === symbol.toUpperCase());
    if (!s) return null;
    const out: SymbolFilters = { ...FALLBACK_FILTERS, symbol: symbol.toUpperCase() };
    for (const f of s.filters) {
      if (f.filterType === 'LOT_SIZE') {
        out.stepSize = parseFloat(f.stepSize);
        out.minQty = parseFloat(f.minQty);
        out.maxQty = parseFloat(f.maxQty);
      } else if (f.filterType === 'PRICE_FILTER') {
        out.tickSize = parseFloat(f.tickSize);
      } else if (f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL') {
        out.minNotional = parseFloat(f.minNotional ?? f.notional ?? '5');
      }
    }
    if (!isFinite(out.stepSize) || out.stepSize <= 0) out.stepSize = FALLBACK_FILTERS.stepSize;
    if (!isFinite(out.tickSize) || out.tickSize <= 0) out.tickSize = FALLBACK_FILTERS.tickSize;
    if (!isFinite(out.minNotional) || out.minNotional <= 0) out.minNotional = 5;
    return out;
  } catch {
    return null;
  }
}

/** Floor quantity to the LOT_SIZE step (Binance rejects the rest). */
export function floorToStep(qty: number, stepSize: number): number {
  if (!(stepSize > 0) || !(qty > 0)) return qty;
  const floored = Math.floor(qty / stepSize) * stepSize;
  // Avoid float dust (e.g. 0.30000000004)
  const dec = decimalsOf(stepSize.toString());
  return parseFloat(floored.toFixed(Math.min(dec + 2, 8)));
}

/** Floor price to the tick size. */
export function floorToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0) || !(price > 0)) return price;
  const floored = Math.floor(price / tickSize) * tickSize;
  const dec = decimalsOf(tickSize.toString());
  return parseFloat(floored.toFixed(Math.min(dec + 2, 8)));
}

/** Format a number with exactly the step's decimals (for order strings). */
export function formatStep(value: number, step: number): string {
  const dec = decimalsOf(step.toString());
  return value.toFixed(Math.min(dec, 8));
}

export async function fetchSymbolFilters(baseURL: string, symbol: string, timeoutMs = 10000): Promise<SymbolFilters | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseURL}/api/v3/exchangeInfo?symbol=${symbol.toUpperCase()}`, {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return parseFilters(symbol, await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

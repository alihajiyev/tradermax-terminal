/**
 * Market flow + sentiment readers (public endpoints, no keys).
 * - Funding rate & open interest: Binance FUTURES mainnet public REST.
 *   Used as directional *context* while trading testnet spot (prices track).
 * - Fear & Greed: alternative.me free API.
 * Everything fails soft (null) — analysis never depends on these.
 */

export interface SymbolFlow {
  fundingRate: number | null;
  openInterest: number | null;
  updatedAt: number;
}

export interface FearGreed {
  value: number;
  label: string;
  updatedAt: number;
}

async function fetchJSON(url: string, timeoutMs = 8000): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Latest funding rate (e.g. 0.0001 = 0.01%). High + = crowded longs. */
export async function fetchFundingRate(symbol: string): Promise<number | null> {
  try {
    const data = (await fetchJSON(
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${symbol.toUpperCase()}&limit=1`
    )) as Array<{ fundingRate: string }>;
    const v = parseFloat(data?.[0]?.fundingRate);
    return isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** Open interest in contracts. Rising OI + rising price = healthy trend. */
export async function fetchOpenInterest(symbol: string): Promise<number | null> {
  try {
    const data = (await fetchJSON(
      `https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol.toUpperCase()}`
    )) as { openInterest: string };
    const v = parseFloat(data?.openInterest);
    return isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export async function fetchFearGreed(): Promise<FearGreed | null> {
  try {
    const data = (await fetchJSON('https://api.alternative.me/fng/?limit=1')) as {
      data?: Array<{ value: string; value_classification: string; timestamp: string }>;
    };
    const row = data?.data?.[0];
    if (!row) return null;
    const value = parseInt(row.value, 10);
    if (!isFinite(value)) return null;
    return { value, label: row.value_classification || 'Unknown', updatedAt: Date.now() };
  } catch {
    return null;
  }
}

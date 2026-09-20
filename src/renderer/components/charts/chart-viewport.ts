/**
 * Pure viewport math for the candlestick chart (no DOM).
 * Tested with node — see Temp/opencode/chart-viewport.test.js run.
 *
 * Model: the full candle array has `total` items. The visible window is
 * [endIndex - count, endIndex) — `endIndex` is exclusive. When
 * `endIndex === total` the chart is glued to the live edge (follow mode).
 */

export interface Viewport {
  /** Exclusive end index into the candle array. */
  endIndex: number;
  /** Number of candles in the visible window. */
  count: number;
}

export interface ViewportLimits {
  minCount: number;
  maxCount: number;
}

export const DEFAULT_LIMITS: ViewportLimits = { minCount: 10, maxCount: 500 };

export function clampViewport(vp: Viewport, total: number, limits: ViewportLimits = DEFAULT_LIMITS): Viewport {
  if (total <= 0) return { endIndex: 0, count: limits.minCount };
  let count = Math.round(vp.count) || limits.minCount;
  count = Math.min(limits.maxCount, Math.max(limits.minCount, count));
  // Never show empty space: window can't exceed available data
  count = Math.min(count, total);
  const endIndex = Math.min(total, Math.max(count, Math.round(vp.endIndex)));
  return { endIndex, count };
}

export function defaultViewport(total: number, count = 60): Viewport {
  return clampViewport({ endIndex: total, count }, total);
}

/**
 * Zoom around an anchor. `factor > 1` zooms OUT (more candles),
 * `factor < 1` zooms IN. `anchorRatio` 0..1 = position inside the visible
 * window that must keep pointing at the same candle (mouse x fraction).
 */
export function zoomViewport(
  vp: Viewport,
  total: number,
  factor: number,
  anchorRatio: number,
  limits: ViewportLimits = DEFAULT_LIMITS
): Viewport {
  const r = Math.min(1, Math.max(0, anchorRatio));
  const newCount = Math.min(limits.maxCount, Math.max(limits.minCount, Math.round(vp.count * factor)));
  // Data index under the anchor must stay fixed:
  // anchorIdx = end - (1 - r) * count  →  end' = anchorIdx + (1 - r) * newCount
  const anchorIdx = vp.endIndex - (1 - r) * vp.count;
  const newEnd = anchorIdx + (1 - r) * newCount;
  return clampViewport({ endIndex: newEnd, count: newCount }, total, limits);
}

/**
 * Pan by a (possibly fractional) number of candles.
 * `deltaEnd > 0` moves the window toward NEWER data (right),
 * `deltaEnd < 0` toward OLDER data.
 */
export function panViewport(vp: Viewport, total: number, deltaEnd: number): Viewport {
  return clampViewport({ endIndex: vp.endIndex + deltaEnd, count: vp.count }, total);
}

/** Is the window glued to the live edge? (follow mode) */
export function isAtLiveEdge(vp: Viewport, total: number): boolean {
  return vp.endIndex >= total;
}

/**
 * Advance a glued viewport when new candles arrive.
 * `prevTotal` = array length the viewport was built against.
 */
export function followLive(vp: Viewport, prevTotal: number, newTotal: number): Viewport {
  if (vp.endIndex >= prevTotal) return clampViewport({ ...vp, endIndex: newTotal }, newTotal);
  return vp;
}

export function visibleRange(vp: Viewport, total: number): { start: number; end: number } {
  const end = Math.min(Math.max(0, Math.round(vp.endIndex)), total);
  const start = Math.min(Math.max(0, end - Math.round(vp.count)), total);
  return { start, end };
}

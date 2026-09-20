"use strict";
/**
 * Pure viewport math for the candlestick chart (no DOM).
 * Tested with node — see Temp/opencode/chart-viewport.test.js run.
 *
 * Model: the full candle array has `total` items. The visible window is
 * [endIndex - count, endIndex) — `endIndex` is exclusive. When
 * `endIndex === total` the chart is glued to the live edge (follow mode).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_LIMITS = void 0;
exports.clampViewport = clampViewport;
exports.defaultViewport = defaultViewport;
exports.zoomViewport = zoomViewport;
exports.panViewport = panViewport;
exports.isAtLiveEdge = isAtLiveEdge;
exports.followLive = followLive;
exports.visibleRange = visibleRange;
exports.DEFAULT_LIMITS = { minCount: 10, maxCount: 500 };
function clampViewport(vp, total, limits = exports.DEFAULT_LIMITS) {
    if (total <= 0)
        return { endIndex: 0, count: limits.minCount };
    let count = Math.round(vp.count) || limits.minCount;
    count = Math.min(limits.maxCount, Math.max(limits.minCount, count));
    // Never show empty space: window can't exceed available data
    count = Math.min(count, total);
    const endIndex = Math.min(total, Math.max(count, Math.round(vp.endIndex)));
    return { endIndex, count };
}
function defaultViewport(total, count = 60) {
    return clampViewport({ endIndex: total, count }, total);
}
/**
 * Zoom around an anchor. `factor > 1` zooms OUT (more candles),
 * `factor < 1` zooms IN. `anchorRatio` 0..1 = position inside the visible
 * window that must keep pointing at the same candle (mouse x fraction).
 */
function zoomViewport(vp, total, factor, anchorRatio, limits = exports.DEFAULT_LIMITS) {
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
function panViewport(vp, total, deltaEnd) {
    return clampViewport({ endIndex: vp.endIndex + deltaEnd, count: vp.count }, total);
}
/** Is the window glued to the live edge? (follow mode) */
function isAtLiveEdge(vp, total) {
    return vp.endIndex >= total;
}
/**
 * Advance a glued viewport when new candles arrive.
 * `prevTotal` = array length the viewport was built against.
 */
function followLive(vp, prevTotal, newTotal) {
    if (vp.endIndex >= prevTotal)
        return clampViewport({ ...vp, endIndex: newTotal }, newTotal);
    return vp;
}
function visibleRange(vp, total) {
    const end = Math.min(Math.max(0, Math.round(vp.endIndex)), total);
    const start = Math.min(Math.max(0, end - Math.round(vp.count)), total);
    return { start, end };
}

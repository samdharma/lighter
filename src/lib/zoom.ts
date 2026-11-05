export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 6;

export function clampZoom(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

// Ctrl+wheel (Chromium pinch) zoom: deltaY is scaled so a normal wheel notch
// (~100) gives a ~1.25x step, while high-frequency pinch deltas stay smooth.
export function zoomFromWheel(current: number, deltaY: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return clampZoom(current);
  const step = Math.exp(-deltaY * 0.0022);
  return clampZoom(current * step);
}

// WKWebView pinch: gestureScale is relative to gesture start.
export function zoomFromGesture(startZoom: number, gestureScale: number): number {
  if (!Number.isFinite(gestureScale) || gestureScale <= 0) return clampZoom(startZoom);
  return clampZoom(startZoom * gestureScale);
}

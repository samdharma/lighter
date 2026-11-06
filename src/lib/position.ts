import type { ReadingPosition } from "../types";

// A page turn, a scroll, a zoom and a relayout can all produce a new position
// within a few hundred milliseconds. Writing the settings file that often is
// wasted disk work, so saves wait until the reader has been still for a while.
export const POSITION_SAVE_DELAY_MS = 2000;

export function normalizeRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

// Positions that differ only in sub-thousandth scroll remainders are the same
// reading spot; treating them as equal keeps idle saves off the disk.
export function samePosition(a: ReadingPosition | null, b: ReadingPosition | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.path === b.path &&
    a.page === b.page &&
    (a.anchor ?? null) === (b.anchor ?? null) &&
    normalizeRatio(a.scrollRatio) === normalizeRatio(b.scrollRatio)
  );
}

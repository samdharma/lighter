import assert from "node:assert/strict";
import { test } from "node:test";
import { POSITION_SAVE_DELAY_MS, normalizeRatio, samePosition } from "../src/lib/position.ts";
import type { ReadingPosition } from "../src/types.ts";

const base: ReadingPosition = { path: "/tmp/a.pdf", page: 12, anchor: null, scrollRatio: 0.4 };

test("equal positions compare equal", () => {
  assert.equal(samePosition(base, { ...base }), true);
});

test("any saved field makes a position different", () => {
  assert.equal(samePosition(base, { ...base, path: "/tmp/b.pdf" }), false);
  assert.equal(samePosition(base, { ...base, page: 13 }), false);
  assert.equal(samePosition(base, { ...base, anchor: "intro" }), false);
  assert.equal(samePosition(base, { ...base, scrollRatio: 0.9 }), false);
});

test("scroll ratios below the saved precision are treated as equal", () => {
  assert.equal(samePosition(base, { ...base, scrollRatio: 0.40004 }), true);
  assert.equal(POSITION_SAVE_DELAY_MS >= 1500, true);
});

test("null positions only match null", () => {
  assert.equal(samePosition(null, null), true);
  assert.equal(samePosition(base, null), false);
  assert.equal(samePosition(null, base), false);
});

test("scroll ratios are finite and clamped", () => {
  assert.equal(normalizeRatio(Number.NaN), 0);
  assert.equal(normalizeRatio(Number.POSITIVE_INFINITY), 0);
  assert.equal(normalizeRatio(-2), 0);
  assert.equal(normalizeRatio(4), 1);
  assert.equal(normalizeRatio(0.123456), 0.123);
});

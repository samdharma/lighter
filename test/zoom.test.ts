import assert from "node:assert/strict";
import { test } from "node:test";
import { clampZoom, zoomFromGesture, zoomFromWheel } from "../src/lib/zoom.ts";

test("clampZoom bounds and rounds", () => {
  assert.equal(clampZoom(1), 1);
  assert.equal(clampZoom(0.01), 0.25);
  assert.equal(clampZoom(99), 6);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(clampZoom(1.2345), 1.23);
});

test("wheel up zooms in, wheel down zooms out", () => {
  const inOnce = zoomFromWheel(1, -100);
  assert.ok(inOnce > 1.2 && inOnce < 1.3);
  const outOnce = zoomFromWheel(1, 100);
  assert.ok(outOnce > 0.77 && outOnce < 0.83);
  assert.equal(zoomFromWheel(1, 0), 1);
});

test("wheel zoom respects clamps", () => {
  assert.equal(zoomFromWheel(6, -5000), 6);
  assert.equal(zoomFromWheel(0.25, 5000), 0.25);
});

test("gesture zoom scales relative to gesture start", () => {
  assert.equal(zoomFromGesture(1, 1.5), 1.5);
  assert.equal(zoomFromGesture(2, 0.5), 1);
  assert.equal(zoomFromGesture(1, Number.NaN), 1);
  assert.equal(zoomFromGesture(5, 4), 6);
});

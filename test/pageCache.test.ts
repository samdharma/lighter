import assert from "node:assert/strict";
import { test } from "node:test";
import { PageCache } from "../src/lib/pageCache.ts";

test("cache stores and recalls pages", () => {
  const cache = new PageCache<string>(3);
  cache.set(1, "one", 1);
  cache.set(2, "two", 1);
  assert.equal(cache.get(1), "one");
  assert.equal(cache.size, 2);
});

test("overflow evicts the page farthest from focus", () => {
  const destroyed: string[] = [];
  const cache = new PageCache<string>(3, (value) => destroyed.push(value));
  cache.set(1, "one", 1);
  cache.set(5, "five", 1);
  cache.set(9, "nine", 1);
  cache.set(10, "ten", 9);
  assert.equal(cache.size, 3);
  assert.deepEqual(destroyed, ["one"]);
  assert.equal(cache.has(1), false);
  assert.equal(cache.has(5), true);
  assert.equal(cache.get(10), "ten");
});

test("clear destroys everything", () => {
  const destroyed: number[] = [];
  const cache = new PageCache<number>(4, (value) => destroyed.push(value));
  cache.set(1, 1, 1);
  cache.set(2, 2, 1);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.equal(destroyed.length, 2);
});

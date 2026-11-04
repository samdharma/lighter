import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyHref,
  extractHeadings,
  hasMath,
  hasMermaid,
  splitFrontMatter,
} from "../src/markdown/text.ts";

test("front matter is separated from the body", () => {
  const src = "---\ntitle: Notes\n---\n# Hello\n";
  const split = splitFrontMatter(src);
  assert.equal(split.meta, "title: Notes");
  assert.match(split.body, /^# Hello/);
  assert.equal(splitFrontMatter("# No meta\n").meta, null);
});

test("headings skip fenced code", () => {
  const headings = extractHeadings("# A\n\n```\n# not a heading\n```\n## B\n");
  assert.deepEqual(
    headings.map((heading) => heading.text),
    ["A", "B"],
  );
  assert.equal(headings[0].id, "a");
});

test("links only treat http(s) as external", () => {
  assert.equal(classifyHref("#there"), "anchor");
  assert.equal(classifyHref("https://example.com/a"), "external");
  assert.equal(classifyHref("javascript:alert(1)"), "blocked");
  assert.equal(classifyHref("file:///etc/passwd"), "blocked");
  assert.equal(classifyHref("./other.md"), "blocked");
  assert.equal(classifyHref("data:text/html,hi"), "blocked");
});

test("mermaid and math are detected before engines load", () => {
  assert.equal(hasMermaid("```mermaid\nflowchart LR\n```"), true);
  assert.equal(hasMermaid("```js\nconsole.log(1)\n```"), false);
  assert.equal(hasMath("Energy is $E=mc^2$."), true);
  assert.equal(hasMath("Price is $5 and $6"), false);
  assert.equal(hasMath("$$\nx^2\n$$"), true);
});

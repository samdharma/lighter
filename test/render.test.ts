import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { renderMarkdown } from "../src/markdown/render.ts";

function render(src: string, allowRemote = false): string {
  const { window } = parseHTML("<!doctype html><html><body></body></html>");
  return renderMarkdown(src, {
    docId: 7,
    origin: "reader://localhost",
    allowRemote,
    window: window as unknown as Window,
  }).html;
}

test("gfm table, task, strike, and alert render", () => {
  const html = render(
    ["| A | B |", "| - | - |", "| 1 | 2 |", "", "- [x] Done", "- [ ] Later", "", "~~old~~", "", "> [!NOTE]", "> Read this."].join("\n"),
  );
  assert.match(html, /<table/);
  assert.match(html, /type="checkbox"[^>]*checked/);
  assert.match(html, /<del>old<\/del>|<s>old<\/s>/);
  assert.match(html, /alert-note/);
  assert.doesNotMatch(html, /\[!NOTE\]/);
});

test("front matter is metadata and scripts do not survive", () => {
  const html = render('---\ntitle: Secret\n---\n# Body\n\n<script>alert(1)</script>\n\n[click](javascript:alert(1))\n\n![x](file:///etc/passwd)\n');
  assert.match(html, /Document info/);
  assert.match(html, /title: Secret/);
  assert.match(html, /<h1[^>]*>Body<\/h1>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /href\s*=\s*["']javascript:/i);
  assert.doesNotMatch(html, /src\s*=\s*["']file:/i);
});

test("local images point at the document asset URL", () => {
  const html = render("![mark](images/mark.png)");
  assert.match(html, /src="reader:\/\/localhost\/asset\/7\/images\/mark\.png"/);
});

test("remote images stay blocked until the document allows them", () => {
  const blocked = render("![x](https://example.com/a.png)");
  assert.match(blocked, /Remote image blocked/);
  assert.doesNotMatch(blocked, /example\.com/);
  const allowed = render("![x](https://example.com/a.png)", true);
  assert.match(allowed, /src="https:\/\/example\.com\/a\.png"/);
});

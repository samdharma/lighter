import { readFileSync, readdirSync, statSync } from "node:fs";

const dist = new URL("../dist/", import.meta.url);
const html = readFileSync(new URL("index.html", dist), "utf8");
const entryMatch = html.match(/<script type="module"[^>]*src="([^"]+)"/);
if (!entryMatch) {
  console.error("dist/index.html has no module entry");
  process.exit(1);
}
const entryUrl = new URL(entryMatch[1].replace(/^\//, ""), dist);
const entrySize = statSync(entryUrl).size;
const assets = readdirSync(new URL("assets/", dist));
const worker = assets.find((name) => name.startsWith("pdf.worker"));
const mermaid = assets.find((name) => name.startsWith("mermaid"));
console.log(`entry ${entryUrl.pathname.split("/").pop()} ${entrySize} bytes`);
console.log(`pdf worker ${worker ?? "MISSING"}`);
console.log(`mermaid chunk ${mermaid ?? "MISSING"}`);
let failed = false;
if (entrySize > 200_000) {
  console.error("entry script is over 200KB; PDF.js or Mermaid was probably pulled in");
  failed = true;
}
if (!worker || !mermaid) {
  console.error("pdf.worker and mermaid must be their own files");
  failed = true;
}
if (failed) process.exit(1);

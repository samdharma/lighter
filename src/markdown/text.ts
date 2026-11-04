export type Heading = { level: number; text: string; id: string };
export type LinkKind = "anchor" | "external" | "blocked";

export function splitFrontMatter(src: string): { meta: string | null; body: string } {
  if (!src.startsWith("---\n") && !src.startsWith("---\r\n")) {
    return { meta: null, body: src };
  }
  const fence = src.startsWith("---\r\n") ? 5 : 4;
  const rest = src.slice(fence);
  const match = /\r?\n---[ \t]*(?:\r?\n|$)/.exec(rest);
  if (!match) return { meta: null, body: src };
  return {
    meta: rest.slice(0, match.index),
    body: rest.slice(match.index + match[0].length),
  };
}

export function slugify(text: string, used: Map<string, number>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section";
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${seen}`;
}

export function extractHeadings(markdown: string): Heading[] {
  const { body } = splitFrontMatter(markdown);
  const used = new Map<string, number>();
  const headings: Heading[] = [];
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^(```|~~~)/.test(line.trim())) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/\[(.*?)\]\(.*?\)/g, "$1").trim();
    headings.push({
      level: match[1].length,
      text,
      id: slugify(text, used),
    });
  }
  return headings;
}

export function classifyHref(raw: string): LinkKind {
  const href = raw.trim();
  if (!href || href.startsWith("#")) return "anchor";
  if (/^(javascript|vbscript|data|file|blob|about|shell|ms-msdt):/i.test(href)) return "blocked";
  let url: URL;
  try {
    url = new URL(href, "http://reader.invalid");
  } catch {
    return "blocked";
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    if (url.hostname === "reader.invalid") return "blocked";
    return "external";
  }
  return "blocked";
}

export function hasMermaid(src: string): boolean {
  return /^[ \t]{0,3}(```|~~~)mermaid\s*$/m.test(src);
}

export function hasMath(src: string): boolean {
  if (src.includes("$$") || src.includes("\\[") || src.includes("\\(")) return true;
  return /(^|[^\\$])\$(?!\$)(?=\S)[^\n$]{1,400}?(?<!\s)(?<!\\)\$(?!\$)/.test(src);
}

export function assetUrl(origin: string, id: number, rel: string): string {
  const encoded = rel
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${origin}/asset/${id}/${encoded}`;
}

export function isRemoteSrc(src: string): boolean {
  return /^https?:\/\//i.test(src.trim());
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

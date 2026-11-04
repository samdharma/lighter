import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import footnote from "markdown-it-footnote";
import type { Heading } from "./text.ts";
import { assetUrl, escapeHtml, extractHeadings, isRemoteSrc, slugify, splitFrontMatter } from "./text.ts";

export type Rendered = {
  html: string;
  headings: Heading[];
  needsMath: boolean;
  needsMermaid: boolean;
  languages: string[];
};

export type RenderOptions = {
  docId: number;
  origin: string;
  allowRemote: boolean;
  /** DOM window for sanitizing outside the browser. */
  window?: Window;
};

const URI_OK =
  /^(?:(?:(?:f|ht)tps?|mailto|tel|reader):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i;

export function renderMarkdown(src: string, opts: RenderOptions): Rendered {
  const { meta, body } = splitFrontMatter(src);
  const headings = extractHeadings(src);
  const prepared = protectMath(body);
  const md = createParser(opts);
  const raw = md.render(prepared.text);
  const metaHtml = meta
    ? `<details class="front-matter"><summary>Document info</summary><pre>${escapeHtml(meta)}</pre></details>`
    : "";
  const html = sanitize(`${metaHtml}${raw}`, opts.window);
  return {
    html,
    headings,
    needsMath: prepared.found,
    needsMermaid: /class="mermaid-src"/.test(html),
    languages: prepared.languages,
  };
}

type Md = InstanceType<typeof MarkdownIt>;

function createParser(opts: RenderOptions): Md {
  const md = new MarkdownIt({
    html: true,
    linkify: true,
    breaks: false,
    typographer: false,
  });
  md.use(footnote);
  md.use(alertPlugin);
  md.use(taskPlugin);
  const used = new Map<string, number>();
  const defaultHeading =
    md.renderer.rules.heading_open ??
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const inline = tokens[idx + 1];
    const text = inline?.content ?? "";
    const id = slugify(text, used);
    tokens[idx].attrSet("id", id);
    return defaultHeading(tokens, idx, options, env, self);
  };
  md.renderer.rules.fence = (tokens, idx) => {
    const token = tokens[idx];
    const info = token.info.trim().split(/\s+/)[0] ?? "";
    const lang = info.toLowerCase();
    const code = token.content.replace(/\n$/, "");
    if (lang === "mermaid") {
      return `<figure class="diagram"><div class="diagram-bar"><button type="button" data-act="in">Zoom in</button><button type="button" data-act="out">Zoom out</button><button type="button" data-act="fit">Fit</button><button type="button" data-act="reset">Reset</button><button type="button" data-act="source">View source</button></div><div class="diagram-stage"><pre class="mermaid-src">${escapeHtml(code)}</pre></div><pre class="diagram-source" hidden>${escapeHtml(code)}</pre></figure>`;
    }
    const label = lang || "text";
    return `<div class="code-block" data-lang="${escapeHtml(label)}"><div class="code-bar"><span>${escapeHtml(label)}</span><button type="button" data-copy>Copy</button></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
  };
  md.renderer.rules.image = (tokens, idx) => {
    const token = tokens[idx];
    const src = String(token.attrGet("src") ?? "");
    const alt = escapeHtml(token.content || "");
    if (isRemoteSrc(src)) {
      if (!opts.allowRemote) {
        return `<span class="blocked-remote">Remote image blocked</span>`;
      }
      return `<img src="${escapeHtml(src)}" alt="${alt}" />`;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) {
      return `<span class="blocked-remote">Image blocked</span>`;
    }
    const url = assetUrl(opts.origin, opts.docId, src);
    return `<img src="${escapeHtml(url)}" alt="${alt}" />`;
  };
  return md;
}

function alertPlugin(md: Md): void {
  md.core.ruler.after("inline", "reader_alerts", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i].type !== "blockquote_open") continue;
      const inline = tokens[i + 2];
      if (!inline || inline.type !== "inline" || !inline.children?.length) continue;
      const first = inline.children[0];
      if (first.type !== "text") continue;
      const match = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i.exec(first.content);
      if (!match) continue;
      const kind = match[1].toLowerCase();
      tokens[i].attrSet("class", `alert alert-${kind}`);
      first.content = first.content.slice(match[0].length);
      inline.content = inline.content.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i, "");
    }
  });
}

function taskPlugin(md: Md): void {
  md.core.ruler.after("inline", "reader_tasks", (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type !== "inline" || tokens[i - 1]?.type !== "paragraph_open") continue;
      if (tokens[i - 2]?.type !== "list_item_open" || !token.children?.length) continue;
      const first = token.children[0];
      if (first.type !== "text") continue;
      const match = /^\[( |x|X)\]\s+/.exec(first.content);
      if (!match) continue;
      first.content = first.content.slice(match[0].length);
      const box = new state.Token("html_inline", "", 0);
      const checked = match[1].toLowerCase() === "x" ? " checked" : "";
      box.content = `<input type="checkbox" disabled${checked} /> `;
      token.children.unshift(box);
    }
  });
}

function protectMath(src: string): { text: string; found: boolean; languages: string[] } {
  let found = false;
  const languages = new Set<string>();
  const fenced: string[] = [];
  const parked = src.replace(/^[ \t]{0,3}(```|~~~)([^\n]*)\n[\s\S]*?\n[ \t]{0,3}\1[ \t]*$/gm, (block) => {
    const lang = /^[ \t]{0,3}(?:```|~~~)([^\n]*)/.exec(block)?.[1]?.trim().split(/\s+/)[0]?.toLowerCase();
    if (lang && lang !== "mermaid") languages.add(lang);
    const token = `\u0000FENCE${fenced.length}\u0000`;
    fenced.push(block);
    return token;
  });
  let text = parked.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => {
    found = true;
    return mathTag(tex, "block");
  });
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => {
    found = true;
    return mathTag(tex, "block");
  });
  text = text.replace(/\\\((.+?)\\\)/g, (_m, tex: string) => {
    found = true;
    return mathTag(tex, "inline");
  });
  text = text.replace(/(^|[^\\$])\$(?!\$)([^\n$]+?)\$(?!\$)/g, (full, pre: string, tex: string) => {
    if (!/[\\a-zA-Z]/.test(tex)) return full;
    found = true;
    return `${pre}${mathTag(tex, "inline")}`;
  });
  text = text.replace(/\u0000FENCE(\d+)\u0000/g, (_m, n: string) => fenced[Number(n)] ?? "");
  return { text, found, languages: [...languages] };
}

function mathTag(tex: string, display: "inline" | "block"): string {
  return `<math-src display="${display}">${escapeHtml(tex.trim())}</math-src>`;
}

function sanitize(html: string, win?: Window): string {
  const purifier = win ? DOMPurify(win as unknown as Parameters<typeof DOMPurify>[0]) : DOMPurify;
  if (!purifier.isSupported) return fallbackStrip(html);
  return purifier.sanitize(html, {
    USE_PROFILES: { html: true, svg: true },
    FORBID_TAGS: ["script", "iframe", "object", "embed", "link", "meta", "form", "style"],
    ADD_TAGS: ["math-src", "input"],
    ADD_ATTR: ["display", "disabled", "checked", "type", "hidden", "open"],
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: URI_OK,
  });
}

function fallbackStrip(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/?(iframe|object|embed|link|meta|form)\b[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(["']).*?\1/gi, "")
    .replace(/\s(href|src)\s*=\s*(["'])\s*(?:javascript|vbscript|data|file):[\s\S]*?\2/gi, "");
}

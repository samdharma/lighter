import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import type { Heading } from "./text";
import { classifyHref } from "./text";
import { renderMarkdown } from "./render";

type Props = {
  docId: number;
  origin: string;
  text: string;
  truncated: boolean;
  mode: "rendered" | "raw";
  zoom: number;
  allowRemote: boolean;
  query: string;
  cursor: number;
  onCount: (count: number, running: boolean) => void;
  onHeadings: (headings: Heading[]) => void;
  onLink: (href: string) => void;
  onBlocked: (href: string) => void;
};

type LangModule = { default: (hljs: import("highlight.js").HLJSApi) => unknown };

const LANG_LOADERS: Record<string, () => Promise<LangModule>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  php: () => import("highlight.js/lib/languages/php"),
  python: () => import("highlight.js/lib/languages/python"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  shell: () => import("highlight.js/lib/languages/bash"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const LANG_ALIAS: Record<string, string> = {
  sh: "bash",
  zsh: "bash",
  console: "bash",
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  py: "python",
  rs: "rust",
  yml: "yaml",
  html: "xml",
  svg: "xml",
  md: "markdown",
  toml: "ini",
  docker: "dockerfile",
  "c++": "cpp",
  h: "c",
};

export function MarkdownView(props: Props) {
  if (props.mode === "raw") {
    return (
      <RawView
        text={props.text}
        truncated={props.truncated}
        zoom={props.zoom}
        query={props.query}
        cursor={props.cursor}
        onCount={props.onCount}
        onHeadings={props.onHeadings}
      />
    );
  }
  return <RenderedView {...props} />;
}

function RenderedView(props: Props) {
  const ref = useRef<HTMLElement>(null);
  const html = useMemo(() => {
    if (!props.text) return { html: "", headings: [], needsMath: false, needsMermaid: false };
    return renderMarkdown(props.text, {
      docId: props.docId,
      origin: props.origin,
      allowRemote: props.allowRemote,
    });
  }, [props.text, props.docId, props.origin, props.allowRemote]);

  useEffect(() => {
    props.onHeadings(html.headings);
  }, [html.headings]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    root.innerHTML = html.html || "<p class=\"empty-doc\">This file is empty.</p>";
    let cancel = false;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;
      const copy = target.closest("button[data-copy]");
      if (copy) {
        const code = copy.closest(".code-block")?.querySelector("code")?.textContent ?? "";
        void navigator.clipboard?.writeText(code);
        copy.textContent = "Copied";
        window.setTimeout(() => {
          copy.textContent = "Copy";
        }, 1200);
        return;
      }
      const action = target.closest<HTMLButtonElement>("button[data-act]");
      const figure = target.closest<HTMLElement>(".diagram");
      if (action && figure) {
        event.preventDefault();
        applyDiagramAction(figure, action.dataset.act ?? "");
        return;
      }
      const link = target.closest("a");
      if (!link) return;
      const href = link.getAttribute("href") ?? "";
      const kind = classifyHref(href);
      if (kind === "anchor") return;
      event.preventDefault();
      if (kind === "external") props.onLink(href);
      else props.onBlocked(href);
    };
    root.addEventListener("click", onClick);
    void enhance(root, () => cancel);
    return () => {
      cancel = true;
      root.removeEventListener("click", onClick);
    };
  }, [html.html, props.docId]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const total = markMatches(root, props.query, props.cursor);
    props.onCount(total, false);
  }, [html.html, props.query, props.cursor]);

  return (
    <article
      ref={ref}
      class="markdown"
      style={{ fontSize: `${(1.05 * props.zoom).toFixed(3)}rem` }}
      tabIndex={0}
    />
  );
}

async function enhance(root: HTMLElement, cancelled: () => boolean): Promise<void> {
  await highlightCode(root, cancelled);
  if (cancelled()) return;
  if (root.querySelector("math-src")) {
    const katex = (await import("katex")).default;
    await import("katex/dist/katex.min.css");
    if (cancelled()) return;
    root.querySelectorAll("math-src").forEach((node) => {
      const tex = node.textContent ?? "";
      const display = node.getAttribute("display") === "block";
      const host = document.createElement(display ? "div" : "span");
      host.className = display ? "math-block" : "math-inline";
      try {
        katex.render(tex, host, {
          throwOnError: true,
          output: "html",
          trust: false,
          displayMode: display,
        });
      } catch {
        host.classList.add("math-error");
        host.textContent = tex;
        const note = document.createElement("span");
        note.className = "math-note";
        note.textContent = " Invalid math";
        host.append(note);
      }
      node.replaceWith(host);
    });
  }
  if (cancelled() || !root.querySelector(".mermaid-src")) return;
  const mermaid = (await import("mermaid")).default;
  if (cancelled()) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: document.documentElement.dataset.theme === "dark" ? "dark" : "neutral",
    fontFamily: "inherit",
  });
  const blocks = [...root.querySelectorAll<HTMLElement>(".mermaid-src")];
  const queue: HTMLElement[] = [];
  let active = 0;
  const pump = () => {
    while (active < 2 && queue.length) {
      const el = queue.shift();
      if (!el) break;
      active += 1;
      void renderMermaid(mermaid, el)
        .catch(() => undefined)
        .finally(() => {
          active -= 1;
          if (!cancelled()) pump();
        });
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        queue.push(entry.target as HTMLElement);
        pump();
      }
    },
    { root: null, rootMargin: "240px 0px" },
  );
  for (const block of blocks) observer.observe(block);
}

async function renderMermaid(mermaid: { render: (id: string, code: string) => Promise<{ svg: string }> }, el: HTMLElement) {
  const code = el.textContent ?? "";
  const stage = el.parentElement;
  try {
    const rendered = await mermaid.render(`mmd-${Math.random().toString(36).slice(2)}`, code);
    if (rendered.svg.toLowerCase().includes("<script")) {
      throw new Error("script");
    }
    if (stage) stage.innerHTML = rendered.svg;
  } catch {
    const note = document.createElement("p");
    note.className = "diagram-error";
    note.textContent = "This diagram could not be drawn. The source is unchanged.";
    el.insertAdjacentElement("afterend", note);
  }
}

async function highlightCode(root: HTMLElement, cancelled: () => boolean): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>(".code-block")];
  if (!blocks.length) return;
  const hljs = (await import("highlight.js/lib/core")).default;
  const seen = new Set<string>();
  for (const block of blocks) {
    if (cancelled()) return;
    const requested = (block.dataset.lang ?? "text").toLowerCase();
    const lang = LANG_ALIAS[requested] ?? requested;
    const code = block.querySelector("code");
    if (!code) continue;
    const loader = LANG_LOADERS[lang];
    if (!loader) continue;
    if (!seen.has(lang)) {
      const mod = await loader();
      hljs.registerLanguage(lang, mod.default as never);
      seen.add(lang);
    }
    if (cancelled()) return;
    code.innerHTML = hljs.highlight(code.textContent ?? "", { language: lang }).value;
    code.classList.add("hljs");
  }
}

function applyDiagramAction(figure: HTMLElement, act: string): void {
  const stage = figure.querySelector<HTMLElement>(".diagram-stage");
  const svg = stage?.querySelector("svg");
  const source = figure.querySelector<HTMLElement>(".diagram-source");
  let zoom = Number(figure.dataset.zoom || "1");
  if (act === "in") zoom = Math.min(4, zoom * 1.2);
  if (act === "out") zoom = Math.max(0.3, zoom / 1.2);
  if (act === "reset" || act === "fit") zoom = 1;
  figure.dataset.zoom = zoom.toFixed(3);
  if (svg) {
    svg.style.transformOrigin = "top left";
    svg.style.transform = zoom === 1 ? "" : `scale(${zoom})`;
  }
  if (act === "source" && source) source.hidden = !source.hidden;
}

function markMatches(root: HTMLElement, query: string, cursor: number): number {
  root.querySelectorAll("mark").forEach((mark) => {
    mark.replaceWith(document.createTextNode(mark.textContent ?? ""));
  });
  root.normalize();
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current: Node | null = walker.nextNode();
  while (current) {
    const parent = (current as Text).parentElement;
    if (parent && !parent.closest(".diagram-source, .front-matter")) nodes.push(current as Text);
    current = walker.nextNode();
  }
  let total = 0;
  for (const node of nodes) {
    const value = node.nodeValue ?? "";
    const lower = value.toLowerCase();
    if (!lower.includes(needle)) continue;
    const frag = document.createDocumentFragment();
    let start = 0;
    let at = lower.indexOf(needle);
    while (at >= 0) {
      frag.append(value.slice(start, at));
      const mark = document.createElement("mark");
      mark.textContent = value.slice(at, at + needle.length);
      if (total === cursor) mark.className = "current";
      frag.append(mark);
      total += 1;
      start = at + needle.length;
      at = lower.indexOf(needle, start);
      if (total > 800) break;
    }
    frag.append(value.slice(start));
    node.replaceWith(frag);
    if (total > 800) break;
  }
  root.querySelector("mark.current")?.scrollIntoView({ block: "center" });
  return total;
}

function RawView(props: {
  text: string;
  truncated: boolean;
  zoom: number;
  query: string;
  cursor: number;
  onCount: (count: number, running: boolean) => void;
  onHeadings: (headings: Heading[]) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => findIndexes(props.text, props.query), [props.text, props.query]);
  useEffect(() => {
    props.onHeadings([]);
    props.onCount(matches.length, false);
  }, [matches.length, props.text]);
  const active = matches[Math.min(props.cursor, Math.max(matches.length - 1, 0))] ?? -1;
  const lines = useMemo(() => props.text.split(/\r?\n/), [props.text]);
  const activeLine = useMemo(() => {
    if (active < 0) return -1;
    let offset = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const next = offset + lines[i].length + 1;
      if (active < next) return i;
      offset = next;
    }
    return lines.length - 1;
  }, [active, lines]);

  useEffect(() => {
    if (activeLine < 0) return;
    scroller.current?.querySelector(`[data-line="${activeLine}"]`)?.scrollIntoView({ block: "center" });
  }, [activeLine, props.cursor]);

  const numbered = lines.length <= 8000;
  return (
    <div class="raw-wrap" ref={scroller}>
      {props.truncated ? <p class="banner">Showing the first part of a very large text file.</p> : null}
      {numbered ? (
        <ol class="raw" style={{ fontSize: `${(0.92 * props.zoom).toFixed(3)}rem` }}>
          {lines.map((line, index) => (
            <li key={index} data-line={index} class={index === activeLine ? "raw-current" : ""}>
              {index === activeLine && active >= 0 ? highlightLine(line, props.text, active, props.query) : line || " "}
            </li>
          ))}
        </ol>
      ) : (
        <pre class="raw raw-plain" style={{ fontSize: `${(0.92 * props.zoom).toFixed(3)}rem` }}>
          {props.text}
        </pre>
      )}
    </div>
  );
}

function highlightLine(line: string, full: string, active: number, query: string): ComponentChildren {
  const before = full.slice(0, active).split(/\r?\n/).pop() ?? "";
  const start = before.length;
  const end = start + query.trim().length;
  if (end > line.length || start < 0) return line;
  return (
    <>
      {line.slice(0, start)}
      <mark class="current">{line.slice(start, end)}</mark>
      {line.slice(end)}
    </>
  );
}

function findIndexes(text: string, query: string): number[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hay = text.toLowerCase();
  const found: number[] = [];
  let index = 0;
  while (index < hay.length && found.length < 5000) {
    const at = hay.indexOf(needle, index);
    if (at < 0) break;
    found.push(at);
    index = at + needle.length;
  }
  return found;
}

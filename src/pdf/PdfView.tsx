import { useEffect, useRef, useState } from "preact/hooks";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { confirmOpenExternal, errorText, markPerf, reclassifyFailedPdf } from "../lib/bridge";
import type { Opened, OutlineItem, ScaleMode } from "../types";

type Hit = { page: number; item: number };

type Props = {
  doc: Opened;
  origin: string;
  viewMode: "continuous" | "single";
  scaleMode: ScaleMode;
  scale: number;
  rotation: number;
  query: string;
  cursor: number;
  pageRequest: { page: number; token: number } | null;
  initialPage: number | null;
  onMetrics: (metrics: { page: number; pages: number; scale: number }) => void;
  onOutline: (items: OutlineItem[]) => void;
  onCount: (count: number, running: boolean) => void;
  onReclassified: (info: Opened) => void;
  onError: (message: string) => void;
};

type PasswordPrompt = {
  incorrect: boolean;
  submit: (password: string | null) => void;
};

export function PdfView(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const hitsRef = useRef<Hit[]>([]);
  const [prompt, setPrompt] = useState<PasswordPrompt | null>(null);
  const [status, setStatus] = useState("Opening PDF…");
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let destroyed = false;
    let loading: { destroy: () => Promise<void> } | null = null;
    const renders = new Set<RenderTask>();
    setFailed(null);
    setStatus("Opening PDF…");
    pdfRef.current = null;

    const run = async () => {
      const pdfjs = await import("pdfjs-dist");
      if (destroyed) return;
      const worker = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const renderer = new URL("pdfjs-dist/build/pdf.renderer.min.mjs", import.meta.url).toString();
      pdfjs.GlobalWorkerOptions.workerSrc = worker;
      pdfjs.GlobalWorkerOptions.rendererSrc = renderer;
      const assetBase = `${import.meta.env.BASE_URL}`;
      const transport = new pdfjs.PDFDataRangeTransport(props.doc.len, null);
      transport.requestDataRange = (begin, end) => {
        const last = Math.max(begin, end - 1);
        fetch(`${props.origin}/doc/${props.doc.id}`, {
          headers: { Range: `bytes=${begin}-${last}` },
        })
          .then(async (response) => {
            if (!response.ok && response.status !== 206) {
              throw new Error(`Could not read bytes ${begin}-${last} (${response.status}).`);
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (!destroyed) transport.onDataRange(begin, bytes);
          })
          .catch((err: unknown) => {
            if (!destroyed) setStatus(errorText(err));
          });
      };

      const task = pdfjs.getDocument({
        range: transport,
        rangeChunkSize: 65536,
        disableStream: true,
        disableAutoFetch: true,
        disableRange: false,
        enableXfa: false,
        stopAtErrors: false,
        cMapUrl: `${assetBase}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${assetBase}standard_fonts/`,
        wasmUrl: `${assetBase}wasm/`,
        iccUrl: `${assetBase}iccs/`,
        useSystemFonts: true,
      });
      loading = task;
      task.onPassword = (update: (password: string) => void, reason: number) => {
        if (destroyed) return;
        setPrompt({
          incorrect: reason === pdfjs.PasswordResponses.INCORRECT_PASSWORD,
          submit: (password) => {
            setPrompt(null);
            if (password == null) {
              void task.destroy();
              props.onError("This PDF is password-protected.");
              return;
            }
            update(password);
          },
        });
      };

      let pdf: PDFDocumentProxy;
      try {
        pdf = await task.promise;
      } catch (err) {
        if (destroyed) return;
        const name = err && typeof err === "object" && "name" in err ? String((err as { name: string }).name) : "";
        if (name === "InvalidPDFException" || name === "UnknownErrorException") {
          try {
            const next = await reclassifyFailedPdf(props.doc.id);
            if (!destroyed) props.onReclassified(next);
            return;
          } catch (fallback) {
            if (!destroyed) {
              const message = errorText(fallback);
              setFailed(message);
              props.onError(message);
            }
            return;
          }
        }
        const message = name === "PasswordException" ? "This PDF is password-protected." : errorText(err);
        setFailed(message);
        props.onError(message);
        return;
      }
      if (destroyed) {
        await pdf.loadingTask.destroy();
        return;
      }
      pdfRef.current = pdf;
      setStatus("");
      const first = await pdf.getPage(1);
      if (destroyed) return;
      const base = first.getViewport({ scale: 1, rotation: normalize(first.rotate + props.rotation) });
      const effective = resolveScale(props.scaleMode, props.scale, base.width, base.height, scroll);
      await paintDocument({
        pdf,
        scroll,
        pdfjs,
        viewMode: props.viewMode,
        rotation: props.rotation,
        scale: effective,
        page: props.initialPage && props.initialPage > 0 ? props.initialPage : 1,
        renders,
        destroyed: () => destroyed,
        onPage: (page) => props.onMetrics({ page, pages: pdf.numPages, scale: effective }),
      });
      props.onMetrics({ page: props.initialPage || 1, pages: pdf.numPages, scale: effective });
      void markPerf("pdf_first_page");
      void loadOutline(pdf, props.onOutline);
    };

    void run();
    return () => {
      destroyed = true;
      renders.forEach((task) => task.cancel());
      void loading?.destroy();
      void pdfRef.current?.loadingTask.destroy();
      pdfRef.current = null;
    };
  }, [props.doc.id, props.origin]);

  useEffect(() => {
    const pdf = pdfRef.current;
    const scroll = scrollRef.current;
    if (!pdf || !scroll || failed) return;
    let destroyed = false;
    const renders = new Set<RenderTask>();
    const apply = async () => {
      const pdfjs = await import("pdfjs-dist");
      const pageNo = currentPage(scroll);
      const page = await pdf.getPage(pageNo);
      const base = page.getViewport({ scale: 1, rotation: normalize(page.rotate + props.rotation) });
      const effective = resolveScale(props.scaleMode, props.scale, base.width, base.height, scroll);
      await paintDocument({
        pdf,
        scroll,
        pdfjs,
        viewMode: props.viewMode,
        rotation: props.rotation,
        scale: effective,
        page: props.pageRequest?.page || pageNo,
        renders,
        destroyed: () => destroyed,
        onPage: (pageNumber) => props.onMetrics({ page: pageNumber, pages: pdf.numPages, scale: effective }),
      });
      paintHitClasses(scroll, hitsRef.current, props.cursor);
    };
    void apply();
    return () => {
      destroyed = true;
      renders.forEach((task) => task.cancel());
    };
  }, [props.viewMode, props.scaleMode, props.scale, props.rotation, props.pageRequest?.token]);

  useEffect(() => {
    const pdf = pdfRef.current;
    if (!pdf) return;
    let cancelled = false;
    const query = props.query.trim();
    hitsRef.current = [];
    props.onCount(0, Boolean(query));
    if (!query) {
      paintHitClasses(scrollRef.current, [], 0);
      return;
    }
    const generation = Symbol();
    void (async () => {
      const hits: Hit[] = [];
      const needle = query.toLowerCase();
      for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
        if (cancelled) return;
        const page = await pdf.getPage(pageNo);
        const content = await page.getTextContent();
        content.items.forEach((item, itemIndex) => {
          if (!("str" in item)) return;
          if (item.str.toLowerCase().includes(needle)) hits.push({ page: pageNo, item: itemIndex });
        });
        if (pageNo % 2 === 0) {
          props.onCount(hits.length, true);
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
      }
      if (cancelled) return;
      hitsRef.current = hits;
      props.onCount(hits.length, false);
      const hit = hits[props.cursor] ?? hits[0];
      if (hit) scrollRef.current?.querySelector(`[data-page="${hit.page}"]`)?.scrollIntoView({ block: "center" });
      paintHitClasses(scrollRef.current, hits, props.cursor);
      void generation;
    })();
    return () => {
      cancelled = true;
    };
  }, [props.query, props.doc.id]);

  useEffect(() => {
    const hit = hitsRef.current[props.cursor];
    if (!hit) return;
    scrollRef.current?.querySelector(`[data-page="${hit.page}"]`)?.scrollIntoView({ block: "center" });
    paintHitClasses(scrollRef.current, hitsRef.current, props.cursor);
  }, [props.cursor]);

  return (
    <div class="pdf-scroll" ref={scrollRef} onScroll={onScroll}>
      {failed ? <p class="banner error">{failed}</p> : null}
      {!failed && status ? <p class="banner">{status}</p> : null}
      {prompt ? (
        <form
          class="modal"
          aria-labelledby="pdf-password-title"
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            prompt.submit(String(data.get("password") ?? ""));
          }}
        >
          <h2 id="pdf-password-title">Password required</h2>
          <p>{prompt.incorrect ? "That password was not accepted." : "This PDF asks for a password. It is not saved."}</p>
          <input name="password" type="password" autoFocus aria-label="PDF password" />
          <div class="modal-actions">
            <button type="button" onClick={() => prompt.submit(null)}>
              Cancel
            </button>
            <button type="submit" class="primary">
              Unlock
            </button>
          </div>
        </form>
      ) : null}
    </div>
  );

  function onScroll() {
    const scroll = scrollRef.current;
    const pdf = pdfRef.current;
    if (!scroll || !pdf) return;
    props.onMetrics({
      page: currentPage(scroll),
      pages: pdf.numPages,
      scale: props.scale,
    });
  }
}

function normalize(value: number): number {
  return ((value % 360) + 360) % 360;
}

function resolveScale(mode: ScaleMode, custom: number, pageWidth: number, pageHeight: number, scroll: HTMLElement): number {
  if (mode === "actual") return 1;
  if (mode === "custom") return clampScale(custom);
  const width = Math.max(scroll.clientWidth - 48, 200);
  const height = Math.max(scroll.clientHeight - 48, 200);
  if (mode === "fit-width") return clampScale(width / pageWidth);
  return clampScale(Math.min(width / pageWidth, height / pageHeight));
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(6, Math.max(0.25, value));
}

function currentPage(scroll: HTMLElement): number {
  const pages = [...scroll.querySelectorAll<HTMLElement>("[data-page]")];
  if (!pages.length) return 1;
  const top = scroll.getBoundingClientRect().top;
  let best = pages[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const page of pages) {
    if (page.hidden) continue;
    const delta = Math.abs(page.getBoundingClientRect().top - top - 12);
    if (delta < bestDelta) {
      best = page;
      bestDelta = delta;
    }
  }
  return Number(best.dataset.page || "1");
}

async function paintDocument(args: {
  pdf: PDFDocumentProxy;
  scroll: HTMLDivElement;
  pdfjs: typeof import("pdfjs-dist");
  viewMode: "continuous" | "single";
  rotation: number;
  scale: number;
  page: number;
  renders: Set<RenderTask>;
  destroyed: () => boolean;
  onPage: (page: number) => void;
}): Promise<void> {
  const { pdf, scroll, pdfjs } = args;
  const keepScroll = scroll.scrollTop;
  scroll.querySelectorAll("[data-page]").forEach((node) => node.remove());
  const slots: HTMLElement[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const slot = document.createElement("article");
    slot.className = "pdf-page";
    slot.dataset.page = String(number);
    slot.style.minHeight = "960px";
    const label = document.createElement("p");
    label.className = "pdf-page-label";
    label.textContent = String(number);
    slot.append(label);
    if (args.viewMode === "single" && number !== args.page) slot.hidden = true;
    scroll.append(slot);
    slots.push(slot);
  }
  const target = Math.min(Math.max(args.page, 1), pdf.numPages);
  slots[target - 1]?.scrollIntoView();
  if (keepScroll && args.viewMode === "continuous" && args.page === currentPage(scroll)) {
    scroll.scrollTop = keepScroll;
  }

  const renderSlot = async (slot: HTMLElement) => {
    if (args.destroyed() || slot.dataset.ready === "1") return;
    const number = Number(slot.dataset.page);
    const page = await pdf.getPage(number);
    if (args.destroyed()) return;
    const viewport = page.getViewport({
      scale: args.scale,
      rotation: normalize(page.rotate + args.rotation),
    });
    slot.style.minHeight = "";
    slot.style.width = `${viewport.width}px`;
    slot.style.height = `${viewport.height}px`;
    const canvas = document.createElement("canvas");
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    let pixelWidth = Math.floor(viewport.width * ratio);
    let pixelHeight = Math.floor(viewport.height * ratio);
    const maxPixels = 8_000_000;
    if (pixelWidth * pixelHeight > maxPixels) {
      const factor = Math.sqrt(maxPixels / (pixelWidth * pixelHeight));
      pixelWidth = Math.floor(pixelWidth * factor);
      pixelHeight = Math.floor(pixelHeight * factor);
    }
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    slot.append(canvas);
    const task = page.render({
      canvas,
      viewport,
      transform: [pixelWidth / viewport.width, 0, 0, pixelHeight / viewport.height, 0, 0],
      annotationMode: pdfjs.AnnotationMode.ENABLE,
    });
    args.renders.add(task);
    try {
      await task.promise;
    } catch {
      return;
    } finally {
      args.renders.delete(task);
    }
    if (args.destroyed()) return;
    slot.dataset.ready = "1";
    const textHost = document.createElement("div");
    textHost.className = "textLayer";
    slot.append(textHost);
    const textLayer = new pdfjs.TextLayer({
      textContentSource: await page.getTextContent(),
      container: textHost,
      viewport,
    });
    await textLayer.render();
    textLayer.textDivs.forEach((div, index) => div.dataset.item = String(index));
    const annotations = await page.getAnnotations({ intent: "display" });
    for (const annotation of annotations) {
      if (annotation.subtype !== "Link" || !annotation.rect) continue;
      const rect = annotation.rect as number[];
      const [x1, y1] = viewport.convertToViewportPoint(rect[0], rect[1]);
      const [x2, y2] = viewport.convertToViewportPoint(rect[2], rect[3]);
      const link = document.createElement("a");
      link.className = "pdf-link";
      link.href = annotation.url || "#";
      link.style.left = `${Math.min(x1, x2)}px`;
      link.style.top = `${Math.min(y1, y2)}px`;
      link.style.width = `${Math.abs(x2 - x1)}px`;
      link.style.height = `${Math.abs(y2 - y1)}px`;
      if (annotation.url) {
        link.dataset.external = annotation.url;
        link.addEventListener("click", (event) => {
          event.preventDefault();
          const ok = window.confirm(`Open this link in your browser?\n\n${annotation.url}`);
          if (ok) void confirmOpenExternal(annotation.url);
        });
      } else if (annotation.dest) {
        link.addEventListener("click", (event) => {
          event.preventDefault();
          void followDest(pdf, annotation.dest, scroll);
        });
      }
      slot.append(link);
    }
    if (number === 1) args.onPage(1);
  };

  await renderSlot(slots[0] ?? slots[target - 1]);
  if (args.viewMode === "single") {
    const slot = slots[target - 1];
    if (slot && slot !== slots[0]) await renderSlot(slot);
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const slot = entry.target as HTMLElement;
        if (entry.isIntersecting) void renderSlot(slot);
        else if (slot.dataset.ready === "1") {
          slot.querySelector("canvas")?.remove();
          slot.querySelector(".textLayer")?.remove();
          delete slot.dataset.ready;
        }
      }
    },
    { root: scroll, rootMargin: "35% 0px" },
  );
  for (const slot of slots) observer.observe(slot);
}

async function followDest(pdf: PDFDocumentProxy, dest: unknown, scroll: HTMLElement): Promise<void> {
  const explicit = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit) || !explicit[0]) return;
  const index = await pdf.getPageIndex(explicit[0]);
  scroll.querySelector(`[data-page="${index + 1}"]`)?.scrollIntoView({ block: "start" });
}

async function loadOutline(pdf: PDFDocumentProxy, publish: (items: OutlineItem[]) => void): Promise<void> {
  const outline = await pdf.getOutline();
  publish(outline ? await mapOutline(pdf, outline) : []);
}

async function mapOutline(
  pdf: PDFDocumentProxy,
  nodes: Array<{ title: string; dest: string | unknown[] | null; url: string | null; items: Array<unknown> }>,
): Promise<OutlineItem[]> {
  const items: OutlineItem[] = [];
  for (const node of nodes) {
    let page: number | null = null;
    try {
      const dest = typeof node.dest === "string" ? await pdf.getDestination(node.dest) : node.dest;
      if (Array.isArray(dest) && dest[0]) page = (await pdf.getPageIndex(dest[0])) + 1;
    } catch {
      page = null;
    }
    items.push({
      title: node.title,
      page,
      items: await mapOutline(pdf, (node.items ?? []) as never),
    });
  }
  return items;
}

function paintHitClasses(scroll: HTMLElement | null, hits: Hit[], cursor: number): void {
  if (!scroll) return;
  scroll.querySelectorAll(".pdf-hit, .pdf-hit-current").forEach((node) => {
    node.classList.remove("pdf-hit", "pdf-hit-current");
  });
  const current = hits[cursor];
  for (const hit of hits) {
    const slot = scroll.querySelector(`[data-page="${hit.page}"]`);
    const span = slot?.querySelector(`[data-item="${hit.item}"]`);
    if (!span) continue;
    span.classList.add("pdf-hit");
    if (current && current.page === hit.page && current.item === hit.item) span.classList.add("pdf-hit-current");
  }
}

import { useEffect, useRef, useState } from "preact/hooks";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import { confirmOpenExternal, errorText, markPerf, reclassifyFailedPdf } from "../lib/bridge";
import { PageCache } from "../lib/pageCache";
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

const CACHE_PAGES = 16;
const RENDER_AHEAD = "125% 0px";
const FLING_VELOCITY = 1.2; // px per ms; above this, defer rendering
const SETTLE_MS = 150;
const REPAINT_DEBOUNCE_MS = 140;

export function PdfView(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pdfRef = useRef<PDFDocumentProxy | null>(null);
  const hitsRef = useRef<Hit[]>([]);
  const pageRef = useRef(1);
  const paintedScaleRef = useRef(0);
  const zoomPendingRef = useRef(false);
  const repaintTimer = useRef<number | undefined>(undefined);
  const prevDeps = useRef<{ viewMode: string; scaleMode: string; rotation: number; token: number } | null>(null);
  const [prompt, setPrompt] = useState<PasswordPrompt | null>(null);
  const [status, setStatus] = useState("Opening PDF…");
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    let destroyed = false;
    let loading: { destroy: () => Promise<void> } | null = null;
    const renders = new Set<RenderTask>();
    const cleanups: Array<() => void> = [];
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
      const startPage = props.initialPage && props.initialPage > 0 ? props.initialPage : 1;
      pageRef.current = startPage;
      paintedScaleRef.current = effective;
      prevDeps.current = {
        viewMode: props.viewMode,
        scaleMode: props.scaleMode,
        rotation: props.rotation,
        token: props.pageRequest?.token ?? 0,
      };
      await paintDocument({
        pdf,
        scroll,
        pdfjs,
        viewMode: props.viewMode,
        rotation: props.rotation,
        scale: effective,
        estimate: { width: base.width * effective, height: base.height * effective },
        page: startPage,
        renders,
        cleanups,
        destroyed: () => destroyed,
        zoomPending: zoomPendingRef,
        onPage: (page) => {
          pageRef.current = page;
          props.onMetrics({ page, pages: pdf.numPages, scale: effective });
        },
      });
      props.onMetrics({ page: startPage, pages: pdf.numPages, scale: effective });
      void markPerf("pdf_first_page");
      void loadOutline(pdf, props.onOutline);
    };

    void run();
    return () => {
      destroyed = true;
      cleanups.forEach((fn) => fn());
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
    const cleanups: Array<() => void> = [];
    const prev = prevDeps.current;
    const next = {
      viewMode: props.viewMode,
      scaleMode: props.scaleMode,
      rotation: props.rotation,
      token: props.pageRequest?.token ?? 0,
    };
    prevDeps.current = next;
    const onlyScale =
      prev !== null &&
      paintedScaleRef.current > 0 &&
      prev.viewMode === next.viewMode &&
      prev.scaleMode === next.scaleMode &&
      prev.rotation === next.rotation &&
      prev.token === next.token;

    const apply = async () => {
      zoomPendingRef.current = false;
      const pdfjs = await import("pdfjs-dist");
      const pageNo = pageRef.current;
      const page = await pdf.getPage(pageNo);
      if (destroyed) return;
      const base = page.getViewport({ scale: 1, rotation: normalize(page.rotate + props.rotation) });
      const effective = resolveScale(props.scaleMode, props.scale, base.width, base.height, scroll);
      paintedScaleRef.current = effective;
      await paintDocument({
        pdf,
        scroll,
        pdfjs,
        viewMode: props.viewMode,
        rotation: props.rotation,
        scale: effective,
        estimate: { width: base.width * effective, height: base.height * effective },
        page: props.pageRequest?.page || pageNo,
        renders,
        cleanups,
        destroyed: () => destroyed,
        zoomPending: zoomPendingRef,
        onPage: (pageNumber) => {
          pageRef.current = pageNumber;
          props.onMetrics({ page: pageNumber, pages: pdf.numPages, scale: effective });
        },
      });
      paintHitClasses(scroll, hitsRef.current, props.cursor);
    };

    if (onlyScale && props.scaleMode === "custom") {
      // Gesture/keyboard zoom: stretch rendered pages with a CSS transform for
      // instant feedback, then repaint crisply once the gesture settles.
      const target = clampScale(props.scale);
      previewZoom(scroll, target / paintedScaleRef.current);
      zoomPendingRef.current = true;
      repaintTimer.current = window.setTimeout(() => void apply(), REPAINT_DEBOUNCE_MS);
      return () => {
        destroyed = true;
        window.clearTimeout(repaintTimer.current);
      };
    }
    void apply();
    return () => {
      destroyed = true;
      cleanups.forEach((fn) => fn());
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
    <div class="pdf-scroll" ref={scrollRef}>
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

function previewZoom(scroll: HTMLElement, ratio: number): void {
  if (!Number.isFinite(ratio) || ratio <= 0) return;
  scroll.querySelectorAll<HTMLElement>("[data-page]").forEach((slot) => {
    slot.style.transformOrigin = "50% 0";
    slot.style.transform = ratio === 1 ? "" : `scale(${ratio})`;
  });
}

async function paintDocument(args: {
  pdf: PDFDocumentProxy;
  scroll: HTMLDivElement;
  pdfjs: typeof import("pdfjs-dist");
  viewMode: "continuous" | "single";
  rotation: number;
  scale: number;
  estimate: { width: number; height: number };
  page: number;
  renders: Set<RenderTask>;
  cleanups: Array<() => void>;
  destroyed: () => boolean;
  zoomPending: { current: boolean };
  onPage: (page: number) => void;
}): Promise<void> {
  const { pdf, scroll, pdfjs } = args;
  scroll.querySelectorAll("[data-page]").forEach((node) => node.remove());
  const slots: HTMLElement[] = [];
  const offsets: number[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const slot = document.createElement("article");
    slot.className = "pdf-page";
    slot.dataset.page = String(number);
    slot.style.width = `${args.estimate.width}px`;
    slot.style.height = `${args.estimate.height}px`;
    const label = document.createElement("p");
    label.className = "pdf-page-label";
    label.textContent = String(number);
    slot.append(label);
    if (args.viewMode === "single" && number !== args.page) slot.hidden = true;
    scroll.append(slot);
    slots.push(slot);
  }

  const syncOffsets = () => {
    offsets.length = 0;
    const base = slots[0]?.offsetTop ?? 0;
    for (const slot of slots) offsets.push(slot.offsetTop - base);
  };
  syncOffsets();

  const locate = (): number => {
    if (args.viewMode === "single" || !offsets.length) return args.page;
    const target = scroll.scrollTop + 24;
    let low = 0;
    let high = offsets.length - 1;
    let best = 0;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (offsets[mid] <= target) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best + 1;
  };

  const cache = new PageCache<HTMLElement>(CACHE_PAGES, (slot) => {
    slot.querySelectorAll("canvas, .textLayer, .pdf-link").forEach((node) => node.remove());
    delete slot.dataset.ready;
  });
  args.cleanups.push(() => cache.clear());

  const renderSlot = async (slot: HTMLElement) => {
    if (args.destroyed() || slot.dataset.ready === "1") return;
    const number = Number(slot.dataset.page);
    const page = await pdf.getPage(number);
    if (args.destroyed()) return;
    const viewport = page.getViewport({
      scale: args.scale,
      rotation: normalize(page.rotate + args.rotation),
    });
    slot.style.width = `${viewport.width}px`;
    slot.style.height = `${viewport.height}px`;
    syncOffsets();
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
    cache.set(number, slot, locate());
  };

  const target = Math.min(Math.max(args.page, 1), pdf.numPages);
  slots[target - 1]?.scrollIntoView();
  await renderSlot(slots[target - 1] ?? slots[0]);
  args.onPage(locate());

  const pending = new Set<HTMLElement>();
  let flinging = false;
  let lastTop = scroll.scrollTop;
  let lastTime = performance.now();
  let settleTimer = 0;
  let rafId = 0;

  const settle = () => {
    flinging = false;
    if (args.destroyed()) return;
    for (const slot of pending) void renderSlot(slot);
    pending.clear();
    args.onPage(locate());
  };

  const onScroll = () => {
    const now = performance.now();
    const dy = Math.abs(scroll.scrollTop - lastTop);
    const dt = Math.max(now - lastTime, 1);
    lastTop = scroll.scrollTop;
    lastTime = now;
    if (dy / dt > FLING_VELOCITY) {
      flinging = true;
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(settle, SETTLE_MS);
    }
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      if (!args.destroyed()) args.onPage(locate());
    });
  };
  scroll.addEventListener("scroll", onScroll, { passive: true });
  args.cleanups.push(() => {
    scroll.removeEventListener("scroll", onScroll);
    window.clearTimeout(settleTimer);
    if (rafId) cancelAnimationFrame(rafId);
  });

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const slot = entry.target as HTMLElement;
        if (!entry.isIntersecting) {
          pending.delete(slot);
          continue;
        }
        if (flinging || args.zoomPending.current) pending.add(slot);
        else void renderSlot(slot);
      }
    },
    { root: scroll, rootMargin: RENDER_AHEAD },
  );
  for (const slot of slots) observer.observe(slot);
  args.cleanups.push(() => observer.disconnect());
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

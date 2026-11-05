import { useEffect, useRef, useState } from "preact/hooks";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { MarkdownView } from "./markdown/MarkdownView";
import type { Heading } from "./markdown/text";
import { PdfView } from "./pdf/PdfView";
import { clampZoom, zoomFromGesture, zoomFromWheel } from "./lib/zoom";
import {
  clearRecent,
  closeDocument,
  confirmOpenExternal,
  errorText,
  getSettings,
  inShell,
  markPerf,
  markdownText,
  openPath,
  pickPath,
  readerOrigin,
  rememberPosition,
  sessionState,
  setRemoteAllowed,
  updateSettings,
} from "./lib/bridge";
import type { Opened, OutlineItem, ScaleMode, Settings } from "./types";

type Phase =
  | { kind: "empty" }
  | { kind: "loading"; name: string }
  | { kind: "error"; message: string }
  | { kind: "pdf"; info: Opened }
  | { kind: "md"; info: Opened; text: string; truncated: boolean };

const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  zoom: 1,
  pdfView: "continuous",
  markdownMode: "rendered",
  windowWidth: 1100,
  windowHeight: 780,
  windowX: null,
  windowY: null,
  maximized: false,
  recent: [],
  positions: [],
  remoteAllowed: [],
  chromeAutoHide: true,
  gestureZoom: true,
};

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [origin, setOrigin] = useState("reader://localhost");
  const [phase, setPhase] = useState<Phase>({ kind: "empty" });
  const [rail, setRail] = useState(false);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const [searching, setSearching] = useState(false);
  const [scaleMode, setScaleMode] = useState<ScaleMode>("custom");
  const [rotation, setRotation] = useState(0);
  const [metrics, setMetrics] = useState({ page: 1, pages: 0, scale: 1 });
  const [pageRequest, setPageRequest] = useState<{ page: number; token: number } | null>(null);
  const [shortcuts, setShortcuts] = useState(false);
  const [pendingLink, setPendingLink] = useState<string | null>(null);
  const [blockedLink, setBlockedLink] = useState<string | null>(null);
  const [shell, setShell] = useState(true);
  const [chromeOn, setChromeOn] = useState(true);
  const [badgeOn, setBadgeOn] = useState(false);
  const findRef = useRef<HTMLInputElement>(null);
  const runRef = useRef<(action: string) => void>(() => undefined);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const hideTimer = useRef<number | undefined>(undefined);
  const lastPoke = useRef(0);
  const persistTimer = useRef<number | undefined>(undefined);
  const badgeTimer = useRef<number | undefined>(undefined);
  const badgeSeen = useRef(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const choice = settings.theme;
      const dark = choice === "dark" || (choice !== "light" && media.matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.dataset.themeChoice = choice;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme]);

  useEffect(() => {
    let unlisten: Array<() => void> = [];
    let cancel = false;
    const boot = async () => {
      setShell(inShell());
      if (!inShell()) return;
      const [loaded, reader, session] = await Promise.all([getSettings(), readerOrigin(), sessionState()]);
      if (cancel) return;
      setSettings(loaded);
      setOrigin(reader);
      if (session.document) await adopt(session.document);
      else if (session.error) setPhase({ kind: "error", message: session.error.message });
      await markPerf("ui_interactive");
      const windowHandle = getCurrentWindow();
      unlisten = await Promise.all([
        listen<Opened>("document-opened", (event) => {
          void adopt(event.payload);
        }),
        listen<{ message: string }>("document-error", (event) => {
          setPhase({ kind: "error", message: event.payload.message || "Could not open that file." });
        }),
        listen("document-closed", () => setPhase({ kind: "empty" })),
        listen<string>("menu-action", (event) => runRef.current(event.payload)),
        windowHandle.onCloseRequested(async () => {
          await updateSettings(settingsRef.current).catch(() => undefined);
        }),
      ]);
    };
    void boot();
    return () => {
      cancel = true;
      unlisten.forEach((stop) => stop());
    };
  }, []);

  // Chrome auto-hide: any mouse or key activity reveals it; it fades after
  // a short idle and stays down while scrolling.
  useEffect(() => {
    const poke = () => {
      const now = Date.now();
      if (now - lastPoke.current < 120) return;
      lastPoke.current = now;
      setChromeOn(true);
      window.clearTimeout(hideTimer.current);
      if (settingsRef.current.chromeAutoHide) {
        hideTimer.current = window.setTimeout(() => setChromeOn(false), 1600);
      }
    };
    const onKey = () => {
      lastPoke.current = 0;
      poke();
    };
    window.addEventListener("mousemove", poke);
    window.addEventListener("keydown", onKey);
    poke();
    return () => {
      window.removeEventListener("mousemove", poke);
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(hideTimer.current);
    };
  }, []);

  // Gesture zoom: Ctrl+wheel covers Chromium pinch (Windows/WebView2);
  // gesturestart/change covers WKWebView trackpad pinch (macOS).
  useEffect(() => {
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !settingsRef.current.gestureZoom) return;
      event.preventDefault();
      setScaleMode("custom");
      applyZoom(zoomFromWheel(settingsRef.current.zoom, event.deltaY));
    };
    let gestureStartZoom = 1;
    const onGestureStart = (event: Event) => {
      if (!settingsRef.current.gestureZoom) return;
      event.preventDefault();
      gestureStartZoom = settingsRef.current.zoom;
    };
    const onGestureChange = (event: Event) => {
      if (!settingsRef.current.gestureZoom) return;
      event.preventDefault();
      setScaleMode("custom");
      applyZoom(zoomFromGesture(gestureStartZoom, (event as unknown as { scale: number }).scale));
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("gesturestart", onGestureStart);
    window.addEventListener("gesturechange", onGestureChange);
    return () => {
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("gesturestart", onGestureStart);
      window.removeEventListener("gesturechange", onGestureChange);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "o") {
        event.preventDefault();
        runRef.current("open");
      } else if (meta && event.key.toLowerCase() === "f") {
        event.preventDefault();
        runRef.current("find");
      } else if (meta && event.key.toLowerCase() === "e") {
        event.preventDefault();
        runRef.current("toggle-mode");
      } else if (meta && (event.key === "=" || event.key === "+")) {
        event.preventDefault();
        runRef.current("zoom-in");
      } else if (meta && event.key === "-") {
        event.preventDefault();
        runRef.current("zoom-out");
      } else if (meta && event.key === "0") {
        event.preventDefault();
        runRef.current("zoom-reset");
      } else if (event.key === "Escape") {
        setFindOpen(false);
        setShortcuts(false);
        setPendingLink(null);
        setBlockedLink(null);
      } else if (!meta && phase.kind === "pdf" && event.key === "PageDown") {
        event.preventDefault();
        requestPage(metrics.page + 1);
      } else if (!meta && phase.kind === "pdf" && event.key === "PageUp") {
        event.preventDefault();
        requestPage(metrics.page - 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase.kind, metrics.page]);

  useEffect(() => {
    if (findOpen) findRef.current?.focus();
  }, [findOpen]);

  const zoomPct = Math.round((scaleMode === "custom" ? settings.zoom : metrics.scale) * 100);
  useEffect(() => {
    if (!badgeSeen.current) {
      badgeSeen.current = true;
      return;
    }
    setBadgeOn(true);
    window.clearTimeout(badgeTimer.current);
    badgeTimer.current = window.setTimeout(() => setBadgeOn(false), 1100);
    return () => window.clearTimeout(badgeTimer.current);
  }, [zoomPct]);

  async function adopt(info: Opened): Promise<void> {
    setOutline([]);
    setHeadings([]);
    setRotation(0);
    if (info.kind === "pdf") {
      setPhase({ kind: "pdf", info });
      const saved = settingsRef.current.positions.find((item) => item.path === info.path);
      if (saved?.page) requestPage(saved.page);
      return;
    }
    setPhase({ kind: "loading", name: info.name });
    try {
      const body = await markdownText(info.id);
      setPhase({ kind: "md", info, text: body.text, truncated: body.truncated });
    } catch (err) {
      setPhase({ kind: "error", message: errorText(err) });
    }
  }

  function requestPage(page: number): void {
    const next = Math.max(1, page);
    setPageRequest({ page: next, token: Date.now() });
    setMetrics((current) => ({ ...current, page: next }));
  }

  async function persist(next: Settings): Promise<void> {
    setSettings(next);
    if (!inShell()) return;
    const saved = await updateSettings(next);
    setSettings(saved);
  }

  function applyZoom(next: number): void {
    const zoom = clampZoom(next);
    const updated = { ...settingsRef.current, zoom };
    setSettings(updated);
    window.clearTimeout(persistTimer.current);
    persistTimer.current = window.setTimeout(() => {
      if (inShell()) void updateSettings(settingsRef.current);
    }, 400);
  }

  async function openFromDialog(): Promise<void> {
    if (!inShell()) return;
    const path = await pickPath();
    if (!path) return;
    const name = path.split(/[/\\]/).pop() || path;
    setPhase({ kind: "loading", name });
    try {
      await openPath(path);
    } catch (err) {
      setPhase({ kind: "error", message: errorText(err) });
    }
  }

  runRef.current = (action: string) => {
    if (action === "open") void openFromDialog();
    else if (action === "find") setFindOpen(true);
    else if (action === "toggle-toc") setRail((open) => !open);
    else if (action === "toggle-mode" && phase.kind === "md") {
      const markdownMode = settings.markdownMode === "raw" ? "rendered" : "raw";
      void persist({ ...settings, markdownMode });
    } else if (action === "zoom-in") {
      setScaleMode("custom");
      applyZoom(settings.zoom * 1.15);
    } else if (action === "zoom-out") {
      setScaleMode("custom");
      applyZoom(settings.zoom / 1.15);
    } else if (action === "zoom-reset") {
      setScaleMode("actual");
      applyZoom(1);
    } else if (action === "fit-width") setScaleMode("fit-width");
    else if (action === "fit-page") setScaleMode("fit-page");
    else if (action === "view-continuous") void persist({ ...settings, pdfView: "continuous" });
    else if (action === "view-single") void persist({ ...settings, pdfView: "single" });
    else if (action === "rotate-cw") setRotation((value) => (value + 90) % 360);
    else if (action === "rotate-ccw") setRotation((value) => (value + 270) % 360);
    else if (action === "theme-system" || action === "theme-light" || action === "theme-dark") {
      void persist({ ...settings, theme: action.replace("theme-", "") });
    } else if (action === "shortcuts") setShortcuts(true);
    else if (action === "close-doc") {
      setPhase({ kind: "empty" });
      if (inShell()) void closeDocument();
    }
  };

  const docInfo = phase.kind === "pdf" || phase.kind === "md" ? phase.info : null;
  const remoteAllowed = docInfo ? settings.remoteAllowed.includes(docInfo.path) : false;
  const mode = settings.markdownMode === "raw" ? "raw" : "rendered";
  const pdfView = settings.pdfView === "single" ? "single" : "continuous";
  const chromeOff = settings.chromeAutoHide && !chromeOn && !findOpen;

  return (
    <div
      class="shell"
      onScrollCapture={() => {
        if (settingsRef.current.chromeAutoHide) setChromeOn(false);
      }}
    >
      <div class="workspace">
        {rail ? (
          <aside class="rail" aria-label="Contents">
            <div class="rail-head">
              <strong>{phase.kind === "pdf" ? "Outline" : "Contents"}</strong>
              <button type="button" class="icon-btn" onClick={() => setRail(false)} aria-label="Close contents" title="Close">
                ×
              </button>
            </div>
            {phase.kind === "pdf" ? (
              outline.length ? <OutlineList items={outline} onJump={requestPage} /> : <p class="rail-empty">No outline in this document.</p>
            ) : headings.length ? (
              <ul class="toc">
                {headings.map((heading) => (
                  <li key={heading.id} style={{ paddingLeft: `${(heading.level - 1) * 12}px` }}>
                    <a href={`#${heading.id}`}>{heading.text}</a>
                  </li>
                ))}
              </ul>
            ) : (
              <p class="rail-empty">No headings yet.</p>
            )}
          </aside>
        ) : null}
        <main class="canvas">
          {phase.kind === "empty" ? (
            <section class="state">
              <h1>Reader</h1>
              <p>Drop a PDF or Markdown file anywhere in this window. Reader decides the format from the file itself — extensions are only a label.</p>
              <button type="button" class="primary" onClick={() => runRef.current("open")}>
                Open…
              </button>
              {import.meta.env.DEV && !shell ? (
                <button
                  type="button"
                  onClick={() => {
                    void import("../corpus/hello.md?raw").then((mod) => {
                      setPhase({
                        kind: "md",
                        info: {
                          id: 0,
                          kind: "markdown",
                          name: "hello.md",
                          path: "corpus/hello.md",
                          len: mod.default.length,
                          bom: "none",
                          extension: "md",
                          sniffUs: 0,
                        },
                        text: mod.default,
                        truncated: false,
                      });
                    });
                  }}
                >
                  Preview sample note
                </button>
              ) : null}
              <p class="hint">
                From a terminal: <code>reader path/to/notes.md</code>
              </p>
            </section>
          ) : null}
          {phase.kind === "loading" ? (
            <section class="state">
              <h1>Opening {phase.name}</h1>
              <p>Checking the file header and choosing a reader.</p>
            </section>
          ) : null}
          {phase.kind === "error" ? (
            <section class="state">
              <h1>Can’t open this file</h1>
              <p>{phase.message}</p>
              <button type="button" class="primary" onClick={() => runRef.current("open")}>
                Try another file
              </button>
            </section>
          ) : null}
          {phase.kind === "md" ? (
            <MarkdownView
              docId={phase.info.id}
              origin={origin}
              text={phase.text}
              truncated={phase.truncated}
              mode={mode}
              zoom={settings.zoom}
              allowRemote={remoteAllowed}
              query={findOpen ? query : ""}
              cursor={cursor}
              onCount={(count, running) => {
                setMatchCount(count);
                setSearching(running);
              }}
              onHeadings={setHeadings}
              onLink={setPendingLink}
              onBlocked={setBlockedLink}
            />
          ) : null}
          {phase.kind === "pdf" ? (
            <PdfView
              doc={phase.info}
              origin={origin}
              viewMode={pdfView}
              scaleMode={scaleMode}
              scale={settings.zoom}
              rotation={rotation}
              query={findOpen ? query : ""}
              cursor={cursor}
              pageRequest={pageRequest}
              initialPage={settings.positions.find((item) => item.path === phase.info.path)?.page ?? null}
              onMetrics={setMetrics}
              onOutline={setOutline}
              onCount={(count, running) => {
                setMatchCount(count);
                setSearching(running);
              }}
              onReclassified={(info) => {
                void adopt(info);
              }}
              onError={(message) => setPhase({ kind: "error", message })}
            />
          ) : null}
        </main>
      </div>
      <div
        class={`pill float${chromeOff ? " off" : ""}`}
        onMouseEnter={() => {
          lastPoke.current = 0;
          window.clearTimeout(hideTimer.current);
          setChromeOn(true);
        }}
        onMouseLeave={() => {
          if (settingsRef.current.chromeAutoHide) {
            window.clearTimeout(hideTimer.current);
            hideTimer.current = window.setTimeout(() => setChromeOn(false), 1600);
          }
        }}
      >
        <button type="button" class="icon-btn" aria-pressed={rail} onClick={() => setRail((open) => !open)} title="Contents" aria-label="Contents">
          ☰
        </button>
        <button type="button" class="icon-btn" onClick={() => setFindOpen(true)} title="Find (⌘F)" aria-label="Find">
          ⌕
        </button>
        {phase.kind === "md" ? (
          <>
            <span class="sep" />
            <div class="segmented" role="group" aria-label="Markdown view">
              <button type="button" aria-pressed={mode === "rendered"} onClick={() => void persist({ ...settings, markdownMode: "rendered" })}>
                Rendered
              </button>
              <button type="button" aria-pressed={mode === "raw"} onClick={() => void persist({ ...settings, markdownMode: "raw" })}>
                Raw
              </button>
            </div>
          </>
        ) : null}
        <span class="sep" />
        <details class="overflow">
          <summary aria-label="More actions" title="More">⋯</summary>
          <div class="menu-pop" onClick={(event) => {
            if ((event.target as HTMLElement).closest("button")) {
              (event.currentTarget as HTMLElement).closest("details")?.removeAttribute("open");
            }
          }}>
            <button type="button" onClick={() => runRef.current("open")}>Open…</button>
            <div class="menu-sep" />
            <button type="button" aria-pressed={settings.theme === "system"} onClick={() => void persist({ ...settings, theme: "system" })}>Theme: System</button>
            <button type="button" aria-pressed={settings.theme === "light"} onClick={() => void persist({ ...settings, theme: "light" })}>Theme: Light</button>
            <button type="button" aria-pressed={settings.theme === "dark"} onClick={() => void persist({ ...settings, theme: "dark" })}>Theme: Dark</button>
            {phase.kind === "pdf" ? (
              <>
                <div class="menu-sep" />
                <button type="button" onClick={() => runRef.current("rotate-ccw")}>Rotate left</button>
                <button type="button" onClick={() => runRef.current("rotate-cw")}>Rotate right</button>
                <button type="button" onClick={() => void persist({ ...settings, pdfView: pdfView === "single" ? "continuous" : "single" })}>
                  {pdfView === "single" ? "Continuous scroll" : "Single page"}
                </button>
                <button type="button" onClick={() => runRef.current("fit-width")}>Fit width</button>
                <button type="button" onClick={() => runRef.current("fit-page")}>Fit page</button>
              </>
            ) : null}
            {phase.kind === "md" && inShell() ? (
              <>
                <div class="menu-sep" />
                <button
                  type="button"
                  onClick={() => {
                    void setRemoteAllowed(phase.info.path, !remoteAllowed).then(setSettings);
                  }}
                >
                  {remoteAllowed ? "Block remote images" : "Allow remote images"}
                </button>
              </>
            ) : null}
            <div class="menu-sep" />
            <button type="button" aria-pressed={settings.chromeAutoHide} onClick={() => void persist({ ...settings, chromeAutoHide: !settings.chromeAutoHide })}>
              Auto-hide toolbar
            </button>
            <button type="button" aria-pressed={settings.gestureZoom} onClick={() => void persist({ ...settings, gestureZoom: !settings.gestureZoom })}>
              Pinch to zoom
            </button>
            <button type="button" onClick={() => setShortcuts(true)}>Keyboard shortcuts</button>
            {docInfo ? (
              <>
                <div class="menu-sep" />
                <button type="button" onClick={() => runRef.current("close-doc")}>Close document</button>
              </>
            ) : null}
          </div>
        </details>
      </div>
      {findOpen ? (
        <form
          class="findbar float"
          onSubmit={(event) => {
            event.preventDefault();
            setCursor((value) => (matchCount === 0 ? 0 : (value + 1) % matchCount));
          }}
        >
          <input
            ref={findRef}
            value={query}
            onInput={(event) => {
              setQuery(event.currentTarget.value);
              setCursor(0);
            }}
            placeholder="Find in document"
            aria-label="Find in document"
          />
          <span class="match-count">{searching ? "…" : query.trim() ? `${matchCount === 0 ? 0 : cursor + 1} / ${matchCount}` : ""}</span>
          <button type="button" class="icon-btn" onClick={() => setCursor((value) => (matchCount === 0 ? 0 : (value - 1 + matchCount) % matchCount))} aria-label="Previous match" title="Previous match">
            ‹
          </button>
          <button type="submit" class="icon-btn" aria-label="Next match" title="Next match">
            ›
          </button>
          <button type="button" class="icon-btn" onClick={() => setFindOpen(false)} aria-label="Close find" title="Close">
            ×
          </button>
        </form>
      ) : null}
      <button
        type="button"
        class={`zoom-badge float${badgeOn ? "" : " off"}`}
        onClick={() => runRef.current("zoom-reset")}
        title="Reset zoom to 100%"
        aria-label={`Zoom ${zoomPct} percent. Reset zoom.`}
      >
        {zoomPct}%
      </button>
      {phase.kind === "pdf" ? (
        <div class={`chip float${chromeOff ? " off" : ""}`}>
          <button type="button" class="icon-btn" onClick={() => requestPage(metrics.page - 1)} aria-label="Previous page" title="Previous page">
            ‹
          </button>
          <input
            class="page-input"
            value={metrics.page}
            onChange={(event) => requestPage(Number(event.currentTarget.value))}
            inputMode="numeric"
            aria-label="Page number"
          />
          <span class="chip-label">/ {metrics.pages || "…"}</span>
          <button type="button" class="icon-btn" onClick={() => requestPage(metrics.page + 1)} aria-label="Next page" title="Next page">
            ›
          </button>
        </div>
      ) : phase.kind === "md" ? (
        <div class={`chip float${chromeOff ? " off" : ""}`}>
          <span class="chip-label">
            {mode === "raw" ? "Raw" : "Rendered"}
            {remoteAllowed ? " · remote images" : ""}
            {phase.truncated ? " · truncated" : ""}
          </span>
        </div>
      ) : null}
      {shortcuts ? (
        <div class="modal-backdrop" onClick={() => setShortcuts(false)}>
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" onClick={(event) => event.stopPropagation()}>
            <h2 id="shortcuts-title">Keyboard shortcuts</h2>
            <ul class="shortcut-list">
              <li><kbd>Ctrl/⌘ O</kbd> Open</li>
              <li><kbd>Ctrl/⌘ F</kbd> Find</li>
              <li><kbd>Ctrl/⌘ E</kbd> Rendered / raw</li>
              <li><kbd>Ctrl/⌘ +</kbd> <kbd>Ctrl/⌘ -</kbd> <kbd>Ctrl/⌘ 0</kbd> Zoom</li>
              <li><kbd>Pinch</kbd> or <kbd>Ctrl + scroll</kbd> Zoom</li>
              <li><kbd>Page Up</kbd> <kbd>Page Down</kbd> PDF pages</li>
              <li><kbd>Esc</kbd> Close find or dialog</li>
            </ul>
            <div class="modal-actions">
              <button type="button" onClick={() => setShortcuts(false)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
      {pendingLink ? (
        <div class="modal-backdrop">
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="link-title">
            <h2 id="link-title">Open external link?</h2>
            <p>Reader will hand this address to your browser. Nothing is fetched inside the document view.</p>
            <p class="link-url">{pendingLink}</p>
            <div class="modal-actions">
              <button type="button" onClick={() => setPendingLink(null)}>Cancel</button>
              <button
                type="button"
                class="primary"
                onClick={() => {
                  const url = pendingLink;
                  setPendingLink(null);
                  if (url && inShell()) void confirmOpenExternal(url);
                  else if (url) window.open(url, "_blank", "noopener");
                }}
              >
                Open in browser
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {blockedLink ? (
        <div class="modal-backdrop">
          <div class="modal" role="dialog" aria-modal="true" aria-labelledby="blocked-title">
            <h2 id="blocked-title">Link blocked</h2>
            <p>Reader only opens http and https links, and only after you confirm. This address was not opened.</p>
            <p class="link-url">{blockedLink}</p>
            <div class="modal-actions">
              <button type="button" onClick={() => setBlockedLink(null)}>Close</button>
            </div>
          </div>
        </div>
      ) : null}
      <PositionSaver phase={phase} page={metrics.page} />
      <RecentHint recent={settings.recent} onClear={() => void clearRecent().then(() => setSettings({ ...settings, recent: [] }))} visible={phase.kind === "empty" && settings.recent.length > 0} onOpen={(path) => void openPath(path).catch((err) => setPhase({ kind: "error", message: errorText(err) }))} />
    </div>
  );
}

function PositionSaver(props: { phase: Phase; page: number }) {
  const phase = props.phase;
  useEffect(() => {
    if (!inShell() || (phase.kind !== "pdf" && phase.kind !== "md")) return;
    const path = phase.info.path;
    const timer = window.setTimeout(() => {
      const scroller = document.querySelector(".pdf-scroll, .raw-wrap, .markdown");
      const ratio = scroller ? scroller.scrollTop / Math.max(scroller.scrollHeight - scroller.clientHeight, 1) : 0;
      const anchor = phase.kind === "md" ? document.querySelector(".markdown h1, .markdown h2")?.id ?? null : null;
      void rememberPosition({
        path,
        page: phase.kind === "pdf" ? props.page : null,
        anchor,
        scrollRatio: Number.isFinite(ratio) ? ratio : 0,
      });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [phase, props.page]);
  return null;
}

function RecentHint(props: { recent: string[]; visible: boolean; onClear: () => void; onOpen: (path: string) => void }) {
  if (!props.visible) return null;
  return (
    <div class="recent-inline">
      <span>Recent</span>
      {props.recent.slice(0, 5).map((path) => (
        <button type="button" key={path} onClick={() => props.onOpen(path)}>
          {path.split(/[/\\]/).pop()}
        </button>
      ))}
      <button type="button" onClick={props.onClear}>Clear</button>
    </div>
  );
}

function OutlineList(props: { items: OutlineItem[]; onJump: (page: number) => void }) {
  return (
    <ul class="toc">
      {props.items.map((item, index) => (
        <li key={`${item.title}-${index}`}>
          {item.page ? (
            <button type="button" onClick={() => props.onJump(item.page ?? 1)}>
              {item.title}
            </button>
          ) : (
            <span>{item.title}</span>
          )}
          {item.items.length ? <OutlineList items={item.items} onJump={props.onJump} /> : null}
        </li>
      ))}
    </ul>
  );
}

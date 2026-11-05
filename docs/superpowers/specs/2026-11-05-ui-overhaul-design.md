# Reader UI overhaul + scroll performance

Date: 2026-11-05. Status: approved by user (YOLO — reasonable defaults, configurable where appropriate).

## Goal

Replace the current janky UI with a clean, modern, minimal design for the
Windows + macOS PDF/Markdown reader. Priorities, in order:

1. Smoothest possible (fast) scrolling, especially PDF continuous mode.
2. Clean, modern, simple chrome — document fills the window.
3. Easy zoom in/out via gestures and shortcuts.
4. Extremely light edges — hairline borders, near-zero shadows.

## Approach

In-place rewrite of the Preact UI and `styles.css`, plus targeted PDF
render-pipeline performance work. No new runtime dependencies.

## Design

### Visual language

- Neutral palette. Light theme: background `#fafaf9`, surfaces pure white,
  ink `#1c1c1a`, muted gray for secondary text. Dark theme: true dark
  neutrals (`#171715` background). Light/dark/system switching retained.
- Edges: 1px hairlines at ~6% ink opacity. Shadows reduced to a faint
  ambient blur used only on floating chrome; document pages use a hairline
  border instead of the current heavy shadow.
- Ghost buttons: borderless, transparent, hover tint of ~8% ink, 7px radius.
- UI font: system stack (`-apple-system`, `Segoe UI`, sans-serif) at 13px.
  Markdown body keeps its serif reading face.

### Chrome: auto-hiding floating pill

- Persistent topbar and statusbar removed. Document renders edge-to-edge.
- Floating pill, top-center: Contents toggle, Find, markdown Rendered/Raw
  segmented control (markdown only), and a More menu (theme, rotate,
  single/continuous view, shortcuts, close, settings toggles).
- Pill fades in on mouse movement or key activity; fades out after ~1.6s of
  idle and stays hidden while scrolling. Controlled by new setting
  `chromeAutoHide` (default true; when false the pill is always visible).
- Transient zoom badge (bottom-center, e.g. "125%") appears for ~1s when
  zoom changes; clicking it resets zoom to 100%.
- Position chip (bottom-right) shows "12 / 48" for PDF or mode/remote-image
  state for Markdown; appears with activity and auto-hides with the pill.
- Contents rail becomes a left overlay panel with a hairline edge and a
  close button; it no longer shifts the document layout.
- Find bar becomes a floating pill under the toolbar pill. Empty, loading,
  and error states restyled to match the new language.
- Open moves into the More menu and the empty state (⌘/Ctrl+O unchanged).

### Zoom

- Pinch-to-zoom on trackpads: `gesturestart/gesturechange` on macOS
  (WKWebView) and `Ctrl+wheel` on Windows (WebView2/Chromium). Drives both
  PDF scale (custom mode) and Markdown font zoom, which already share the
  `zoom` setting.
- New setting `gestureZoom` (default true) to disable gesture zoom.
- Existing shortcuts kept: ⌘/Ctrl `+`, `-`, `0`.
- PDF repaints are debounced ~140ms after the last gesture event; during the
  gesture a CSS transform preview scales already-rendered pages so feedback
  is immediate without render thrash. Persisting the zoom setting to disk is
  debounced (~400ms) so rapid gestures do not hammer the settings file.
- Zoom clamped to 25%–600%, as today.

### PDF scroll performance

- **LRU canvas cache.** Today the IntersectionObserver deletes canvas +
  text layer the moment a page leaves the viewport, so flinging shows blank
  slots and scrolling back re-renders. Replace with an LRU cache of up to
  16 rendered pages; eviction removes the pages farthest from the current
  scroll position.
- **Render-ahead.** IntersectionObserver rootMargin grows from 35% to ~125%
  of the viewport so upcoming pages render before they are reached.
- **Velocity-aware rendering.** While scroll velocity is high (a fling), new
  renders are deferred; a settle timer (~150ms after the last scroll event)
  triggers rendering of the pages actually on screen.
- **Cheap scroll handler.** `onScroll` is rAF-throttled and the current page
  is computed by binary search over cached slot offsets instead of
  `querySelectorAll` + `getBoundingClientRect` over every page per event.
- **Stable scrollbar.** Page slots are pre-sized from the first page's
  dimensions (corrected to exact dimensions as each page renders) instead of
  a fixed 960px placeholder, reducing scrollbar jumps.

### Settings additions

`Settings` gains two booleans, both defaulting to true and exposed in the
More menu:

- `chromeAutoHide` — auto-hide the floating toolbar.
- `gestureZoom` — pinch / Ctrl+wheel zoom.

Rust `Settings` gets matching fields with `#[serde(default = ...)]` so old
settings files load cleanly.

### Error handling

Unchanged in behavior (banners, password prompt, link confirmation modals),
restyled to the new language.

### Testing

- New unit tests (node:test, matching `test/` conventions) for zoom math
  (wheel delta → scale, clamping) and the LRU page cache (insert, hit,
  eviction order).
- Existing `pnpm test` and `cargo test -p reader-core` suites keep passing.
- Manual smoke: `pnpm tauri dev` on macOS; build sanity via `pnpm build`.

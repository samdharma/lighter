# Spike notes

These are measurements from the Linux environment that produced the source. They are not the release gate in PRD §7. That gate needs the signed-or-at-least-release binaries on a reference Windows 11 PC and a Mac, which this machine cannot boot.

## Stack

Tauri 2.12.5, not Electron and not Tauri 3 alpha. The Phase 0 question was whether Tauri could open a file, stream bytes, and ship a portable exe plus a `.app`. The Windows and macOS GitHub-hosted runners are what produce those binaries. Electron was not selected, because Tauri was not shown to miss that portability bar.

## PDF bytes

PDF.js is given a `PDFDataRangeTransport`. Each range is a `GET` with a `Range` header on `reader://…/doc/{id}`. The Rust side reads that slice with `read_at` and answers `206`. `disableAutoFetch` and `disableStream` are both set, so PDF.js does not pull the rest of the file on its own.

`cargo test -p reader-core` covers a 200KB body: the response is `206`, `Content-Range` matches the file length, and the handler does not require a full-file read. A PDF smaller than one 64KB chunk is still fetched in one range. That is expected.

PDF.js 6 has no `isEvalSupported` switch. This build does not load `pdf.sandbox`, and `enableXfa` is false, so document JavaScript is not started.

## Bundle shape

`pnpm build` on this machine produced:

- UI entry `index-*.js`: 67,504 bytes. It does not contain the PDF worker or Mermaid.
- `pdf.worker.min-*.mjs`: 1,271,910 bytes, loaded by PDF.js when a PDF opens.
- `pdfjs-*.js`: 444,360 bytes, a separate chunk.
- `mermaid-*.js`: 3,097,110 bytes, a separate chunk, loaded only when a note has a mermaid fence.
- `katex-*.js`: 518,810 bytes, plus its CSS and fonts, loaded only when a note has math.

`node scripts/check-bundle-budget.mjs` fails the build if the entry grows past 200KB or if those two files stop being separate. The Windows and macOS download sizes are whatever the release assets report. They were not measured here, because this machine cannot link those binaries.

## What was not measured

Cold launch p95 ≤ 1.5s, idle memory ≤ 180MB, and the Windows/macOS download-size caps were not measured on reference hardware. The Linux debug build is not a useful stand-in for those numbers. The published GitHub Release assets are the right place to check download size (`SHA256SUMS` lists the files; the release page shows byte sizes).

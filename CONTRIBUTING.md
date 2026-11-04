# Contributing

Reader is a local PDF and Markdown reader. Changes should stay inside that job.

## Setup

Rust stable (1.90 or newer), Node 22, and pnpm 10.

```sh
pnpm install
cargo test -p reader-core
pnpm test
pnpm tauri dev
```

`cargo test -p reader-core` does not need a WebView. `pnpm tauri dev` does: WebView2 on Windows, system WebKit on macOS, WebKitGTK 4.1 on Linux.

## What belongs here

- Opening a file from a path, the Open dialog, a drop, or the OS, without asking the person to pick PDF versus Markdown.
- Reading PDF and Markdown, including find, contents, and zoom.
- Clear errors for a missing file, a directory, a broken link, a permission failure, a corrupt PDF, and a binary that is neither PDF nor text.

## What does not

OCR, merging or form-filling PDFs, editing Markdown, accounts, sync, plugins, a background updater, and a generic filesystem or shell command from the UI. Do not add `tauri-plugin-fs`, `tauri-plugin-shell`, or `tauri-plugin-updater`.

PDF.js, Mermaid, and KaTeX stay on dynamic imports. The entry bundle should not contain `pdf.worker` or `mermaid`. `node scripts/check-bundle-budget.mjs` checks that after `pnpm build`.

## Checks before pushing

```sh
cargo test -p reader-core
pnpm test
pnpm build
```

GitHub Actions builds the portable Windows exe and the macOS app zip. Those artifacts are unsigned. Do not commit `node_modules`, `dist`, or `target`.

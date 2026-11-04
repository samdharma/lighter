import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    preact(),
    viteStaticCopy({
      targets: [
        { src: "node_modules/pdfjs-dist/cmaps/*", dest: "cmaps" },
        { src: "node_modules/pdfjs-dist/standard_fonts/*", dest: "standard_fonts" },
        { src: "node_modules/pdfjs-dist/wasm/*", dest: "wasm" },
        { src: "node_modules/pdfjs-dist/iccs/*", dest: "iccs" },
      ],
    }),
  ],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: true,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("pdfjs-dist")) return "pdfjs";
          if (id.includes("highlight.js")) return "highlight";
          if (id.includes("katex")) return "katex";
          if (id.includes("mermaid")) return "mermaid";
          if (id.includes("markdown-it")) return "markdown";
        },
      },
    },
  },
});

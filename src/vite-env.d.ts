/// <reference types="vite/client" />

declare module "*.md?raw" {
  const src: string;
  export default src;
}

declare module "markdown-it-footnote" {
  import type MarkdownIt from "markdown-it";
  const plugin: MarkdownIt.PluginSimple;
  export default plugin;
}

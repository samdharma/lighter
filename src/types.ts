export type Opened = {
  id: number;
  kind: "pdf" | "markdown";
  name: string;
  path: string;
  len: number;
  bom: string;
  extension: string | null;
  sniffUs: number;
};

export type MarkdownBody = {
  id: number;
  text: string;
  truncated: boolean;
  bom: string;
};

export type ReadingPosition = {
  path: string;
  page: number | null;
  anchor: string | null;
  scrollRatio: number;
};

export type Settings = {
  theme: string;
  zoom: number;
  pdfView: string;
  markdownMode: string;
  windowWidth: number;
  windowHeight: number;
  windowX: number | null;
  windowY: number | null;
  maximized: boolean;
  recent: string[];
  positions: ReadingPosition[];
  remoteAllowed: string[];
  chromeAutoHide: boolean;
  gestureZoom: boolean;
};

export type UiError = {
  code: string;
  message: string;
};

export type OutlineItem = {
  title: string;
  page: number | null;
  items: OutlineItem[];
};

export type TransportStats = {
  requests: number;
  bytesServed: number;
  rangeResponses: number;
  fullFileResponses: number;
  assetRequests: number;
};

export type ScaleMode = "custom" | "fit-width" | "fit-page" | "actual";

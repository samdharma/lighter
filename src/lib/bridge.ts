import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MarkdownBody, Opened, ReadingPosition, Settings, TransportStats, UiError } from "../types";

export function inShell(): boolean {
  return isTauri();
}

export function errorText(err: unknown): string {
  if (typeof err === "string" && err.trim()) return err;
  if (err && typeof err === "object" && "message" in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return "Could not open that file.";
}

export async function sessionState(): Promise<{ document: Opened | null; error: UiError | null }> {
  return invoke("session_state");
}

export async function openPath(path: string): Promise<Opened> {
  return invoke("open_path", { path });
}

export async function closeDocument(): Promise<void> {
  await invoke("close_document");
}

export async function markdownText(id: number): Promise<MarkdownBody> {
  return invoke("markdown_text", { id });
}

export async function reclassifyFailedPdf(id: number): Promise<Opened> {
  return invoke("reclassify_failed_pdf", { id });
}

export async function getSettings(): Promise<Settings> {
  return invoke("get_settings");
}

export async function updateSettings(settings: Settings): Promise<Settings> {
  return invoke("update_settings", { settings });
}

export async function clearRecent(): Promise<void> {
  await invoke("clear_recent");
}

export async function rememberPosition(position: ReadingPosition): Promise<void> {
  await invoke("remember_position", { position });
}

export async function setRemoteAllowed(path: string, allowed: boolean): Promise<Settings> {
  return invoke("set_remote_allowed", { path, allowed });
}

export async function transportStats(): Promise<TransportStats> {
  return invoke("transport_stats");
}

export async function markPerf(name: string): Promise<void> {
  await invoke("mark_perf", { name });
}

export async function readerOrigin(): Promise<string> {
  return invoke("reader_origin");
}

export async function pickPath(): Promise<string | null> {
  const selected = await open({
    title: "Open a document",
    multiple: false,
    directory: false,
  });
  return typeof selected === "string" ? selected : null;
}

export async function confirmOpenExternal(url: string): Promise<void> {
  await openUrl(url);
}

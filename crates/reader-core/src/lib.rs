//! Native core for Reader.
//!
//! The WebView never receives a generic filesystem or shell API. This crate
//! owns content detection, canonical paths, bounded reads, settings, and
//! atomic writes. The Tauri shell exposes a small typed command set on top.

mod atomic;
mod detect;
mod open;
mod protocol;
mod settings;
mod svg;

pub use atomic::atomic_write;
pub use detect::{
    fallback_markdown, Bom, DetectError, Detection, SNIFF_BYTES, PDF_SCAN_BYTES,
};
pub use open::{
    extension_of, read_at, resolve_document, OpenError, ResolvedFile, MAX_MARKDOWN_BYTES,
};
pub use protocol::{
    decode_path_segment, DocumentSession, HttpResult, MarkdownBody, OpenedInfo, TransportStats,
    MAX_ASSET_BYTES,
};
pub use settings::{ReadingPosition, Settings, SettingsStore};
pub use svg::sanitize_svg;

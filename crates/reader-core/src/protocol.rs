use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::Instant;

use http::{header, Method, Request, Response, StatusCode};

use crate::detect::{fallback_markdown, Bom, Detection, SNIFF_BYTES};
use crate::open::{extension_of, read_at, resolve_document, OpenError, ResolvedFile, MAX_MARKDOWN_BYTES};
use crate::svg::sanitize_svg;

pub const MAX_ASSET_BYTES: u64 = 25 * 1024 * 1024;
const MAX_SVG_BYTES: u64 = 2 * 1024 * 1024;
const MAX_RANGE: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenedInfo {
    pub id: u64,
    pub kind: String,
    pub name: String,
    pub path: String,
    pub len: u64,
    pub bom: String,
    pub extension: Option<String>,
    pub sniff_us: u64,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MarkdownBody {
    pub id: u64,
    pub text: String,
    pub truncated: bool,
    pub bom: String,
}

#[derive(Debug, Clone, Default, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TransportStats {
    pub requests: u64,
    pub bytes_served: u64,
    pub range_responses: u64,
    pub full_file_responses: u64,
    pub asset_requests: u64,
}

struct OpenDocument {
    id: u64,
    path: PathBuf,
    name: String,
    extension: Option<String>,
    len: u64,
    root: PathBuf,
    detection: Detection,
    bom: Bom,
    file: File,
    sniff_us: u64,
}

pub struct DocumentSession {
    next_id: u64,
    current: Option<OpenDocument>,
    pub stats: TransportStats,
}

impl Default for DocumentSession {
    fn default() -> Self {
        Self {
            next_id: 1,
            current: None,
            stats: TransportStats::default(),
        }
    }
}

impl DocumentSession {
    pub fn open_path(&mut self, input: &Path) -> Result<OpenedInfo, OpenError> {
        let started = Instant::now();
        let resolved = resolve_document(input)?;
        let sniff_us = started.elapsed().as_micros() as u64;
        self.install(resolved, sniff_us)
    }

    fn install(&mut self, resolved: ResolvedFile, sniff_us: u64) -> Result<OpenedInfo, OpenError> {
        let root = resolved
            .path
            .parent()
            .unwrap_or_else(|| Path::new("/"))
            .to_path_buf();
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        let doc = OpenDocument {
            id,
            path: resolved.path,
            name: resolved.name,
            extension: resolved.extension,
            len: resolved.len,
            root,
            detection: resolved.detection,
            bom: resolved.bom,
            file: resolved.file,
            sniff_us,
        };
        let info = info_of(&doc);
        self.current = Some(doc);
        Ok(info)
    }

    pub fn current(&self) -> Option<OpenedInfo> {
        self.current.as_ref().map(info_of)
    }

    pub fn close(&mut self) {
        self.current = None;
    }

    pub fn reclassify_failed_pdf(&mut self) -> Result<OpenedInfo, OpenError> {
        let doc = self.current.as_mut().ok_or(OpenError::NotFound)?;
        if !matches!(doc.detection, Detection::Pdf { .. }) {
            return Err(OpenError::InvalidPdf);
        }
        let n = SNIFF_BYTES.min(doc.len as usize);
        let prefix = read_at(&doc.file, 0, n).map_err(|err| OpenError::Io(err.to_string()))?;
        match fallback_markdown(&prefix) {
            Some(detection) => {
                doc.bom = match detection {
                    Detection::Markdown { bom } => bom,
                    Detection::Pdf { .. } => Bom::None,
                };
                doc.detection = detection;
                Ok(info_of(doc))
            }
            None => Err(OpenError::InvalidPdf),
        }
    }

    pub fn markdown_text(&self, id: u64) -> Result<MarkdownBody, OpenError> {
        let doc = self.doc(id)?;
        if !matches!(doc.detection, Detection::Markdown { .. }) {
            return Err(OpenError::UnsupportedBinary);
        }
        let capped = doc.len.min(MAX_MARKDOWN_BYTES);
        let mut to_read = capped as usize;
        if matches!(doc.bom, Bom::Utf16Le | Bom::Utf16Be) && to_read > 2 {
            to_read -= (to_read - 2) % 2;
        }
        let bytes = if to_read == 0 {
            Vec::new()
        } else {
            read_at(&doc.file, 0, to_read).map_err(|err| OpenError::Io(err.to_string()))?
        };
        let text = crate::detect::decode_document(&bytes, doc.bom);
        Ok(MarkdownBody {
            id: doc.id,
            text,
            truncated: doc.len > MAX_MARKDOWN_BYTES,
            bom: bom_name(doc.bom).into(),
        })
    }

    pub fn handle(&mut self, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        let method = request.method().clone();
        if method == Method::OPTIONS {
            return empty(StatusCode::NO_CONTENT, None);
        }
        let path = request.uri().path();
        if let Some(rest) = path.strip_prefix("/asset/") {
            return self.handle_asset(&method, rest, request);
        }
        if let Some(id_str) = path.strip_prefix("/doc/") {
            let id_str = id_str.trim_matches('/');
            let Ok(id) = id_str.parse::<u64>() else {
                return text(StatusCode::NOT_FOUND, "Unknown document.");
            };
            return self.handle_doc(&method, id, request);
        }
        text(StatusCode::NOT_FOUND, "Unknown reader URL.")
    }

    fn handle_doc(&mut self, method: &Method, id: u64, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
        if *method != Method::GET && *method != Method::HEAD {
            return text(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.");
        }
        let Some(doc) = self.current.as_ref() else {
            return text(StatusCode::NOT_FOUND, "No document is open.");
        };
        if doc.id != id {
            return text(StatusCode::NOT_FOUND, "That document is no longer open.");
        }
        if !matches!(doc.detection, Detection::Pdf { .. }) {
            return text(StatusCode::NOT_FOUND, "This document is not a PDF.");
        }
        let file = match doc.file.try_clone() {
            Ok(file) => file,
            Err(err) => return text(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
        };
        let len = doc.len;
        let response = byte_response(method, request, &file, len, "application/pdf", 0);
        record_doc_stats(&mut self.stats, &response, len);
        response
    }

    fn handle_asset(
        &mut self,
        method: &Method,
        rest: &str,
        request: &Request<Vec<u8>>,
    ) -> Response<Vec<u8>> {
        if *method != Method::GET && *method != Method::HEAD {
            return text(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed.");
        }
        let Some((id_str, rel)) = rest.split_once('/') else {
            return text(StatusCode::NOT_FOUND, "Missing asset path.");
        };
        let Ok(id) = id_str.parse::<u64>() else {
            return text(StatusCode::NOT_FOUND, "Unknown document.");
        };
        let Some(doc) = self.current.as_ref() else {
            return text(StatusCode::NOT_FOUND, "No document is open.");
        };
        if doc.id != id {
            return text(StatusCode::NOT_FOUND, "That document is no longer open.");
        }
        let root = doc.root.clone();
        let Some(rel) = decode_path_segment(rel) else {
            return text(StatusCode::BAD_REQUEST, "Bad asset path.");
        };
        let Ok(path) = resolve_asset(&root, &rel) else {
            return text(StatusCode::FORBIDDEN, "That image is outside the document folder.");
        };
        let ext = extension_of(&path).unwrap_or_default();
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(_) => return text(StatusCode::NOT_FOUND, "Image not found."),
        };
        let len = match file.metadata() {
            Ok(meta) => meta.len(),
            Err(err) => return text(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
        };
        if ext == "svg" {
            if len > MAX_SVG_BYTES {
                return text(StatusCode::FORBIDDEN, "SVG is too large.");
            }
            let raw = match read_at(&file, 0, len as usize) {
                Ok(raw) => raw,
                Err(err) => return text(StatusCode::INTERNAL_SERVER_ERROR, &err.to_string()),
            };
            if !looks_like_svg(&raw) {
                return text(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Not an SVG image.");
            }
            let text = String::from_utf8_lossy(&raw);
            let clean = sanitize_svg(&text).into_bytes();
            self.stats.asset_requests += 1;
            self.stats.requests += 1;
            self.stats.bytes_served += clean.len() as u64;
            return byte_slice_response(method, request, &clean, "image/svg+xml");
        }
        if len > MAX_ASSET_BYTES {
            return text(StatusCode::FORBIDDEN, "Image is too large.");
        }
        let magic = read_at(&file, 0, 32.min(len as usize)).unwrap_or_default();
        let Some(content_type) = image_content_type(&ext, &magic) else {
            return text(StatusCode::UNSUPPORTED_MEDIA_TYPE, "Unsupported image type.");
        };
        self.stats.asset_requests += 1;
        let response = byte_response(method, request, &file, len, content_type, 0);
        self.stats.requests += 1;
        if let Some(body_len) = response.body().len().checked_into() {
            self.stats.bytes_served += body_len;
        }
        response
    }

    fn doc(&self, id: u64) -> Result<&OpenDocument, OpenError> {
        match self.current.as_ref() {
            Some(doc) if doc.id == id => Ok(doc),
            _ => Err(OpenError::NotFound),
        }
    }
}

trait IntoU64 {
    fn checked_into(self) -> Option<u64>;
}
impl IntoU64 for usize {
    fn checked_into(self) -> Option<u64> {
        u64::try_from(self).ok()
    }
}

fn info_of(doc: &OpenDocument) -> OpenedInfo {
    OpenedInfo {
        id: doc.id,
        kind: match doc.detection {
            Detection::Pdf { .. } => "pdf",
            Detection::Markdown { .. } => "markdown",
        }
        .into(),
        name: doc.name.clone(),
        path: doc.path.to_string_lossy().into_owned(),
        len: doc.len,
        bom: bom_name(doc.bom).into(),
        extension: doc.extension.clone(),
        sniff_us: doc.sniff_us,
    }
}

fn bom_name(bom: Bom) -> &'static str {
    match bom {
        Bom::None => "none",
        Bom::Utf8 => "utf-8",
        Bom::Utf16Le => "utf-16le",
        Bom::Utf16Be => "utf-16be",
    }
}

pub fn decode_path_segment(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = from_hex(bytes[i + 1])?;
            let lo = from_hex(bytes[i + 2])?;
            out.push((hi << 4) | lo);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn from_hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn resolve_asset(root: &Path, rel: &str) -> Result<PathBuf, ()> {
    if rel.is_empty() || rel.contains('\0') {
        return Err(());
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err(());
    }
    let joined = root.join(rel_path);
    let canon = joined.canonicalize().map_err(|_| ())?;
    if !path_within(root, &canon) {
        return Err(());
    }
    if !canon.is_file() {
        return Err(());
    }
    Ok(canon)
}

fn path_within(root: &Path, candidate: &Path) -> bool {
    if !candidate.starts_with(root) {
        return false;
    }
    let fs_root = root.parent().is_none() || root.components().count() <= 1;
    if fs_root {
        return candidate.parent() == Some(root);
    }
    true
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    let text = String::from_utf8_lossy(bytes);
    let trimmed = text.trim_start().to_ascii_lowercase();
    trimmed.starts_with("<svg") || (trimmed.starts_with("<?xml") && trimmed.contains("<svg"))
}

fn image_content_type(ext: &str, magic: &[u8]) -> Option<&'static str> {
    let ok = match ext {
        "png" => magic.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" | "jpeg" => magic.starts_with(&[0xFF, 0xD8, 0xFF]),
        "gif" => magic.starts_with(b"GIF87a") || magic.starts_with(b"GIF89a"),
        "webp" => magic.len() >= 12 && &magic[..4] == b"RIFF" && &magic[8..12] == b"WEBP",
        "bmp" => magic.starts_with(b"BM"),
        "ico" => magic.len() >= 4 && magic[0] == 0 && magic[1] == 0 && magic[2] == 1,
        _ => false,
    };
    if !ok {
        return None;
    }
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        _ => return None,
    })
}

fn byte_response(
    method: &Method,
    request: &Request<Vec<u8>>,
    file: &File,
    len: u64,
    content_type: &str,
    _id: u64,
) -> Response<Vec<u8>> {
    if *method == Method::HEAD {
        return empty(StatusCode::OK, Some((len, content_type, None)));
    }
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    let Some(spec) = range else {
        if len > MAX_RANGE {
            return text(
                StatusCode::RANGE_NOT_SATISFIABLE,
                "Refusing to send the entire file in one response.",
            );
        }
        let body = read_at(file, 0, len as usize).unwrap_or_default();
        return full_body(StatusCode::OK, content_type, len, body, true);
    };
    match parse_range(spec, len) {
        Ok((start, end)) => {
            let end = end.min(start.saturating_add(MAX_RANGE - 1)).min(len.saturating_sub(1));
            let n = (end - start + 1) as usize;
            let body = read_at(file, start, n).unwrap_or_default();
            let actual_end = start + body.len().saturating_sub(1) as u64;
            ranged_body(content_type, start, actual_end, len, body)
        }
        Err(()) => unsatisfiable(len),
    }
}

fn byte_slice_response(
    method: &Method,
    request: &Request<Vec<u8>>,
    bytes: &[u8],
    content_type: &str,
) -> Response<Vec<u8>> {
    let len = bytes.len() as u64;
    if *method == Method::HEAD {
        return empty(StatusCode::OK, Some((len, content_type, None)));
    }
    let range = request
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    let Some(spec) = range else {
        return full_body(StatusCode::OK, content_type, len, bytes.to_vec(), true);
    };
    match parse_range(spec, len) {
        Ok((start, end)) => {
            let slice = bytes[start as usize..=end as usize].to_vec();
            ranged_body(content_type, start, end, len, slice)
        }
        Err(()) => unsatisfiable(len),
    }
}

fn parse_range(header: &str, len: u64) -> Result<(u64, u64), ()> {
    if len == 0 {
        return Err(());
    }
    let rest = header.trim().strip_prefix("bytes=").ok_or(())?;
    if rest.contains(',') {
        return Err(());
    }
    if let Some(suffix) = rest.strip_prefix('-') {
        let n: u64 = suffix.parse().map_err(|_| ())?;
        if n == 0 {
            return Err(());
        }
        let n = n.min(len);
        return Ok((len - n, len - 1));
    }
    let (start_s, end_s) = rest.split_once('-').ok_or(())?;
    let start: u64 = start_s.parse().map_err(|_| ())?;
    if start >= len {
        return Err(());
    }
    let end = if end_s.is_empty() {
        len - 1
    } else {
        end_s.parse::<u64>().map_err(|_| ())?.min(len - 1)
    };
    if end < start {
        return Err(());
    }
    Ok((start, end))
}

fn record_doc_stats(stats: &mut TransportStats, response: &Response<Vec<u8>>, len: u64) {
    stats.requests += 1;
    let n = response.body().len() as u64;
    stats.bytes_served += n;
    if response.status() == StatusCode::PARTIAL_CONTENT {
        stats.range_responses += 1;
    } else if response.status() == StatusCode::OK && n == len && len > 0 {
        stats.full_file_responses += 1;
    }
}

fn cors(builder: http::response::Builder) -> http::response::Builder {
    builder
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(
            header::ACCESS_CONTROL_EXPOSE_HEADERS,
            "accept-ranges, content-range, content-length, content-type",
        )
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "range, content-type")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "GET, HEAD, OPTIONS")
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store")
}

fn text(status: StatusCode, message: &str) -> Response<Vec<u8>> {
    cors(Response::builder())
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn empty(
    status: StatusCode,
    length: Option<(u64, &str, Option<String>)>,
) -> Response<Vec<u8>> {
    let mut b = cors(Response::builder()).status(status);
    if let Some((len, content_type, range)) = length {
        b = b
            .header(header::CONTENT_TYPE, content_type)
            .header(header::CONTENT_LENGTH, len.to_string());
        if let Some(range) = range {
            b = b.header(header::CONTENT_RANGE, range);
        }
    }
    b.body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn full_body(
    status: StatusCode,
    content_type: &str,
    len: u64,
    body: Vec<u8>,
    _full: bool,
) -> Response<Vec<u8>> {
    cors(Response::builder())
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .header("x-reader-total", len.to_string())
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn ranged_body(
    content_type: &str,
    start: u64,
    end: u64,
    len: u64,
    body: Vec<u8>,
) -> Response<Vec<u8>> {
    cors(Response::builder())
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CONTENT_LENGTH, body.len().to_string())
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{len}"),
        )
        .body(body)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn unsatisfiable(len: u64) -> Response<Vec<u8>> {
    cors(Response::builder())
        .status(StatusCode::RANGE_NOT_SATISFIABLE)
        .header(header::CONTENT_RANGE, format!("bytes */{len}"))
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

pub type HttpResult = Response<Vec<u8>>;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "reader-proto-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn req(method: &str, uri: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut b = Request::builder().method(method).uri(uri);
        if let Some(range) = range {
            b = b.header("range", range);
        }
        b.body(Vec::new()).unwrap()
    }

    #[test]
    fn ranged_pdf_does_not_require_a_full_read() {
        let tmp = Tmp::new();
        let path = tmp.0.join("doc.bin");
        let mut bytes = b"%PDF-1.7\n".to_vec();
        bytes.extend(std::iter::repeat(b'x').take(200_000));
        let mut f = File::create(&path).unwrap();
        f.write_all(&bytes).unwrap();
        let mut session = DocumentSession::default();
        let info = session.open_path(&path).unwrap();
        assert_eq!(info.kind, "pdf");
        let response = session.handle(&req(
            "GET",
            &format!("/doc/{}", info.id),
            Some("bytes=0-1023"),
        ));
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body().len(), 1024);
        assert_eq!(&response.body()[..8], b"%PDF-1.7");
        let range = response
            .headers()
            .get(header::CONTENT_RANGE)
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();
        assert!(
            range.ends_with(&format!("/{}", info.len)),
            "content-range {range} file {}",
            info.len
        );
        assert_eq!(session.stats.range_responses, 1);
        assert_eq!(session.stats.full_file_responses, 0);
        assert!(session.stats.bytes_served < info.len);

        let denied = session.handle(&req("GET", "/doc/1", None));
        // full file is over MAX_RANGE? 200008 < 16MB so full GET is allowed.
        // Use a fresh assertion: a second open id is rejected.
        let _ = denied;
        let missing = session.handle(&req("GET", "/doc/999", Some("bytes=0-10")));
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn asset_traversal_is_blocked_and_png_is_served() {
        let tmp = Tmp::new();
        let doc_dir = tmp.0.join("doc");
        std::fs::create_dir_all(&doc_dir).unwrap();
        let note = doc_dir.join("note.md");
        std::fs::write(&note, b"# hi\n").unwrap();
        let png = doc_dir.join("pic.png");
        let png_bytes = b"\x89PNG\r\n\x1a\nrest-of-image";
        std::fs::write(&png, png_bytes).unwrap();
        let secret = tmp.0.join("secret.txt");
        std::fs::write(&secret, b"secret").unwrap();
        let outside = tmp.0.join("other.png");
        std::fs::write(&outside, png_bytes).unwrap();

        let mut session = DocumentSession::default();
        let info = session.open_path(&note).unwrap();
        let ok = session.handle(&req(
            "GET",
            &format!("/asset/{}/pic.png", info.id),
            None,
        ));
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.body().as_slice(), png_bytes);

        let climb = session.handle(&req(
            "GET",
            &format!("/asset/{}/..%2Fsecret.txt", info.id),
            None,
        ));
        assert_eq!(climb.status(), StatusCode::FORBIDDEN);

        let sibling = session.handle(&req(
            "GET",
            &format!("/asset/{}/..%2Fother.png", info.id),
            None,
        ));
        assert_eq!(sibling.status(), StatusCode::FORBIDDEN);

        let script = doc_dir.join("bad.svg");
        std::fs::write(&script, b"<svg><script>alert(1)</script></svg>").unwrap();
        let svg = session.handle(&req(
            "GET",
            &format!("/asset/{}/bad.svg", info.id),
            None,
        ));
        assert_eq!(svg.status(), StatusCode::OK);
        assert!(!svg.body().windows(5).any(|w| w == b"alert"));
        assert!(std::str::from_utf8(svg.body()).unwrap().contains("Image blocked"));
    }

    #[test]
    fn opening_another_document_replaces_the_previous_id() {
        let tmp = Tmp::new();
        let a = tmp.0.join("a.md");
        let b = tmp.0.join("b.md");
        std::fs::write(&a, b"# A\n").unwrap();
        std::fs::write(&b, b"%PDF-1.4\n").unwrap();
        let mut session = DocumentSession::default();
        let first = session.open_path(&a).unwrap();
        let second = session.open_path(&b).unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(second.kind, "pdf");
        assert_eq!(session.current().unwrap().id, second.id);
        let stale = session.markdown_text(first.id).unwrap_err();
        assert_eq!(stale, OpenError::NotFound);
    }

    #[test]
    fn prose_with_pdf_token_can_be_reclassified() {
        let tmp = Tmp::new();
        let path = tmp.0.join("notes.md");
        std::fs::write(&path, b"Intro %PDF-1.7 is just words\n").unwrap();
        let mut session = DocumentSession::default();
        let info = session.open_path(&path).unwrap();
        assert_eq!(info.kind, "pdf");
        let again = session.reclassify_failed_pdf().unwrap();
        assert_eq!(again.kind, "markdown");
        let body = session.markdown_text(again.id).unwrap();
        assert!(body.text.contains("words"));
    }

    #[test]
    fn corrupt_header_pdf_stays_invalid() {
        let tmp = Tmp::new();
        let path = tmp.0.join("bad.pdf");
        std::fs::write(&path, b"%PDF-1.7\ngarbage text only").unwrap();
        let mut session = DocumentSession::default();
        let info = session.open_path(&path).unwrap();
        let err = session.reclassify_failed_pdf().unwrap_err();
        assert_eq!(err.message(), "Invalid or unsupported PDF.");
        assert_eq!(info.kind, "pdf");
    }
}

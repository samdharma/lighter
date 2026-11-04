//! Bounded content sniff. Extension is never an input.

/// PDF spec allows the `%PDF-` signature inside the first 1024 bytes.
pub const PDF_SCAN_BYTES: usize = 1024;
/// Text/binary decision uses a bounded sample, not the whole file.
pub const TEXT_SAMPLE_BYTES: usize = 8192;
pub const SNIFF_BYTES: usize = TEXT_SAMPLE_BYTES;

const PDF_SIG: &[u8] = b"%PDF-";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bom {
    None,
    Utf8,
    Utf16Le,
    Utf16Be,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detection {
    Pdf { header_offset: usize },
    Markdown { bom: Bom },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetectError {
    UnsupportedBinary,
}

/// Classify a file from a prefix of at most [`SNIFF_BYTES`].
pub fn detect_prefix(prefix: &[u8]) -> Result<Detection, DetectError> {
    let scan_end = prefix.len().min(PDF_SCAN_BYTES);
    if let Some(offset) = find_pdf_header(&prefix[..scan_end]) {
        return Ok(Detection::Pdf {
            header_offset: offset,
        });
    }
    classify_text(prefix)
}

/// When a PDF parse fails, Markdown is appropriate only if `%PDF-` was not
/// the start of the file and the sample is real text. A corrupt file that
/// begins with the PDF signature stays on the PDF error path.
pub fn fallback_markdown(prefix: &[u8]) -> Option<Detection> {
    let scan_end = prefix.len().min(PDF_SCAN_BYTES);
    let offset = find_pdf_header(&prefix[..scan_end])?;
    if offset == 0 {
        return None;
    }
    classify_text(prefix).ok()
}

fn classify_text(prefix: &[u8]) -> Result<Detection, DetectError> {
    if prefix.is_empty() {
        return Ok(Detection::Markdown { bom: Bom::None });
    }
    match bom_of(prefix) {
        Bom::Utf16Le | Bom::Utf16Be => {
            let bom = bom_of(prefix);
            let text = decode_utf16_sample(prefix, bom).ok_or(DetectError::UnsupportedBinary)?;
            if !text_chars_ok(&text) {
                return Err(DetectError::UnsupportedBinary);
            }
            Ok(Detection::Markdown { bom })
        }
        Bom::Utf8 => {
            let rest = &prefix[3.min(prefix.len())..];
            if !utf8_or_legacy_text(rest) {
                return Err(DetectError::UnsupportedBinary);
            }
            Ok(Detection::Markdown { bom: Bom::Utf8 })
        }
        Bom::None => {
            if !utf8_or_legacy_text(prefix) {
                return Err(DetectError::UnsupportedBinary);
            }
            Ok(Detection::Markdown { bom: Bom::None })
        }
    }
}

pub fn decode_document(bytes: &[u8], bom: Bom) -> String {
    match bom {
        Bom::Utf16Le | Bom::Utf16Be => decode_utf16_lossy(bytes, bom),
        Bom::Utf8 => String::from_utf8_lossy(bytes.get(3..).unwrap_or_default()).into_owned(),
        Bom::None => String::from_utf8_lossy(bytes).into_owned(),
    }
}

fn find_pdf_header(window: &[u8]) -> Option<usize> {
    window.windows(PDF_SIG.len()).position(|w| w == PDF_SIG)
}

fn bom_of(prefix: &[u8]) -> Bom {
    if prefix.starts_with(&[0xEF, 0xBB, 0xBF]) {
        Bom::Utf8
    } else if prefix.starts_with(&[0xFF, 0xFE]) {
        Bom::Utf16Le
    } else if prefix.starts_with(&[0xFE, 0xFF]) {
        Bom::Utf16Be
    } else {
        Bom::None
    }
}

fn utf8_or_legacy_text(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    if has_binary_controls(bytes) {
        return false;
    }
    if std::str::from_utf8(bytes).is_ok() {
        return true;
    }
    legacy_text_ok(bytes)
}

fn has_binary_controls(bytes: &[u8]) -> bool {
    bytes.iter().any(|b| {
        *b == 0 || *b == 0x7F || (*b < 0x20 && !matches!(*b, b'\t' | b'\n' | b'\r' | 0x0C))
    })
}

/// Single-byte text (Latin-1 / Windows-1252-ish) without NULs.
/// Requires mostly ASCII so random high bytes are not treated as Markdown.
fn legacy_text_ok(bytes: &[u8]) -> bool {
    if bytes.is_empty() || has_binary_controls(bytes) {
        return false;
    }
    let mut ascii = 0usize;
    let mut c1 = 0usize;
    for b in bytes {
        if (0x80..0xA0).contains(b) {
            c1 += 1;
        }
        if (0x20..0x7F).contains(b) || matches!(*b, b'\t' | b'\n' | b'\r') {
            ascii += 1;
        }
    }
    if c1.saturating_mul(50) > bytes.len() {
        return false;
    }
    ascii.saturating_mul(100) / bytes.len() >= 70
}

fn text_chars_ok(text: &str) -> bool {
    !text.chars().any(|c| {
        let u = c as u32;
        c == '\u{0}'
            || c == '\u{7F}'
            || (u < 0x20 && !matches!(c, '\t' | '\n' | '\r' | '\u{000C}'))
    })
}

fn decode_utf16_sample(bytes: &[u8], bom: Bom) -> Option<String> {
    let raw = bytes.get(2..)?;
    let even = &raw[..raw.len() - (raw.len() % 2)];
    Some(utf16_units(even, bom).collect())
}

fn decode_utf16_lossy(bytes: &[u8], bom: Bom) -> String {
    let raw = bytes.get(2..).unwrap_or_default();
    let even = &raw[..raw.len() - (raw.len() % 2)];
    utf16_units(even, bom).collect()
}

fn utf16_units(even: &[u8], bom: Bom) -> impl Iterator<Item = char> + '_ {
    let units = even.chunks_exact(2).map(move |c| match bom {
        Bom::Utf16Be => u16::from_be_bytes([c[0], c[1]]),
        _ => u16::from_le_bytes([c[0], c[1]]),
    });
    char::decode_utf16(units).map(|r| r.unwrap_or('\u{FFFD}'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pdf_with_misleading_names_is_still_pdf_by_signature() {
        let bytes = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n";
        assert!(matches!(
            detect_prefix(bytes),
            Ok(Detection::Pdf { header_offset: 0 })
        ));
    }

    #[test]
    fn pdf_header_within_1024_bytes() {
        let mut buf = vec![b' '; 100];
        buf.extend_from_slice(b"%PDF-1.4\n");
        match detect_prefix(&buf) {
            Ok(Detection::Pdf { header_offset }) => assert_eq!(header_offset, 100),
            other => panic!("expected pdf, got {other:?}"),
        }
    }

    #[test]
    fn pdf_header_past_scan_window_is_not_pdf() {
        let mut buf = vec![b'a'; PDF_SCAN_BYTES];
        buf.extend_from_slice(b"%PDF-1.4\n# still text\n");
        assert!(matches!(
            detect_prefix(&buf),
            Ok(Detection::Markdown { .. })
        ));
    }

    #[test]
    fn header_at_last_legal_offset() {
        let mut buf = vec![b' '; 1019];
        buf.extend_from_slice(b"%PDF-");
        assert!(matches!(
            detect_prefix(&buf),
            Ok(Detection::Pdf {
                header_offset: 1019
            })
        ));
    }

    #[test]
    fn markdown_extensionless_txt_and_odd_suffix_are_text() {
        for sample in [
            b"# Notes\n".as_slice(),
            b"plain text\n",
            "笔记\n".as_bytes(),
            b"",
        ] {
            assert!(
                matches!(detect_prefix(sample), Ok(Detection::Markdown { .. })),
                "rejected text sample {sample:?}"
            );
        }
    }

    #[test]
    fn empty_is_markdown() {
        assert_eq!(
            detect_prefix(b"").unwrap(),
            Detection::Markdown { bom: Bom::None }
        );
    }

    #[test]
    fn utf8_bom_markdown() {
        let mut buf = vec![0xEF, 0xBB, 0xBF];
        buf.extend_from_slice("# Title\n".as_bytes());
        assert_eq!(
            detect_prefix(&buf).unwrap(),
            Detection::Markdown { bom: Bom::Utf8 }
        );
    }

    #[test]
    fn utf16_le_and_be_bom_markdown() {
        let le = [0xFF, 0xFE, b'A', 0x00, b'\n', 0x00];
        assert_eq!(
            detect_prefix(&le).unwrap(),
            Detection::Markdown { bom: Bom::Utf16Le }
        );
        let be = [0xFE, 0xFF, 0x00, b'A', 0x00, b'\n'];
        assert_eq!(
            detect_prefix(&be).unwrap(),
            Detection::Markdown { bom: Bom::Utf16Be }
        );
        assert_eq!(decode_document(&le, Bom::Utf16Le), "A\n");
    }

    #[test]
    fn uppercase_extension_is_irrelevant_to_detection() {
        // Same bytes must classify the same way; the function takes no name.
        let md = b"# SAME\n";
        assert!(matches!(
            detect_prefix(md),
            Ok(Detection::Markdown { .. })
        ));
        let pdf = b"%PDF-1.7\n";
        assert!(matches!(detect_prefix(pdf), Ok(Detection::Pdf { .. })));
    }

    #[test]
    fn unsupported_binary_rejected_quickly() {
        let png = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR";
        assert_eq!(detect_prefix(png), Err(DetectError::UnsupportedBinary));
        let elf = b"\x7fELF\x02\x01\x01\x00";
        assert_eq!(detect_prefix(elf), Err(DetectError::UnsupportedBinary));
        let zip = b"PK\x03\x04binary";
        assert_eq!(detect_prefix(zip), Err(DetectError::UnsupportedBinary));
        let nuls = vec![0u8; 64];
        assert_eq!(detect_prefix(&nuls), Err(DetectError::UnsupportedBinary));
        let high = vec![0xFFu8; 128];
        assert_eq!(detect_prefix(&high), Err(DetectError::UnsupportedBinary));
    }

    #[test]
    fn latin1_text_without_nul_is_markdown() {
        let bytes = b"Cafe \xe9 au lait\n";
        assert!(matches!(
            detect_prefix(bytes),
            Ok(Detection::Markdown { bom: Bom::None })
        ));
    }

    #[test]
    fn corrupt_pdf_prefix_does_not_fall_back() {
        let corrupt = b"%PDF-1.7\nthis is not a valid pdf object stream";
        assert!(matches!(
            detect_prefix(corrupt),
            Ok(Detection::Pdf { header_offset: 0 })
        ));
        assert!(fallback_markdown(corrupt).is_none());
        let binary = b"%PDF-1.4\n\x00\x01\x02garbage";
        assert!(fallback_markdown(binary).is_none());
    }

    #[test]
    fn signature_inside_prose_can_fall_back_after_parse_failure() {
        let prose = b"# Notes\nPeople write %PDF-1.7 when they mean a header.\n";
        assert!(matches!(
            detect_prefix(prose),
            Ok(Detection::Pdf {
                header_offset
            }) if header_offset > 0
        ));
        assert!(matches!(
            fallback_markdown(prose),
            Some(Detection::Markdown { .. })
        ));
    }

    #[test]
    fn sample_longer_than_text_window_is_callers_responsibility() {
        // Detection itself only looks at the slice it is given.
        let mut big = vec![b'a'; TEXT_SAMPLE_BYTES + 500];
        big[..5].copy_from_slice(PDF_SIG);
        let sliced = &big[..SNIFF_BYTES];
        assert!(matches!(detect_prefix(sliced), Ok(Detection::Pdf { .. })));
    }
}

use std::fs::{self, File};
use std::io::{self};
use std::path::{Path, PathBuf};

use crate::detect::{detect_prefix, Bom, Detection, SNIFF_BYTES};

/// Markdown bodies above this size are truncated for the WebView.
pub const MAX_MARKDOWN_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpenError {
    NotFound,
    PermissionDenied,
    IsDirectory,
    BrokenLink,
    UnsupportedBinary,
    InvalidPdf,
    Io(String),
}

impl OpenError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound => "not_found",
            Self::PermissionDenied => "permission",
            Self::IsDirectory => "directory",
            Self::BrokenLink => "broken_link",
            Self::UnsupportedBinary => "unsupported",
            Self::InvalidPdf => "invalid_pdf",
            Self::Io(_) => "io",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::NotFound => "File not found.".into(),
            Self::PermissionDenied => "Permission denied. Reader cannot read this file.".into(),
            Self::IsDirectory => "That path is a directory, not a document.".into(),
            Self::BrokenLink => "This shortcut or link is broken.".into(),
            Self::UnsupportedBinary => {
                "Unsupported file. Reader opens PDF and text documents only.".into()
            }
            Self::InvalidPdf => "Invalid or unsupported PDF.".into(),
            Self::Io(detail) => format!("Could not open the file. {detail}"),
        }
    }
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message())
    }
}

impl std::error::Error for OpenError {}

#[derive(Debug)]
pub struct ResolvedFile {
    pub path: PathBuf,
    pub name: String,
    pub extension: Option<String>,
    pub len: u64,
    pub prefix: Vec<u8>,
    pub detection: Detection,
    pub bom: Bom,
    pub file: File,
}

/// Canonicalize `input`, reject directories and broken links, and sniff a bounded prefix.
pub fn resolve_document(input: &Path) -> Result<ResolvedFile, OpenError> {
    let canon = canonicalize_file(input)?;
    let file = File::open(&canon).map_err(map_io)?;
    let len = file.metadata().map_err(map_io)?.len();
    let want = SNIFF_BYTES.min(len as usize);
    let prefix = if want == 0 {
        Vec::new()
    } else {
        read_at(&file, 0, want).map_err(map_io)?
    };
    let detection = detect_prefix(&prefix).map_err(|_| OpenError::UnsupportedBinary)?;
    let bom = match detection {
        Detection::Markdown { bom } => bom,
        Detection::Pdf { .. } => Bom::None,
    };
    let name = canon
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".into());
    Ok(ResolvedFile {
        extension: extension_of(&canon),
        path: canon,
        name,
        len,
        prefix,
        detection,
        bom,
        file,
    })
}

pub fn extension_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty())
}

pub fn read_at(file: &File, offset: u64, len: usize) -> io::Result<Vec<u8>> {
    if len == 0 {
        return Ok(Vec::new());
    }
    #[cfg(unix)]
    {
        use std::io::ErrorKind;
        use std::os::unix::fs::FileExt;
        let mut buf = vec![0u8; len];
        let mut got = 0usize;
        while got < len {
            match file.read_at(&mut buf[got..], offset + got as u64) {
                Ok(0) => break,
                Ok(n) => got += n,
                Err(err) if err.kind() == ErrorKind::Interrupted => continue,
                Err(err) => return Err(err),
            }
        }
        buf.truncate(got);
        Ok(buf)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut buf = vec![0u8; len];
        let n = file.seek_read(&mut buf, offset)?;
        buf.truncate(n);
        Ok(buf)
    }
}

fn canonicalize_file(input: &Path) -> Result<PathBuf, OpenError> {
    let meta = match fs::symlink_metadata(input) {
        Ok(meta) => meta,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Err(OpenError::NotFound),
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => {
            return Err(OpenError::PermissionDenied)
        }
        Err(err) => return Err(OpenError::Io(err.to_string())),
    };

    if meta.file_type().is_symlink() {
        return match input.canonicalize() {
            Ok(path) => ensure_regular_file(path),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Err(OpenError::BrokenLink),
            Err(err) if err.kind() == io::ErrorKind::PermissionDenied => {
                Err(OpenError::PermissionDenied)
            }
            Err(err) => Err(OpenError::Io(err.to_string())),
        };
    }
    if meta.is_dir() {
        return Err(OpenError::IsDirectory);
    }
    if !meta.is_file() {
        return Err(OpenError::UnsupportedBinary);
    }
    match input.canonicalize() {
        Ok(path) => ensure_regular_file(path),
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => {
            Err(OpenError::PermissionDenied)
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Err(OpenError::NotFound),
        Err(err) => Err(OpenError::Io(err.to_string())),
    }
}

fn ensure_regular_file(path: PathBuf) -> Result<PathBuf, OpenError> {
    let meta = fs::metadata(&path).map_err(map_io)?;
    if meta.is_dir() {
        Err(OpenError::IsDirectory)
    } else if meta.is_file() {
        Ok(path)
    } else {
        Err(OpenError::UnsupportedBinary)
    }
}

fn map_io(err: io::Error) -> OpenError {
    match err.kind() {
        io::ErrorKind::NotFound => OpenError::NotFound,
        io::ErrorKind::PermissionDenied => OpenError::PermissionDenied,
        _ => OpenError::Io(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::detect::Detection;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Tmp(PathBuf);
    impl Tmp {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "reader-open-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn child(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, bytes: &[u8]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let mut f = File::create(path).unwrap();
        f.write_all(bytes).unwrap();
    }

    #[test]
    fn acceptance_cases_from_prd_section_4() {
        let tmp = Tmp::new();
        let pdf = b"%PDF-1.7\n1 0 obj<<>>endobj\n";
        let md = b"# Notes\n\nHello\n";

        for name in ["document.bin", "document.md", "document", "DOCUMENT.PDF", "x.Md"] {
            let path = tmp.child(name);
            write(&path, pdf);
            let opened = resolve_document(&path).unwrap();
            assert!(
                matches!(opened.detection, Detection::Pdf { .. }),
                "{name} should be PDF"
            );
            assert!(opened.prefix.len() <= SNIFF_BYTES);
        }

        for name in ["notes", "notes.txt", "notes.data", "NOTES.MD", "Notes.TxT"] {
            let path = tmp.child(name);
            write(&path, md);
            let opened = resolve_document(&path).unwrap();
            assert!(
                matches!(opened.detection, Detection::Markdown { .. }),
                "{name} should be Markdown"
            );
        }

        let empty = tmp.child("empty.txt");
        write(&empty, b"");
        assert!(matches!(
            resolve_document(&empty).unwrap().detection,
            Detection::Markdown { .. }
        ));

        let spaced = tmp.child("my notes.md");
        write(&spaced, md);
        assert!(resolve_document(&spaced).is_ok());

        let unicode = tmp.child("笔记.md");
        write(&unicode, "你好\n".as_bytes());
        let opened = resolve_document(&unicode).unwrap();
        assert!(matches!(opened.detection, Detection::Markdown { .. }));
        assert!(opened.path.to_string_lossy().contains("笔记"));

        let long_name = format!("{}.md", "a".repeat(180));
        let long = tmp.child(&long_name);
        write(&long, md);
        assert!(resolve_document(&long).is_ok());

        let missing = tmp.child("no-such-file.md");
        assert_eq!(
            resolve_document(&missing).unwrap_err(),
            OpenError::NotFound
        );
        assert_eq!(
            OpenError::NotFound.message(),
            "File not found."
        );

        assert_eq!(
            resolve_document(&tmp.0).unwrap_err(),
            OpenError::IsDirectory
        );

        let bin = tmp.child("photo.png");
        write(&bin, b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR");
        assert_eq!(
            resolve_document(&bin).unwrap_err(),
            OpenError::UnsupportedBinary
        );

        let corrupt = tmp.child("corrupt.pdf");
        write(&corrupt, b"%PDF-1.4\n\x00\x01not-a-real-body");
        let opened = resolve_document(&corrupt).unwrap();
        assert!(matches!(opened.detection, Detection::Pdf { .. }));
        assert_eq!(
            OpenError::InvalidPdf.message(),
            "Invalid or unsupported PDF."
        );
    }

    #[test]
    fn sniff_does_not_read_the_whole_file() {
        let tmp = Tmp::new();
        let path = tmp.child("big.md");
        let mut file = File::create(&path).unwrap();
        file.write_all(&vec![b'a'; 2_000_000]).unwrap();
        let opened = resolve_document(&path).unwrap();
        assert_eq!(opened.len, 2_000_000);
        assert_eq!(opened.prefix.len(), SNIFF_BYTES);
        assert!(matches!(opened.detection, Detection::Markdown { .. }));
    }

    #[cfg(unix)]
    #[test]
    fn broken_symlink_and_permission() {
        let tmp = Tmp::new();
        let link = tmp.child("broken.md");
        std::os::unix::fs::symlink(tmp.child("missing-target.md"), &link).unwrap();
        assert_eq!(resolve_document(&link).unwrap_err(), OpenError::BrokenLink);

        let secret = tmp.child("secret.md");
        write(&secret, b"# hidden\n");
        let uid = std::process::Command::new("id")
            .arg("-u")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .unwrap_or_default();
        if uid.trim() == "0" {
            return;
        }
        let mut perms = fs::metadata(&secret).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        perms.set_mode(0);
        fs::set_permissions(&secret, perms).unwrap();
        let err = resolve_document(&secret).unwrap_err();
        let mut restore = fs::metadata(&secret).unwrap().permissions();
        restore.set_mode(0o644);
        fs::set_permissions(&secret, restore).unwrap();
        assert_eq!(err, OpenError::PermissionDenied);
    }

    #[test]
    fn ranged_read_is_a_slice() {
        let tmp = Tmp::new();
        let path = tmp.child("range.bin");
        write(&path, b"0123456789");
        let file = File::open(&path).unwrap();
        assert_eq!(read_at(&file, 3, 4).unwrap(), b"3456");
        assert_eq!(read_at(&file, 8, 10).unwrap(), b"89");
    }
}

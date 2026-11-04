use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Write `bytes` to `dest` via a sibling temp file, fsync, then rename.
///
/// Existing destinations that are symlinks are refused so a save cannot be
/// redirected outside the chosen path. On Unix, `rename` within one directory
/// replaces the destination atomically.
pub fn atomic_write(dest: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = dest.parent().filter(|p| !p.as_os_str().is_empty()).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "destination has no parent directory")
    })?;
    if !parent.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "destination directory does not exist",
        ));
    }
    if let Ok(meta) = fs::symlink_metadata(dest) {
        if meta.file_type().is_symlink() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "refusing to write through a symlink",
            ));
        }
    }

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut tmp_name = dest
        .file_name()
        .unwrap_or_else(|| std::ffi::OsStr::new("reader"))
        .to_os_string();
    tmp_name.push(format!(".reader-tmp-{}-{nanos}", std::process::id()));
    let tmp = parent.join(tmp_name);

    let write_result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok::<(), io::Error>(())
    })();

    if let Err(err) = write_result {
        let _ = fs::remove_file(&tmp);
        return Err(err);
    }

    #[cfg(windows)]
    {
        if dest.exists() {
            let backup = parent.join(format!(
                "{}.reader-bak-{nanos}",
                dest.file_name().and_then(|s| s.to_str()).unwrap_or("file")
            ));
            fs::rename(dest, &backup)?;
            if let Err(err) = fs::rename(&tmp, dest) {
                let _ = fs::rename(&backup, dest);
                let _ = fs::remove_file(&tmp);
                return Err(err);
            }
            let _ = fs::remove_file(&backup);
        } else if let Err(err) = fs::rename(&tmp, dest) {
            let _ = fs::remove_file(&tmp);
            return Err(err);
        }
    }
    #[cfg(not(windows))]
    {
        if let Err(err) = fs::rename(&tmp, dest) {
            let _ = fs::remove_file(&tmp);
            return Err(err);
        }
        if let Ok(dir) = File::open(parent) {
            let _ = dir.sync_all();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    struct Tmp(std::path::PathBuf);
    impl Tmp {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "reader-atomic-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self, name: &str) -> std::path::PathBuf {
            self.0.join(name)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn replaces_existing_without_leaving_temp() {
        let tmp = Tmp::new();
        let dest = tmp.path("notes.pdf");
        atomic_write(&dest, b"one").unwrap();
        atomic_write(&dest, b"two-two").unwrap();
        let mut got = String::new();
        File::open(&dest).unwrap().read_to_string(&mut got).unwrap();
        assert_eq!(got, "two-two");
        let leftovers: Vec<_> = fs::read_dir(&tmp.0)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains("reader-tmp") || n.contains("reader-bak"))
            .collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
    }

    #[test]
    fn refuses_symlink_destination() {
        let tmp = Tmp::new();
        let real = tmp.path("real.pdf");
        let link = tmp.path("link.pdf");
        atomic_write(&real, b"original").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&real, &link).unwrap();
            let err = atomic_write(&link, b"pwned").unwrap_err();
            assert_eq!(err.kind(), io::ErrorKind::AlreadyExists);
            let mut got = String::new();
            File::open(&real).unwrap().read_to_string(&mut got).unwrap();
            assert_eq!(got, "original");
        }
    }
}

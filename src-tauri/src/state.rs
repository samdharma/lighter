use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use reader_core::{DocumentSession, SettingsStore};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiError {
    pub code: String,
    pub message: String,
}

pub struct Perf {
    pub started: Instant,
    pub marks: Mutex<Vec<(String, u128)>>,
}

impl Perf {
    pub fn mark(&self, name: &str) -> u128 {
        let ms = self.started.elapsed().as_millis();
        if std::env::var_os("READER_PERF").is_some() {
            eprintln!("reader_perf {name}_ms={ms}");
        }
        if let Ok(mut marks) = self.marks.lock() {
            marks.push((name.to_string(), ms));
            if marks.len() > 64 {
                let drop_n = marks.len() - 64;
                marks.drain(0..drop_n);
            }
        }
        ms
    }
}

pub struct AppState {
    pub session: Mutex<DocumentSession>,
    pub settings: Mutex<SettingsStore>,
    pub perf: Perf,
    pub recent_snapshot: Mutex<Vec<String>>,
    pub last_error: Mutex<Option<UiError>>,
}

impl AppState {
    pub fn new(settings_path: PathBuf, started: Instant) -> Self {
        let store = SettingsStore::load(settings_path);
        let recent = store.settings.recent.clone();
        Self {
            session: Mutex::new(DocumentSession::default()),
            settings: Mutex::new(store),
            perf: Perf {
                started,
                marks: Mutex::new(Vec::new()),
            },
            recent_snapshot: Mutex::new(recent),
            last_error: Mutex::new(None),
        }
    }
}

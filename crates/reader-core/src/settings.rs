use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::atomic::atomic_write;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadingPosition {
    pub path: String,
    pub page: Option<u32>,
    pub anchor: Option<String>,
    pub scroll_ratio: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: String,
    pub zoom: f64,
    pub pdf_view: String,
    pub markdown_mode: String,
    pub window_width: f64,
    pub window_height: f64,
    #[serde(default)]
    pub window_x: Option<f64>,
    #[serde(default)]
    pub window_y: Option<f64>,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub recent: Vec<String>,
    #[serde(default)]
    pub positions: Vec<ReadingPosition>,
    #[serde(default)]
    pub remote_allowed: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            zoom: 1.0,
            pdf_view: "continuous".into(),
            markdown_mode: "rendered".into(),
            window_width: 1100.0,
            window_height: 780.0,
            window_x: None,
            window_y: None,
            maximized: false,
            recent: Vec::new(),
            positions: Vec::new(),
            remote_allowed: Vec::new(),
        }
    }
}

impl Settings {
    pub fn sanitize(&mut self) {
        if !matches!(self.theme.as_str(), "system" | "light" | "dark") {
            self.theme = "system".into();
        }
        if !self.zoom.is_finite() {
            self.zoom = 1.0;
        }
        self.zoom = self.zoom.clamp(0.25, 6.0);
        if !matches!(self.pdf_view.as_str(), "continuous" | "single") {
            self.pdf_view = "continuous".into();
        }
        if !matches!(self.markdown_mode.as_str(), "rendered" | "raw") {
            self.markdown_mode = "rendered".into();
        }
        if !self.window_width.is_finite() || self.window_width < 640.0 {
            self.window_width = 1100.0;
        }
        if !self.window_height.is_finite() || self.window_height < 480.0 {
            self.window_height = 780.0;
        }
        self.window_width = self.window_width.min(8000.0);
        self.window_height = self.window_height.min(8000.0);
        self.recent.truncate(10);
        self.positions.truncate(30);
        self.remote_allowed.truncate(20);
        for pos in &mut self.positions {
            if !pos.scroll_ratio.is_finite() {
                pos.scroll_ratio = 0.0;
            }
            pos.scroll_ratio = pos.scroll_ratio.clamp(0.0, 1.0);
        }
    }

    pub fn push_recent(&mut self, path: String) {
        self.recent.retain(|p| p != &path);
        self.recent.insert(0, path);
        self.recent.truncate(10);
    }

    pub fn remember_position(&mut self, position: ReadingPosition) {
        self.positions.retain(|p| p.path != position.path);
        self.positions.insert(0, position);
        self.positions.truncate(30);
    }

    pub fn set_remote(&mut self, path: String, allowed: bool) {
        self.remote_allowed.retain(|p| p != &path);
        if allowed {
            self.remote_allowed.insert(0, path);
            self.remote_allowed.truncate(20);
        }
    }
}

pub struct SettingsStore {
    pub path: std::path::PathBuf,
    pub settings: Settings,
}

impl SettingsStore {
    pub fn load(path: impl Into<std::path::PathBuf>) -> Self {
        let path = path.into();
        let settings = read_or_recover(&path);
        Self { path, settings }
    }

    pub fn save(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(&self.settings)
            .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))?;
        atomic_write(&self.path, &bytes)
    }

    pub fn update(&mut self, mut next: Settings) -> std::io::Result<()> {
        next.sanitize();
        self.settings = next;
        self.save()
    }
}

fn read_or_recover(path: &Path) -> Settings {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return Settings::default(),
    };
    match serde_json::from_slice::<Settings>(&bytes) {
        Ok(mut settings) => {
            settings.sanitize();
            settings
        }
        Err(_) => {
            let bad = path.with_extension("json.corrupt");
            let _ = fs::rename(path, bad);
            Settings::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn corrupt_settings_recover_and_recent_is_capped() {
        let dir = std::env::temp_dir().join(format!(
            "reader-settings-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, b"{not json").unwrap();
        let store = SettingsStore::load(&path);
        assert_eq!(store.settings, Settings::default());
        assert!(dir.join("settings.json.corrupt").is_file());

        let mut settings = Settings::default();
        for i in 0..15 {
            settings.push_recent(format!("/tmp/file-{i}.md"));
        }
        assert_eq!(settings.recent.len(), 10);
        assert_eq!(settings.recent[0], "/tmp/file-14.md");
        settings.push_recent("/tmp/file-14.md".into());
        assert_eq!(settings.recent[0], "/tmp/file-14.md");
        assert_eq!(settings.recent.len(), 10);

        settings.theme = "nope".into();
        settings.zoom = 99.0;
        settings.sanitize();
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.zoom, 6.0);

        let mut store = SettingsStore::load(dir.join("fresh.json"));
        store.update(settings.clone()).unwrap();
        let again = SettingsStore::load(dir.join("fresh.json"));
        assert_eq!(again.settings.zoom, 6.0);
        let _ = fs::remove_dir_all(&dir);
    }
}

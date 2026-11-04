mod commands;
mod menu;
mod state;

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, RunEvent, WebviewUrl, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::state::AppState;

static STARTED: OnceLock<Instant> = OnceLock::new();

pub fn run() {
    let _ = STARTED.set(Instant::now());
    let started = STARTED.get().copied().unwrap_or_else(Instant::now);
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new(PathBuf::from("settings-unset.json"), started))
        .register_uri_scheme_protocol("reader", |ctx, request| {
            let state = ctx.app_handle().state::<AppState>();
            let mut session = state.session.lock().unwrap_or_else(|err| err.into_inner());
            session.handle(&request)
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir().unwrap_or_else(|_| {
                std::env::temp_dir().join("reader-dev")
            });
            let _ = std::fs::create_dir_all(&config_dir);
            let settings_path = config_dir.join("settings.json");
            {
                let state = app.state::<AppState>();
                let loaded = reader_core::SettingsStore::load(&settings_path);
                *state.settings.lock().unwrap_or_else(|err| err.into_inner()) = loaded;
            }
            let settings = app
                .state::<AppState>()
                .settings
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .settings
                .clone();

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Reader")
                .inner_size(settings.window_width, settings.window_height)
                .min_inner_size(720.0, 480.0)
                .visible(false)
                .zoom_hotkeys_enabled(false)
                .on_navigation(|url| allow_navigation(url))
                .on_new_window(|_url, _features| NewWindowResponse::Deny)
                .build()?;

            if settings.maximized {
                let _ = window.maximize();
            } else if let (Some(x), Some(y)) = (settings.window_x, settings.window_y) {
                let pos = PhysicalPosition::new(x.round() as i32, y.round() as i32);
                if position_is_usable(&window, pos) {
                    let _ = window.set_position(pos);
                }
            }
            let _ = window.show();
            app.state::<AppState>().perf.mark("window_shown");

            menu::install_menu(app.handle())?;
            if let Some(path) = cli_path() {
                let _ = commands::open_and_emit(app.handle(), path);
            }
            Ok(())
        })
        .on_menu_event(|app, event| handle_menu(app, event.id.as_ref()))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                persist_window(window);
            }
        })
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                if let Some(path) = paths.first() {
                    let _ = commands::open_and_emit(webview.app_handle(), path.clone());
                }
            }
        })
        .invoke_handler(commands::command_handler())
        .build(tauri::generate_context!())
        .expect("Reader failed to start")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            if let RunEvent::Opened { ref urls } = event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        let _ = commands::open_and_emit(app, path);
                    }
                }
            }
            if let RunEvent::Exit = &event {
                // No resident process: the runtime ends when the last window closes.
                let _ = app;
            }
        });
}

fn allow_navigation(url: &tauri::Url) -> bool {
    let value = url.as_str();
    value.starts_with("http://127.0.0.1:1420")
        || value.starts_with("http://localhost:1420")
        || value.starts_with("tauri://")
        || value.starts_with("http://tauri.localhost")
        || value.starts_with("https://tauri.localhost")
        || value.starts_with("reader://")
        || value.starts_with("http://reader.localhost")
        || value.starts_with("about:")
}

fn position_is_usable(window: &tauri::WebviewWindow, pos: PhysicalPosition<i32>) -> bool {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return true;
    };
    let origin = monitor.position();
    let size = monitor.size();
    let x = pos.x;
    let y = pos.y;
    x >= origin.x - 40
        && y >= origin.y - 40
        && x < origin.x + size.width as i32
        && y < origin.y + size.height as i32
}

fn persist_window(window: &tauri::Window) {
    let app = window.app_handle();
    let state = app.state::<AppState>();
    let mut store = state.settings.lock().unwrap_or_else(|err| err.into_inner());
    if let Ok(size) = window.outer_size() {
        store.settings.window_width = size.width as f64;
        store.settings.window_height = size.height as f64;
    }
    if let Ok(pos) = window.outer_position() {
        store.settings.window_x = Some(pos.x as f64);
        store.settings.window_y = Some(pos.y as f64);
    }
    if let Ok(max) = window.is_maximized() {
        store.settings.maximized = max;
    }
    store.settings.sanitize();
    if let Err(err) = store.save() {
        eprintln!("reader: could not save window geometry: {err}");
    }
}

fn cli_path() -> Option<PathBuf> {
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        let text = arg.to_string_lossy();
        if text == "--" {
            return args.next().map(PathBuf::from);
        }
        if text.starts_with('-') {
            continue;
        }
        return Some(PathBuf::from(arg));
    }
    None
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => pick_and_open(app),
        "close-doc" => {
            app.state::<AppState>()
                .session
                .lock()
                .unwrap_or_else(|err| err.into_inner())
                .close();
            let _ = app.emit("document-closed", ());
        }
        "clear-recent" => {
            let state = app.state::<AppState>();
            let mut store = state.settings.lock().unwrap_or_else(|err| err.into_inner());
            store.settings.recent.clear();
            let _ = store.save();
            drop(store);
            let _ = menu::install_menu(app);
            menu::emit_action(app, "clear-recent");
        }
        id if id.starts_with("recent-") => {
            if id == "recent-empty" {
                return;
            }
            let index = id.trim_start_matches("recent-").parse::<usize>().ok();
            let path = index.and_then(|index| {
                app.state::<AppState>()
                    .recent_snapshot
                    .lock()
                    .ok()
                    .and_then(|snap| snap.get(index).cloned())
            });
            if let Some(path) = path {
                let _ = commands::open_and_emit(app, PathBuf::from(path));
            }
        }
        other => menu::emit_action(app, other),
    }
}

fn pick_and_open(app: &AppHandle) {
    let handle = app.clone();
    app.dialog().file().pick_file(move |picked| {
        let Some(picked) = picked else {
            return;
        };
        if let Some(path) = file_path_to_buf(picked) {
            let _ = commands::open_and_emit(&handle, path);
        }
    });
}

fn file_path_to_buf(path: FilePath) -> Option<PathBuf> {
    path.into_path().ok()
}

#[cfg(test)]
mod capability_tests {
    #[test]
    fn capabilities_do_not_grant_filesystem_or_shell() {
        let cap = include_str!("../capabilities/default.json");
        let lowered = cap.to_ascii_lowercase();
        assert!(!lowered.contains("fs:"));
        assert!(!lowered.contains("shell:"));
        assert!(!lowered.contains("open-path"));
        assert!(!lowered.contains("reveal"));
        assert!(!lowered.contains("updater"));
    }

    #[test]
    fn cargo_manifest_does_not_depend_on_fs_or_shell_plugins() {
        let manifest = include_str!("../Cargo.toml");
        assert!(!manifest.contains("tauri-plugin-fs"));
        assert!(!manifest.contains("tauri-plugin-shell"));
        assert!(!manifest.contains("tauri-plugin-updater"));
    }
}

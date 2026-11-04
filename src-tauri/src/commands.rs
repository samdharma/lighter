use std::path::PathBuf;

use reader_core::{OpenError, ReadingPosition, Settings, TransportStats};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::menu::install_menu;
use crate::state::{AppState, UiError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CommandError {
    code: String,
    message: String,
}

impl From<OpenError> for CommandError {
    fn from(err: OpenError) -> Self {
        Self {
            code: err.code().into(),
            message: err.message(),
        }
    }
}

fn fail(err: impl std::fmt::Display) -> CommandError {
    CommandError {
        code: "error".into(),
        message: err.to_string(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionView {
    document: Option<reader_core::OpenedInfo>,
    error: Option<UiError>,
}

#[tauri::command]
fn session_state(state: State<AppState>) -> SessionView {
    let document = state
        .session
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .current();
    let error = state
        .last_error
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone();
    SessionView { document, error }
}

#[tauri::command]
fn open_path(app: AppHandle, path: String) -> Result<reader_core::OpenedInfo, CommandError> {
    open_and_emit(&app, PathBuf::from(&path))
}

pub fn open_and_emit(
    app: &AppHandle,
    path: PathBuf,
) -> Result<reader_core::OpenedInfo, CommandError> {
    let state = app.state::<AppState>();
    let opened = {
        let mut session = state.session.lock().unwrap_or_else(|err| err.into_inner());
        match session.open_path(&path) {
            Ok(opened) => opened,
            Err(err) => {
                let ui = UiError {
                    code: err.code().into(),
                    message: err.message(),
                };
                *state
                    .last_error
                    .lock()
                    .unwrap_or_else(|poison| poison.into_inner()) = Some(ui.clone());
                let _ = app.emit("document-error", &ui);
                return Err(CommandError {
                    code: ui.code,
                    message: ui.message,
                });
            }
        }
    };
    *state
        .last_error
        .lock()
        .unwrap_or_else(|poison| poison.into_inner()) = None;
    {
        let mut settings = state.settings.lock().unwrap_or_else(|err| err.into_inner());
        settings.settings.push_recent(opened.path.clone());
        if let Err(err) = settings.save() {
            eprintln!("reader: could not save recent list: {err}");
        }
    }
    if let Err(err) = install_menu(app) {
        eprintln!("reader: could not refresh menu: {err}");
    }
    state.perf.mark("document_sniffed");
    if std::env::var_os("READER_PERF").is_some() {
        eprintln!(
            "reader_perf sniff_us={} kind={} bytes={}",
            opened.sniff_us, opened.kind, opened.len
        );
    }
    let _ = app.emit("document-opened", &opened);
    Ok(opened)
}

#[tauri::command]
fn close_document(app: AppHandle) {
    let state = app.state::<AppState>();
    state
        .session
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .close();
    let _ = app.emit("document-closed", ());
}

#[tauri::command]
fn markdown_text(
    state: State<AppState>,
    id: u64,
) -> Result<reader_core::MarkdownBody, CommandError> {
    state
        .session
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .markdown_text(id)
        .map_err(CommandError::from)
}

#[tauri::command]
fn reclassify_failed_pdf(
    app: AppHandle,
    id: u64,
) -> Result<reader_core::OpenedInfo, CommandError> {
    let state = app.state::<AppState>();
    let opened = {
        let mut session = state.session.lock().unwrap_or_else(|err| err.into_inner());
        let current_id = session.current().map(|d| d.id);
        if current_id != Some(id) {
            return Err(OpenError::NotFound.into());
        }
        session.reclassify_failed_pdf().map_err(CommandError::from)?
    };
    let _ = app.emit("document-opened", &opened);
    Ok(opened)
}

#[tauri::command]
fn get_settings(state: State<AppState>) -> Settings {
    state
        .settings
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .settings
        .clone()
}

#[tauri::command]
fn update_settings(app: AppHandle, settings: Settings) -> Result<Settings, CommandError> {
    let state = app.state::<AppState>();
    {
        let mut store = state.settings.lock().unwrap_or_else(|err| err.into_inner());
        let recent = store.settings.recent.clone();
        let positions = store.settings.positions.clone();
        let remote = store.settings.remote_allowed.clone();
        let mut next = settings;
        next.recent = recent;
        next.positions = positions;
        next.remote_allowed = remote;
        store.update(next).map_err(fail)?;
        let saved = store.settings.clone();
        drop(store);
        install_menu(&app).map_err(fail)?;
        Ok(saved)
    }
}

#[tauri::command]
fn clear_recent(app: AppHandle) -> Result<(), CommandError> {
    let state = app.state::<AppState>();
    {
        let mut store = state.settings.lock().unwrap_or_else(|err| err.into_inner());
        store.settings.recent.clear();
        store.save().map_err(fail)?;
    }
    install_menu(&app).map_err(fail)?;
    Ok(())
}

#[tauri::command]
fn remember_position(state: State<AppState>, position: ReadingPosition) -> Result<(), CommandError> {
    let mut store = state.settings.lock().unwrap_or_else(|err| err.into_inner());
    store.settings.remember_position(position);
    store.save().map_err(fail)
}

#[tauri::command]
fn set_remote_allowed(
    state: State<AppState>,
    path: String,
    allowed: bool,
) -> Result<Settings, CommandError> {
    let mut store = state.settings.lock().unwrap_or_else(|err| err.into_inner());
    store.settings.set_remote(path, allowed);
    store.save().map_err(fail)?;
    Ok(store.settings.clone())
}

#[tauri::command]
fn transport_stats(state: State<AppState>) -> TransportStats {
    state
        .session
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .stats
        .clone()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PerfSnapshot {
    marks: Vec<(String, u128)>,
    stats: TransportStats,
}

#[tauri::command]
fn mark_perf(state: State<AppState>, name: String) -> PerfSnapshot {
    state.perf.mark(&name);
    if name == "pdf_first_page" && std::env::var_os("READER_PERF").is_some() {
        let stats = state
            .session
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .stats
            .clone();
        eprintln!(
            "reader_perf range_responses={} bytes_served={} full_file_responses={} requests={}",
            stats.range_responses, stats.bytes_served, stats.full_file_responses, stats.requests
        );
    }
    snapshot(&state)
}

#[tauri::command]
fn perf_snapshot(state: State<AppState>) -> PerfSnapshot {
    snapshot(&state)
}

fn snapshot(state: &AppState) -> PerfSnapshot {
    let marks = state
        .perf
        .marks
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone();
    let stats = state
        .session
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .stats
        .clone();
    PerfSnapshot { marks, stats }
}

#[tauri::command]
fn reader_origin() -> String {
    #[cfg(windows)]
    {
        "http://reader.localhost".into()
    }
    #[cfg(not(windows))]
    {
        "reader://localhost".into()
    }
}

pub fn command_handler() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        session_state,
        open_path,
        close_document,
        markdown_text,
        reclassify_failed_pdf,
        get_settings,
        update_settings,
        clear_recent,
        remember_position,
        set_remote_allowed,
        transport_stats,
        mark_perf,
        perf_snapshot,
        reader_origin,
    ]
}

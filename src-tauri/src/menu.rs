use tauri::menu::{
    CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID,
};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::state::AppState;

pub fn install_menu(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    app.set_menu(menu)?;
    #[cfg(target_os = "macos")]
    if let Some(menu) = app.menu() {
        let _ = menu.set_as_app_menu();
    }
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let settings = app
        .state::<AppState>()
        .settings
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .settings
        .clone();
    if let Ok(mut snap) = app.state::<AppState>().recent_snapshot.lock() {
        *snap = settings.recent.clone();
    }

    let open = MenuItem::with_id(app, "open", "Open…", true, Some("CmdOrCtrl+O"))?;
    let recent_menu = recent_submenu(app, &settings.recent)?;
    let close_doc = MenuItem::with_id(app, "close-doc", "Close", true, Some("CmdOrCtrl+W"))?;
    let find = MenuItem::with_id(app, "find", "Find…", true, Some("CmdOrCtrl+F"))?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let toc = MenuItem::with_id(app, "toggle-toc", "Contents", true, None::<&str>)?;
    let mode = MenuItem::with_id(
        app,
        "toggle-mode",
        "Rendered / Raw",
        true,
        Some("CmdOrCtrl+E"),
    )?;
    let zoom_in = MenuItem::with_id(app, "zoom-in", "Zoom In", true, Some("CmdOrCtrl+Plus"))?;
    let zoom_out = MenuItem::with_id(app, "zoom-out", "Zoom Out", true, Some("CmdOrCtrl+Minus"))?;
    let zoom_reset = MenuItem::with_id(app, "zoom-reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;
    let fit_width = MenuItem::with_id(app, "fit-width", "Fit Width", true, None::<&str>)?;
    let fit_page = MenuItem::with_id(app, "fit-page", "Fit Page", true, None::<&str>)?;
    let continuous = CheckMenuItem::with_id(
        app,
        "view-continuous",
        "Continuous Scroll",
        true,
        settings.pdf_view != "single",
        None::<&str>,
    )?;
    let single = CheckMenuItem::with_id(
        app,
        "view-single",
        "Single Page",
        true,
        settings.pdf_view == "single",
        None::<&str>,
    )?;
    let rot_cw = MenuItem::with_id(app, "rotate-cw", "Rotate Clockwise", true, None::<&str>)?;
    let rot_ccw = MenuItem::with_id(
        app,
        "rotate-ccw",
        "Rotate Counterclockwise",
        true,
        None::<&str>,
    )?;
    let theme_system = CheckMenuItem::with_id(
        app,
        "theme-system",
        "Theme: System",
        true,
        settings.theme == "system",
        None::<&str>,
    )?;
    let theme_light = CheckMenuItem::with_id(
        app,
        "theme-light",
        "Theme: Light",
        true,
        settings.theme == "light",
        None::<&str>,
    )?;
    let theme_dark = CheckMenuItem::with_id(
        app,
        "theme-dark",
        "Theme: Dark",
        true,
        settings.theme == "dark",
        None::<&str>,
    )?;
    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let shortcuts = MenuItem::with_id(app, "shortcuts", "Keyboard Shortcuts", true, None::<&str>)?;

    let file = Submenu::new(app, "File", true)?;
    file.append(&open)?;
    file.append(&recent_menu)?;
    file.append(&PredefinedMenuItem::separator(app)?)?;
    file.append(&close_doc)?;
    #[cfg(not(target_os = "macos"))]
    {
        file.append(&PredefinedMenuItem::separator(app)?)?;
        file.append(&PredefinedMenuItem::quit(app, Some("Quit Reader"))?)?;
    }

    let edit = Submenu::with_items(app, "Edit", true, &[&find, &copy, &select_all])?;
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &toc,
            &mode,
            &zoom_in,
            &zoom_out,
            &zoom_reset,
            &fit_width,
            &fit_page,
            &continuous,
            &single,
            &rot_cw,
            &rot_ccw,
            &theme_system,
            &theme_light,
            &theme_dark,
        ],
    )?;
    let window = Submenu::with_id_and_items(app, WINDOW_SUBMENU_ID, "Window", true, &[&minimize])?;
    let help = Submenu::with_id_and_items(app, HELP_SUBMENU_ID, "Help", true, &[&shortcuts])?;

    #[cfg(target_os = "macos")]
    {
        let about = PredefinedMenuItem::about(app, Some("About Reader"), None)?;
        let hide = PredefinedMenuItem::hide(app, None)?;
        let hide_others = PredefinedMenuItem::hide_others(app, None)?;
        let show_all = PredefinedMenuItem::show_all(app, None)?;
        let sep_a = PredefinedMenuItem::separator(app)?;
        let sep_b = PredefinedMenuItem::separator(app)?;
        let quit = PredefinedMenuItem::quit(app, Some("Quit Reader"))?;
        let app_menu = Submenu::with_items(
            app,
            "Reader",
            true,
            &[&about, &sep_a, &hide, &hide_others, &show_all, &sep_b, &quit],
        )?;
        return Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window, &help]);
    }
    #[cfg(not(target_os = "macos"))]
    {
        Menu::with_items(app, &[&file, &edit, &view, &window, &help])
    }
}

fn recent_submenu(app: &AppHandle, recent: &[String]) -> tauri::Result<Submenu<Wry>> {
    let menu = Submenu::with_id(app, "recent", "Open Recent", true)?;
    if recent.is_empty() {
        menu.append(&MenuItem::with_id(
            app,
            "recent-empty",
            "Nothing recent",
            false,
            None::<&str>,
        )?)?;
        return Ok(menu);
    }
    for (index, path) in recent.iter().take(10).enumerate() {
        menu.append(&MenuItem::with_id(
            app,
            format!("recent-{index}"),
            short_path(path),
            true,
            None::<&str>,
        )?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        "clear-recent",
        "Clear Recent",
        true,
        None::<&str>,
    )?)?;
    Ok(menu)
}

fn short_path(path: &str) -> String {
    let name = std::path::Path::new(path)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    if name.chars().count() > 48 {
        let trimmed: String = name.chars().take(45).collect();
        format!("{trimmed}…")
    } else {
        name
    }
}

pub fn emit_action(app: &AppHandle, action: &str) {
    let _ = app.emit("menu-action", action);
}

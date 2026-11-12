//! How the app lives on the desktop: one copy at a time, an icon in the
//! notification area that keeps voice going when the window is closed, and
//! `strom://` links (invites, friends) opening straight in the app.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WindowEvent};
use tauri_plugin_deep_link::DeepLinkExt;

/// Set when the user really quits; otherwise closing the window only hides it.
static QUITTING: AtomicBool = AtomicBool::new(false);

/// Lets the window close for real (quitting, or restarting into an update).
pub fn prepare_quit() {
    QUITTING.store(true, Ordering::Relaxed);
}

/// A link the app was started with, kept until the page is ready to handle it.
#[derive(Default)]
pub struct PendingLink(pub Mutex<Option<String>>);

pub fn show_main(app: &AppHandle) {
    SHOWN.store(true, Ordering::Relaxed);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Hands a `strom://` link to the page, which joins the server or opens the friend.
fn open_link(app: &AppHandle, url: &str) {
    if !url.starts_with("hopp://") && !url.starts_with("strom://") {
        return;
    }
    show_main(app);
    *app.state::<PendingLink>().0.lock().unwrap() = Some(url.to_string());
    let _ = app.emit("open-url", url.to_string());
}

pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    let handle = app.handle().clone();

    // Started with Windows: stay in the notification area until opened.
    if std::env::args().any(|a| a == "--minimized") {
        STARTED_HIDDEN.store(true, Ordering::Relaxed);
    }
    // The page shows the window once it has its size; if the page can't, show it anyway.
    let late = handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(4));
        if !SHOWN.load(Ordering::Relaxed) && !STARTED_HIDDEN.load(Ordering::Relaxed) {
            show_main(&late);
        }
    });

    // Links: registered for this user (no admin needed), opened in the running app.
    #[cfg(any(windows, target_os = "linux"))]
    if crate::second_copy() {
        // hopp:// links keep opening the everyday Hopp.
    } else if let Err(e) = app.deep_link().register_all() {
        tracing::warn!("couldn't register strom:// links: {e}");
    }
    {
        let handle = handle.clone();
        app.deep_link().on_open_url(move |event| {
            for url in event.urls() {
                open_link(&handle, url.as_str());
            }
        });
    }
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        if let Some(url) = urls.first() {
            *app.state::<PendingLink>().0.lock().unwrap() = Some(url.to_string());
        }
    }

    // The icon in the notification area.
    let open = MenuItem::with_id(app, "open", "Open Hopp", true, None::<&str>)?;
    let mute = MenuItem::with_id(app, "mute", "Mute / unmute", true, None::<&str>)?;
    let deafen = MenuItem::with_id(app, "deafen", "Deafen / undeafen", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "Quit Hopp", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&open, &PredefinedMenuItem::separator(app)?, &mute, &deafen, &PredefinedMenuItem::separator(app)?, &quit_item],
    )?;
    let mut tray = TrayIconBuilder::with_id("main").tooltip("Hopp").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id().as_ref() {
        "open" => show_main(app),
        "mute" | "deafen" => {
            let _ = app.emit("tray-action", event.id().as_ref());
        }
        "quit" => quit(app),
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            show_main(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

pub fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::Relaxed);
    app.exit(0);
}

/// Closing the main window hides it: voice and notifications carry on in the background.
pub fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            if window.label() == "main" && !QUITTING.load(Ordering::Relaxed) {
                api.prevent_close();
                let _ = window.hide();
            }
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) if window.label() == "main" => remember_bounds(window),
        _ => {}
    }
}

// ---------- the window: small for logging in, full size for the app ----------

/// True while the small login window is showing (its size isn't remembered).
static COMPACT: AtomicBool = AtomicBool::new(true);
/// The window has been shown at least once (it starts hidden, to appear at the right size).
static SHOWN: AtomicBool = AtomicBool::new(false);
static STARTED_HIDDEN: AtomicBool = AtomicBool::new(false);
static SAVE_TICKET: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

#[derive(serde::Serialize, serde::Deserialize)]
struct Bounds {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    maximized: bool,
}

fn bounds_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    crate::data_dir(app).map(|d| d.join("window.json"))
}

/// Remembers where the full-size window is: once the moving or resizing has stopped for a
/// moment, read and written on a thread of its own, so dragging the window never waits on it.
fn remember_bounds(window: &tauri::Window) {
    if COMPACT.load(Ordering::Relaxed) {
        return;
    }
    let ticket = SAVE_TICKET.fetch_add(1, Ordering::Relaxed) + 1;
    let window = window.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(500));
        // Moved or resized again meanwhile: that later one saves.
        if SAVE_TICKET.load(Ordering::Relaxed) != ticket || COMPACT.load(Ordering::Relaxed) || window.is_minimized().unwrap_or(false) {
            return;
        }
        let maximized = window.is_maximized().unwrap_or(false);
        let previous = bounds_path(window.app_handle()).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<Bounds>(&b).ok());
        // Maximized: keep the size it goes back to.
        let bounds = match (maximized, previous) {
            (true, Some(p)) => Bounds { maximized: true, ..p },
            _ => {
                let (Ok(pos), Ok(size)) = (window.outer_position(), window.inner_size()) else { return };
                Bounds { x: pos.x, y: pos.y, width: size.width, height: size.height, maximized }
            }
        };
        if let Some(path) = bounds_path(window.app_handle()) {
            let _ = std::fs::write(path, serde_json::to_vec(&bounds).unwrap_or_default());
        }
    });
}

fn reveal(window: &tauri::WebviewWindow) {
    if !SHOWN.swap(true, Ordering::Relaxed) && STARTED_HIDDEN.load(Ordering::Relaxed) {
        return;
    }
    let _ = window.show();
    let _ = window.set_focus();
}

/// The small window for logging in or making an account; `height` fits what's in it.
#[tauri::command]
pub fn window_compact(app: AppHandle, height: f64) {
    let Some(w) = app.get_webview_window("main") else { return };
    COMPACT.store(true, Ordering::Relaxed);
    let _ = w.unmaximize();
    let _ = w.set_min_size(None::<tauri::LogicalSize<f64>>);
    let _ = w.set_resizable(false);
    let _ = w.set_maximizable(false);
    // Never taller than the screen (small laptops): the form scrolls instead.
    let fits = w
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.work_area().size.height as f64 / m.scale_factor() - 16.0)
        .unwrap_or(900.0);
    let _ = w.set_size(tauri::LogicalSize::new(480.0, height.clamp(560.0, 900.0).min(fits.max(400.0))));
    let _ = w.center();
    reveal(&w);
}

/// The small starting window: just the hopping logo while Hopp gets ready.
#[tauri::command]
pub fn window_splash(app: AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    COMPACT.store(true, Ordering::Relaxed);
    let _ = w.unmaximize();
    let _ = w.set_min_size(None::<tauri::LogicalSize<f64>>);
    let _ = w.set_resizable(false);
    let _ = w.set_maximizable(false);
    let _ = w.set_size(tauri::LogicalSize::new(320.0, 380.0));
    let _ = w.center();
    reveal(&w);
}

/// Whether the window's title bar would be on one of the screens connected now.
fn on_a_screen(w: &tauri::WebviewWindow, b: &Bounds) -> bool {
    let Ok(monitors) = w.available_monitors() else { return false };
    monitors.iter().any(|m| {
        let (pos, size) = (m.position(), m.size());
        let (x, y) = (b.x + 100, b.y + 15);
        x >= pos.x && x < pos.x + size.width as i32 && y >= pos.y && y < pos.y + size.height as i32
    })
}

/// The window's own colour, shown for a moment while it grows (before the page catches up):
/// the app's background, so a resize never flashes black. `rgb` is "#rrggbb".
#[tauri::command]
pub fn window_color(app: AppHandle, rgb: String) {
    let Some(w) = app.get_webview_window("main") else { return };
    let hex = rgb.trim_start_matches('#');
    let Ok(n) = u32::from_str_radix(hex, 16) else { return };
    if hex.len() != 6 {
        return;
    }
    let color = tauri::window::Color((n >> 16) as u8, (n >> 8) as u8, n as u8, 255);
    let _ = w.set_background_color(Some(color));
}

/// The full app window, where it was last time.
#[tauri::command]
pub fn window_full(app: AppHandle) {
    let Some(w) = app.get_webview_window("main") else { return };
    if !COMPACT.swap(false, Ordering::Relaxed) {
        return reveal(&w);
    }
    let _ = w.set_resizable(true);
    let _ = w.set_maximizable(true);
    let _ = w.set_min_size(Some(tauri::LogicalSize::new(940.0, 560.0)));
    let saved = bounds_path(&app).and_then(|p| std::fs::read(p).ok()).and_then(|b| serde_json::from_slice::<Bounds>(&b).ok());
    match saved {
        // Only where a screen still is (a second monitor may be gone).
        Some(b) if on_a_screen(&w, &b) => {
            let _ = w.set_size(tauri::PhysicalSize::new(b.width.max(940), b.height.max(560)));
            let _ = w.set_position(tauri::PhysicalPosition::new(b.x, b.y));
            if b.maximized {
                let _ = w.maximize();
            }
        }
        _ => {
            let _ = w.set_size(tauri::LogicalSize::new(1280.0, 800.0));
            let _ = w.center();
        }
    }
    reveal(&w);
}

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

/// A link the app was started with, kept until the page is ready to handle it.
#[derive(Default)]
pub struct PendingLink(pub Mutex<Option<String>>);

pub fn show_main(app: &AppHandle) {
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

    // Links: registered for this user (no admin needed), opened in the running app.
    #[cfg(any(windows, target_os = "linux"))]
    if let Err(e) = app.deep_link().register_all() {
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
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" && !QUITTING.load(Ordering::Relaxed) {
            api.prevent_close();
            let _ = window.hide();
        }
    }
}

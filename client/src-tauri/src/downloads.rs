//! Files friends send straight from their computer: written piece by piece into the
//! Downloads folder as they arrive, and marked as coming from the internet so Windows
//! warns before running a program.

use std::collections::HashMap;
use std::fs::File;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager, State};

type CmdResult<T = ()> = Result<T, String>;

#[derive(Default)]
pub struct Downloads {
    open: Mutex<HashMap<String, (File, PathBuf)>>,
}

/// A name that's safe as a file name on Windows, keeping its extension.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let short: String = trimmed.chars().take(150).collect();
    // Names Windows reserves for devices.
    let stem = short.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str())
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit());
    if short.is_empty() || reserved { format!("file {short}").trim().to_string() } else { short }
}

/// "photo.png", then "photo (1).png", "photo (2).png"… whichever doesn't exist yet.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (1..10_000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or(first)
}

fn downloads_dir(app: &AppHandle) -> CmdResult<PathBuf> {
    app.path().download_dir().map_err(|_| "Couldn't find your Downloads folder.".to_string())
}

/// Starts a file in Downloads; returns its id (for the pieces) and where it will be.
#[tauri::command]
pub fn download_start(app: AppHandle, downloads: State<'_, Downloads>, name: String) -> CmdResult<serde_json::Value> {
    let dir = downloads_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Couldn't save the file: {e}"))?;
    let path = free_path(&dir, &safe_name(&name));
    let file = File::create(&path).map_err(|e| format!("Couldn't save the file: {e}"))?;
    // The mark of the web: Windows and SmartScreen treat it as downloaded.
    #[cfg(windows)]
    let _ = std::fs::write(format!("{}:Zone.Identifier", path.display()), "[ZoneTransfer]\r\nZoneId=3\r\n");
    static NEXT: AtomicU64 = AtomicU64::new(1);
    let id = format!("d{}", NEXT.fetch_add(1, Ordering::Relaxed));
    downloads.open.lock().unwrap().insert(id.clone(), (file, path.clone()));
    Ok(serde_json::json!({ "id": id, "path": path.display().to_string(), "name": path.file_name().map(|n| n.to_string_lossy().to_string()) }))
}

/// One piece of a file, sent as raw bytes with the download's id in a header.
#[tauri::command]
pub fn download_chunk(request: tauri::ipc::Request<'_>, downloads: State<'_, Downloads>) -> CmdResult {
    let id = request.headers().get("x-download").and_then(|v| v.to_str().ok()).ok_or("Missing download.")?.to_string();
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("Expected the file's bytes.".into()) };
    let mut open = downloads.open.lock().unwrap();
    let (file, _) = open.get_mut(&id).ok_or("That download isn't open.")?;
    file.write_all(bytes).map_err(|e| format!("Couldn't save the file: {e}"))
}

/// The last piece arrived: the file is complete.
#[tauri::command]
pub fn download_finish(downloads: State<'_, Downloads>, id: String) -> CmdResult<String> {
    let (mut file, path) = downloads.open.lock().unwrap().remove(&id).ok_or("That download isn't open.")?;
    file.flush().map_err(|e| format!("Couldn't save the file: {e}"))?;
    Ok(path.display().to_string())
}

/// Stopped halfway: the partial file is removed.
#[tauri::command]
pub fn download_cancel(downloads: State<'_, Downloads>, id: String) {
    if let Some((file, path)) = downloads.open.lock().unwrap().remove(&id) {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
}

/// Opens Explorer with the downloaded file selected (only files in Downloads).
#[tauri::command]
pub fn show_download(app: AppHandle, path: String) -> CmdResult {
    let dir = downloads_dir(&app)?;
    let path = PathBuf::from(path);
    if !path.starts_with(&dir) || !path.exists() {
        return Err("That file isn't in your Downloads anymore.".into());
    }
    std::process::Command::new("explorer").arg(format!("/select,{}", path.display())).spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_made_safe() {
        assert_eq!(safe_name("photo.png"), "photo.png");
        assert_eq!(safe_name("..\\..\\Windows\\evil.exe"), "evil.exe");
        assert_eq!(safe_name("a<b>:c?.txt"), "a_b__c_.txt");
        assert_eq!(safe_name("  ...  "), "file");
        assert_eq!(safe_name("CON.txt"), "file CON.txt");
        assert_eq!(safe_name("com1"), "file com1");
        assert_eq!(safe_name(&"x".repeat(300)).len(), 150);
    }

    #[test]
    fn existing_names_get_a_number() {
        let dir = std::env::temp_dir().join(format!("hopp-dl-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        std::fs::write(dir.join("a (1).txt"), "x").unwrap();
        assert_eq!(free_path(&dir, "a.txt"), dir.join("a (2).txt"));
        assert_eq!(free_path(&dir, "b.txt"), dir.join("b.txt"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

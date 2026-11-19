//! Pictures, voice messages and emoji pictures on servers people run on their own computers.
//! Hopp Cloud keeps them behind its web address; a server on a computer keeps them itself, and
//! they travel inside the app's own encrypted connection to it (through the tunnel when it's
//! hosted out of sight). The page shows them through Hopp's own address,
//! `http://hoppimg.localhost/<server>/<id>`, which asks the right server for them.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use strom_shared::ServerMsg;
use tokio::sync::oneshot;

/// Pictures kept in memory once fetched, so scrolling back doesn't fetch them again.
const CACHE_BYTES: usize = 40 * 1024 * 1024;
const WAIT: Duration = Duration::from_secs(30);

type Picture = (String, Arc<Vec<u8>>);

/// What a connection is waiting to hear back about.
#[derive(Default)]
pub struct Waits {
    next: u32,
    uploads: HashMap<u32, oneshot::Sender<Result<String, String>>>,
    fetches: HashMap<String, Vec<oneshot::Sender<Option<Picture>>>>,
}

pub type Shared = Arc<Mutex<Waits>>;

/// A server's answer about a picture: handed to whoever waits for it. True if it was one.
pub fn answered(waits: &Shared, msg: &ServerMsg) -> bool {
    match msg {
        ServerMsg::ImageUploaded { req, id, error } => {
            if let Some(done) = waits.lock().unwrap().uploads.remove(req) {
                let _ = done.send(match id {
                    Some(id) => Ok(id.clone()),
                    None => Err(error.clone().unwrap_or_else(|| "Couldn't send the picture.".into())),
                });
            }
            true
        }
        ServerMsg::Image { id, kind, data } => {
            let picture = match (kind, data) {
                (Some(kind), Some(data)) => base64::engine::general_purpose::STANDARD.decode(data).ok().map(|bytes| (kind.clone(), Arc::new(bytes))),
                _ => None,
            };
            for done in waits.lock().unwrap().fetches.remove(id).unwrap_or_default() {
                let _ = done.send(picture.clone());
            }
            true
        }
        _ => false,
    }
}

/// Sends a picture to the server; its id when stored.
pub async fn upload(waits: &Shared, control: &strom_voice::Control, kind: &str, data: &[u8]) -> Result<String, String> {
    let (done, answer) = oneshot::channel();
    let req = {
        let mut w = waits.lock().unwrap();
        w.next = w.next.wrapping_add(1);
        let req = w.next;
        w.uploads.insert(req, done);
        req
    };
    control.send(strom_shared::ClientMsg::UploadImage { req, kind: kind.into(), data: base64::engine::general_purpose::STANDARD.encode(data) });
    match tokio::time::timeout(WAIT, answer).await {
        Ok(Ok(result)) => result,
        _ => {
            waits.lock().unwrap().uploads.remove(&req);
            Err("The server didn't answer. Try again.".into())
        }
    }
}

/// Asks the server for a picture.
pub async fn fetch(waits: &Shared, control: &strom_voice::Control, id: &str) -> Option<Picture> {
    let (done, answer) = oneshot::channel();
    let first = {
        let mut w = waits.lock().unwrap();
        let list = w.fetches.entry(id.to_string()).or_default();
        // Askers that gave up (no answer came, say the connection dropped) don't count: with
        // only them left, it's asked again, or the picture would never load this session.
        list.retain(|waiting| !waiting.is_closed());
        list.push(done);
        list.len() == 1
    };
    // Asked once, however many places show it.
    if first {
        control.send(strom_shared::ClientMsg::GetImage { id: id.into() });
    }
    tokio::time::timeout(WAIT, answer).await.ok().and_then(Result::ok).flatten()
}

/// Recently shown pictures, newest kept.
#[derive(Default)]
pub struct Cache {
    map: HashMap<String, Picture>,
    order: VecDeque<String>,
    bytes: usize,
}

impl Cache {
    pub fn get(&self, key: &str) -> Option<Picture> {
        self.map.get(key).cloned()
    }

    pub fn put(&mut self, key: String, picture: Picture) {
        if self.map.contains_key(&key) || picture.1.len() > CACHE_BYTES / 4 {
            return;
        }
        self.bytes += picture.1.len();
        self.order.push_back(key.clone());
        self.map.insert(key, picture);
        while self.bytes > CACHE_BYTES {
            let Some(old) = self.order.pop_front() else { break };
            if let Some((_, b)) = self.map.remove(&old) {
                self.bytes -= b.len();
            }
        }
    }
}

/// Picture ids are 32 hex characters.
pub fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_picture_that_never_came_is_asked_for_again() {
        let waits: Shared = Arc::default();
        // Someone asked and gave up waiting.
        let (gave_up, answer) = oneshot::channel::<Option<Picture>>();
        waits.lock().unwrap().fetches.entry("ab".repeat(16)).or_default().push(gave_up);
        drop(answer);
        // The next asker is the first again (so the server is asked), not left waiting behind it.
        let (done, _answer) = oneshot::channel();
        let mut w = waits.lock().unwrap();
        let list = w.fetches.get_mut(&"ab".repeat(16)).unwrap();
        list.retain(|waiting| !waiting.is_closed());
        list.push(done);
        assert_eq!(list.len(), 1);
    }
}

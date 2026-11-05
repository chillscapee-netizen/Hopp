//! Link previews: a page's title, description and picture, fetched by this app.
//!
//! A message can point anywhere, so the fetch only ever goes to the public internet: names
//! that resolve to this computer, the home network or other private addresses are refused,
//! for the first request and every redirect. Pages and pictures are size-capped, and the
//! picture comes back as a data URL so the page never loads anything from the site itself.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::{redirect, Url};
use serde::Serialize;

/// Enough of a page to find its preview tags, which live in the head.
const MAX_PAGE: usize = 512 * 1024;
/// The largest picture we'll show.
const MAX_IMAGE: usize = 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
pub struct Preview {
    pub url: String,
    pub site: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    /// A `data:image/...;base64,` URL.
    pub image: Option<String>,
}

/// Reachable across the internet: not this computer, the local network or reserved ranges.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                || a == 0
                || (a == 100 && (64..128).contains(&b))
                || a >= 224)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback() || v6.is_unspecified() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80 || (first & 0xff00) == 0xff00)
        }
    }
}

/// Looks names up like usual, keeping only public addresses.
struct PublicOnly;

impl Resolve for PublicOnly {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.filter(|a| is_public(a.ip())).collect();
            if addrs.is_empty() {
                return Err("that address isn't on the public internet".into());
            }
            Ok(Box::new(addrs.into_iter()) as Addrs)
        })
    }
}

/// Web addresses only, and never one written as a private IP.
fn allowed(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && match url.host_str() {
            None => false,
            Some(host) => match host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
                Ok(ip) => is_public(ip),
                Err(_) => {
                    let d = host.to_ascii_lowercase();
                    d != "localhost" && !d.ends_with(".local") && !d.ends_with(".localhost")
                }
            },
        }
}

fn client() -> reqwest::Result<reqwest::Client> {
    reqwest::Client::builder()
        .dns_resolver(Arc::new(PublicOnly))
        .redirect(redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 4 || !allowed(attempt.url()) {
                attempt.stop()
            } else {
                attempt.follow()
            }
        }))
        .timeout(TIMEOUT)
        .user_agent("Mozilla/5.0 (compatible; HoppLinkPreview/1.0)")
        .build()
}

/// The body, up to `max` bytes (the rest is never downloaded).
async fn read_capped(mut response: reqwest::Response, max: usize) -> reqwest::Result<Vec<u8>> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        let room = max.saturating_sub(body.len());
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= max {
            break;
        }
    }
    Ok(body)
}

/// The preview for `url`, or `None` when the page has nothing to show.
pub async fn fetch(url: &str) -> Result<Option<Preview>, String> {
    let url = Url::parse(url).map_err(|_| "That isn't a web address.")?;
    if !allowed(&url) {
        return Ok(None);
    }
    let client = client().map_err(|e| e.to_string())?;
    let response = client.get(url.clone()).header("accept", "text/html,application/xhtml+xml").send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Ok(None);
    }
    let html_page = response.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|t| t.contains("html"));
    if !html_page {
        return Ok(None);
    }
    let base = response.url().clone();
    let body = read_capped(response, MAX_PAGE).await.map_err(|e| e.to_string())?;
    let html = String::from_utf8_lossy(&body);
    let mut preview = parse(&html, &base);
    preview.url = url.to_string();
    if preview.title.is_none() && preview.description.is_none() {
        return Ok(None);
    }
    if let Some(src) = preview.image.take() {
        preview.image = image(&client, &src).await;
    }
    Ok(Some(preview))
}

/// A picture as a data URL, if it's a real, not too big image.
async fn image(client: &reqwest::Client, src: &str) -> Option<String> {
    let url = Url::parse(src).ok().filter(allowed)?;
    let response = client.get(url).header("accept", "image/*").send().await.ok()?;
    let kind = response.headers().get("content-type")?.to_str().ok()?.split(';').next()?.trim().to_ascii_lowercase();
    if !matches!(kind.as_str(), "image/png" | "image/jpeg" | "image/webp" | "image/gif") {
        return None;
    }
    if response.content_length().is_some_and(|n| n as usize > MAX_IMAGE) {
        return None;
    }
    let bytes = read_capped(response, MAX_IMAGE + 1).await.ok()?;
    if bytes.len() > MAX_IMAGE || bytes.is_empty() {
        return None;
    }
    Some(format!("data:{kind};base64,{}", base64(&bytes)))
}

/// Reads the preview tags (Open Graph, then Twitter, then the plain title and description).
pub fn parse(html: &str, base: &Url) -> Preview {
    let mut og = std::collections::HashMap::new();
    let lower = html.to_ascii_lowercase();
    let head_end = lower.find("</head>").unwrap_or(lower.len());
    let mut at = 0;
    while let Some(i) = lower[at..head_end].find("<meta") {
        let start = at + i;
        let Some(len) = lower[start..].find('>') else { break };
        let tag = &html[start..start + len];
        let key = attr(tag, "property").or_else(|| attr(tag, "name")).map(|k| k.to_ascii_lowercase());
        if let (Some(key), Some(content)) = (key, attr(tag, "content")) {
            og.entry(key).or_insert(content);
        }
        at = start + len;
    }
    let title_tag = lower.find("<title").and_then(|i| {
        let open = i + lower[i..].find('>')? + 1;
        let close = open + lower[open..].find("</title")?;
        Some(html[open..close].to_string())
    });
    let pick = |keys: &[&str]| keys.iter().find_map(|k| og.get(*k)).map(|v| clean(v)).filter(|v| !v.is_empty());
    let title = pick(&["og:title", "twitter:title"]).or_else(|| title_tag.map(|t| clean(&t)).filter(|t| !t.is_empty()));
    let description = pick(&["og:description", "twitter:description", "description"]);
    let site = pick(&["og:site_name"]).or_else(|| base.host_str().map(|h| h.trim_start_matches("www.").to_string()));
    let image = pick(&["og:image", "og:image:url", "twitter:image"]).and_then(|src| base.join(&src).ok()).map(|u| u.to_string());
    Preview { url: base.to_string(), site, title: title.map(|t| cap(&t, 120)), description: description.map(|d| cap(&d, 300)), image }
}

/// An attribute's value in a tag, quoted either way.
fn attr(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0;
    while let Some(i) = lower[from..].find(name) {
        let at = from + i;
        let before_ok = at == 0 || lower.as_bytes()[at - 1].is_ascii_whitespace();
        let rest = lower[at + name.len()..].trim_start();
        if before_ok && rest.starts_with('=') {
            let after_eq = at + name.len() + (lower[at + name.len()..].len() - rest.len()) + 1;
            let value = tag[after_eq..].trim_start();
            let quote = value.chars().next()?;
            return if quote == '"' || quote == '\'' {
                value[1..].find(quote).map(|end| value[1..1 + end].to_string())
            } else {
                Some(value.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("").to_string())
            };
        }
        from = at + name.len();
    }
    None
}

/// Entities decoded and whitespace evened out.
fn clean(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest.find(';').filter(|&e| e <= 10);
        let decoded = end.and_then(|e| match &rest[1..e] {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" => Some('\''),
            "nbsp" => Some(' '),
            n if n.starts_with("#x") || n.starts_with("#X") => u32::from_str_radix(&n[2..], 16).ok().and_then(char::from_u32),
            n if n.starts_with('#') => n[1..].parse().ok().and_then(char::from_u32),
            _ => None,
        });
        match (decoded, end) {
            (Some(c), Some(e)) => {
                out.push(c);
                rest = &rest[e + 1..];
            }
            _ => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn cap(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    format!("{}…", text.chars().take(max - 1).collect::<String>().trim_end())
}

fn base64(bytes: &[u8]) -> String {
    const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16 | (*chunk.get(1).unwrap_or(&0) as u32) << 8 | *chunk.get(2).unwrap_or(&0) as u32;
        out.push(ABC[(n >> 18) as usize & 63] as char);
        out.push(ABC[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ABC[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ABC[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_and_local_addresses_are_never_fetched() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.5", "169.254.1.1", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::5", "::ffff:192.168.1.1"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "104.16.1.1", "2606:4700::1111"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
        for url in ["http://192.168.1.1/admin", "http://localhost:8080", "http://printer.local/", "file:///C:/x", "ftp://example.com", "http://[::1]/"] {
            assert!(!allowed(&Url::parse(url).unwrap()), "{url}");
        }
        assert!(allowed(&Url::parse("https://example.com/page").unwrap()));
    }

    #[test]
    fn preview_tags_are_read_whichever_way_they_are_written() {
        let base = Url::parse("https://www.example.com/news/1").unwrap();
        let html = r#"<html><head><title>Plain title</title>
            <meta property="og:title" content="Big &amp; bold news">
            <META name='description' content='Something   happened &#8212; today.'>
            <meta content="/img/cover.png" property="og:image" />
            </head><body><meta property="og:title" content="not in the head"></body></html>"#;
        let p = parse(html, &base);
        assert_eq!(p.title.as_deref(), Some("Big & bold news"));
        assert_eq!(p.description.as_deref(), Some("Something happened — today."));
        assert_eq!(p.image.as_deref(), Some("https://www.example.com/img/cover.png"));
        assert_eq!(p.site.as_deref(), Some("example.com"));
        // Only a title: that's used.
        let p = parse("<title> Just a page </title>", &base);
        assert_eq!(p.title.as_deref(), Some("Just a page"));
        assert_eq!(p.description, None);
    }

    #[test]
    fn long_text_is_cut_and_pictures_are_encoded() {
        assert_eq!(cap(&"a".repeat(200), 10).chars().count(), 10);
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
    }

    /// Needs internet access: `cargo test -p strom-client -- --ignored live_preview`.
    #[tokio::test]
    #[ignore]
    async fn live_preview_of_a_real_page() {
        let p = fetch("https://github.com/").await.unwrap().expect("a preview");
        assert!(p.title.is_some(), "{p:?}");
        // A public name that points at this computer is refused, not fetched.
        assert!(fetch("http://localtest.me/").await.is_err());
    }
}

//! A web app's icon, start to finish: the user's own picture if they chose
//! one, else the site's best icon as a silhouette card, else a text card. It
//! never fails: there is always an icon to put in the image.

use crate::cache::{Cache, Kind};
use crate::html::{self, Candidate};
use crate::{decode, label_for, local_host, png, style};
use base64::Engine;
use futures_util::{StreamExt, stream};
use image::RgbaImage;
use std::time::Duration;
use url::Url;

pub use crate::cache::Kind as Source;

const PAGE_CAP: usize = 1 << 20;
const MANIFEST_CAP: usize = 256 << 10;
const IMAGE_CAP: usize = 2 << 20;
const CANDIDATES: usize = 12;
/// A whole site, page and icons, gets this long.
const SITE_BUDGET: Duration = Duration::from_secs(15);
const USER_AGENT: &str =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

#[derive(Clone, Debug)]
pub struct Icon {
    pub png: Vec<u8>,
    pub source: Source,
}

pub struct Resolver {
    client: reqwest::Client,
    cache: Option<Cache>,
    allow_local: bool,
}

impl Resolver {
    pub fn new(cache: Option<Cache>) -> Resolver {
        let client = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(Duration::from_secs(8))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("an HTTP client");
        Resolver { client, cache, allow_local: false }
    }

    /// Also asks hosts on this network (tests, with a local server).
    pub fn allow_local(mut self) -> Resolver {
        self.allow_local = true;
        self
    }

    fn local(&self, url: &Url) -> bool {
        !self.allow_local && local_host(url)
    }

    /// The icon for the web app at `site`; `custom` is the picture the user
    /// chose for it (a data: URL or an https address), if any.
    pub async fn icon(&self, site: &str, custom: Option<&str>) -> Icon {
        if let Some(icon) = match custom {
            Some(c) => self.custom(c).await,
            None => None,
        } {
            return icon;
        }
        self.site(site).await
    }

    /// The site's own icon as a card, or its text card.
    pub async fn site(&self, site: &str) -> Icon {
        let key = format!("site {site}");
        if let Some((png, source)) = self.cache.as_ref().and_then(|c| c.get(&key)) {
            return Icon { png, source };
        }
        let (img, source) = match self.fetch(site).await {
            Some(img) => (style::card(&img), Kind::Site),
            None => (style::text_card(&label_for(site)), Kind::Fallback),
        };
        self.keep(&key, img, source)
    }

    /// The site's own icon in colour, `px` square (how WadSpaces Client shows a
    /// web app), or None when it has none. Kept like the cards: a site that
    /// gave nothing is asked again after a day.
    pub async fn favicon(&self, site: &str, px: u32) -> Option<Vec<u8>> {
        let key = format!("favicon {px} {site}");
        if let Some((png, source)) = self.cache.as_ref().and_then(|c| c.get(&key)) {
            return (source == Kind::Site).then_some(png);
        }
        match self.fetch(site).await {
            Some(img) => Some(self.keep(&key, style::fit(&img, px), Kind::Site).png),
            None => {
                self.keep(&key, RgbaImage::new(1, 1), Kind::Fallback);
                None
            }
        }
    }

    /// The user's picture, as it is; None if it can't be had (the site's icon
    /// is used instead).
    async fn custom(&self, icon_url: &str) -> Option<Icon> {
        if icon_url.starts_with("data:") {
            let img = decode::decode(&data_url(icon_url)?)?;
            return Some(Icon { png: png(&style::plain(&img)), source: Kind::Custom });
        }
        let url = Url::parse(icon_url).ok().filter(|u| matches!(u.scheme(), "https" | "http") && !self.local(u))?;
        let key = format!("custom {url}");
        if let Some((png, source)) = self.cache.as_ref().and_then(|c| c.get(&key)) {
            return (source == Kind::Custom).then_some(Icon { png, source });
        }
        let img = self.get(&url, IMAGE_CAP).await.and_then(|(bytes, _, _)| decode::decode(&bytes))?;
        Some(self.keep(&key, style::plain(&img), Kind::Custom))
    }

    fn keep(&self, key: &str, img: RgbaImage, source: Kind) -> Icon {
        let png = png(&img);
        if let Some(cache) = &self.cache
            && let Err(e) = cache.put(key, &png, source)
        {
            tracing::warn!(%e, "can't keep the icon");
        }
        Icon { png, source }
    }

    /// The site's best icon, within the site's budget. An app page with none of
    /// its own (a console behind a sign-in) gets its parent site's:
    /// console.firebase.google.com's from firebase.google.com.
    async fn fetch(&self, site: &str) -> Option<RgbaImage> {
        let u = Url::parse(site).ok().filter(|u| matches!(u.scheme(), "http" | "https") && !self.local(u))?;
        let found = async {
            match self.best_icon(&u).await {
                Some(img) => Some(img),
                None => match parent_site(&u) {
                    Some(p) => self.best_icon(&p).await,
                    None => None,
                },
            }
        };
        tokio::time::timeout(SITE_BUDGET, found).await.ok().flatten()
    }

    /// The best icon the page at `page` offers: an SVG if it has one, else the
    /// biggest picture (packager.py's fetch_best_favicon, plus the manifest).
    pub async fn best_icon(&self, page: &Url) -> Option<RgbaImage> {
        let mut candidates = Vec::new();
        let mut base = page.clone();
        if let Some((body, _, at)) = self.get(page, PAGE_CAP).await {
            base = at;
            let (icons, manifest) = html::links(&String::from_utf8_lossy(&body), &base);
            candidates = icons;
            if let Some(m) = manifest
                && let Some((json, _, at)) = self.get(&m, MANIFEST_CAP).await
            {
                candidates.extend(html::manifest_icons(&String::from_utf8_lossy(&json), &at));
            }
        }
        for path in ["/favicon.ico", "/apple-touch-icon.png"] {
            if let Ok(u) = base.join(path)
                && !candidates.iter().any(|c| c.url == u)
            {
                candidates.push(Candidate {
                    url: u,
                    sizes: String::new(),
                    rel: "fallback".into(),
                    kind: String::new(),
                });
            }
        }

        // An SVG first: it draws as big as needed.
        for c in candidates.iter().filter(|c| c.says_svg()) {
            if let Some((bytes, kind, _)) = self.get(&c.url, IMAGE_CAP).await
                && (kind.contains("svg") || decode::looks_like_svg(&bytes))
                && let Some(img) = decode::svg(&bytes, decode::SVG_PX)
            {
                return Some(img);
            }
        }

        // Else the biggest picture, asked for all at once.
        candidates.sort_by_key(|c| std::cmp::Reverse(c.declared_area()));
        candidates.truncate(CANDIDATES);
        let pictures: Vec<RgbaImage> = stream::iter(candidates)
            .map(|c| async move { decode::decode(&self.get(&c.url, IMAGE_CAP).await?.0) })
            .buffer_unordered(6)
            .filter_map(|img| async move { img })
            .collect()
            .await;
        pictures.into_iter().max_by_key(|img| img.width() as u64 * img.height() as u64)
    }

    /// `url`'s body (at most `cap` bytes, else None), its content type, and
    /// where it ended up after redirects.
    async fn get(&self, url: &Url, cap: usize) -> Option<(Vec<u8>, String, Url)> {
        if url.scheme() == "data" {
            return Some((data_url(url.as_str())?, String::new(), url.clone()));
        }
        if !matches!(url.scheme(), "http" | "https") || self.local(url) {
            return None;
        }
        let mut resp = self.client.get(url.clone()).send().await.ok()?.error_for_status().ok()?;
        if resp.content_length().is_some_and(|n| n > cap as u64) {
            return None;
        }
        let kind = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let at = resp.url().clone();
        // A redirect may not lead onto this network either.
        if self.local(&at) {
            return None;
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp.chunk().await.ok()? {
            if body.len() + chunk.len() > cap {
                return None;
            }
            body.extend_from_slice(&chunk);
        }
        Some((body, kind, at))
    }
}

/// The bytes of a data: URL.
fn data_url(url: &str) -> Option<Vec<u8>> {
    let (head, data) = url.strip_prefix("data:")?.split_once(',')?;
    if head.split(';').any(|p| p.eq_ignore_ascii_case("base64")) {
        base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()
    } else {
        Some(percent_decode(data))
    }
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16)
        {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests;

/// The site one level up from `u`'s host (`https://firebase.google.com/` for
/// console.firebase.google.com), when that's still more than a domain's end.
fn parent_site(u: &Url) -> Option<Url> {
    let host = u.host_str()?;
    let (_, rest) = host.split_once('.')?;
    (rest.matches('.').count() >= 1 && u.domain().is_some()).then(|| Url::parse(&format!("https://{rest}/")).ok())?
}

#[cfg(test)]
mod parent_tests {
    use super::*;

    #[test]
    fn parents() {
        let p = |s: &str| parent_site(&Url::parse(s).unwrap()).map(|u| u.to_string());
        assert_eq!(p("https://console.firebase.google.com/x"), Some("https://firebase.google.com/".into()));
        assert_eq!(p("https://mail.google.com/"), Some("https://google.com/".into()));
        assert_eq!(p("https://github.com/"), None);
        assert_eq!(p("http://10.0.0.1/"), None);
    }
}

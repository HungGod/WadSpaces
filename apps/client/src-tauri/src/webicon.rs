//! `wadd-icon://localhost/web?site=<url, encoded>`: a web app's icon, for the
//! page's `<img>`s. wadd fetches the site's own icon once and keeps it
//! (`GET /v1/webapp-icon`); the page can't load it from the site itself (the
//! window's CSP, and a favicon service's redirects, stand in the way).

use base64::Engine;
use tauri::http::{Response, StatusCode, Uri, header};
use tauri::{AppHandle, Manager};

use crate::wadd::{Method, Wadd};

pub const SCHEME: &str = "wadd-icon";

pub async fn serve(app: &AppHandle, uri: &Uri) -> Response<Vec<u8>> {
    let empty = |status: StatusCode| Response::builder().status(status).body(Vec::new()).expect("a response");
    // Only `site=`, passed on as the page encoded it.
    let Some(site) = (uri.path() == "/web").then(|| uri.query()).flatten().and_then(|q| q.strip_prefix("site=")) else {
        return empty(StatusCode::BAD_REQUEST);
    };
    if site.is_empty() || site.len() > 2048 || site.contains(['&', '#']) || site.chars().any(char::is_control) {
        return empty(StatusCode::BAD_REQUEST);
    }
    let wadd = app.state::<Wadd>();
    let png = wadd
        .request(Method::Get, &format!("/v1/webapp-icon?site={site}"))
        .await
        .ok()
        .and_then(|v| v.get("png").and_then(|p| p.as_str()).map(str::to_owned))
        .and_then(|b| base64::engine::general_purpose::STANDARD.decode(b).ok());
    match png {
        Some(png) => Response::builder()
            .header(header::CONTENT_TYPE, "image/png")
            .header(header::CACHE_CONTROL, "max-age=86400")
            .body(png)
            .expect("a response"),
        None => empty(StatusCode::NOT_FOUND),
    }
}

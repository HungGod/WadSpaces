//! Against a fake podman on a temporary socket; and (ignored by default) the
//! real rootless one: cargo test -p wad-podman -- --ignored

use axum::Router;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::{get, post};
use serde_json::json;

use super::*;

async fn fake() -> (tempfile::TempDir, Podman) {
    let dir = tempfile::tempdir().unwrap();
    let sock = dir.path().join("podman.sock");
    let app = Router::new()
        .route("/v5.0.0/libpod/_ping", get(|| async { "OK" }))
        .route("/v5.0.0/libpod/info", get(|| async { axum::Json(json!({"store": {"graphRoot": "/var/lib/containers/storage"}})) }))
        .route(
            "/v5.0.0/libpod/images/{name}/exists",
            get(|Path(name): Path<String>| async move { if name == "ghcr.io/o/here:latest" { StatusCode::NO_CONTENT } else { StatusCode::NOT_FOUND } }),
        )
        .route(
            "/v5.0.0/libpod/images/{name}/json",
            get(|Path(name): Path<String>| async move {
                if name == "ghcr.io/o/here:latest" {
                    axum::Json(json!({"Labels": {"io.wadspaces.projects": "1"}})).into_response()
                } else {
                    (StatusCode::NOT_FOUND, axum::Json(json!({"message": "no such image"}))).into_response()
                }
            }),
        )
        .route(
            "/v5.0.0/libpod/containers/{name}/json",
            get(|Path(name): Path<String>| async move {
                if name == "wad-up" { axum::Json(json!({"State": {"Status": "Running"}})).into_response() } else { StatusCode::NOT_FOUND.into_response() }
            }),
        )
        .route(
            "/v5.0.0/libpod/volumes/{name}/json",
            get(|Path(name): Path<String>| async move {
                if name == "wad-a-config" { axum::Json(json!({"Mountpoint": "/vol/_data"})).into_response() } else { StatusCode::NOT_FOUND.into_response() }
            }),
        )
        .route(
            "/v5.0.0/libpod/secrets/{name}/json",
            get(|Path(name): Path<String>, Query(q): Query<std::collections::HashMap<String, String>>| async move {
                match (name.as_str(), q.get("showsecret").map(String::as_str)) {
                    ("github_token", Some("true")) => axum::Json(json!({"Spec": {"Name": "github_token"}, "SecretData": "ghp_x"})).into_response(),
                    ("github_token", _) => axum::Json(json!({"Spec": {"Name": "github_token"}})).into_response(),
                    _ => StatusCode::NOT_FOUND.into_response(),
                }
            }),
        )
        .route(
            "/v5.0.0/libpod/build",
            post(|Query(q): Query<std::collections::HashMap<String, String>>, body: axum::body::Bytes| async move {
                let args: serde_json::Value = serde_json::from_str(q.get("buildargs").map(String::as_str).unwrap_or("{}")).unwrap();
                assert_eq!(&body[..], b"tar", "the build context arrives as the body");
                if q.get("t").map(String::as_str) == Some("localhost/wadspaces-bad:latest") {
                    return "{\"stream\":\"STEP 1/2: FROM base\\n\"}\n{\"error\":\"exit status 1\",\"errorDetail\":{\"message\":\"RUN failed: exit status 1\"}}\n".to_string();
                }
                format!(
                    "{{\"stream\":\"STEP 1/2: FROM {}\\n\"}}\n{{\"stream\":\"STEP 2/2: COPY root/ /\\n--> abc\\n\"}}\n{{\"stream\":\"{}\\n\"}}\n",
                    args["BASE_IMAGE"].as_str().unwrap(),
                    "f".repeat(64)
                )
            }),
        )
        .route(
            "/v5.0.0/libpod/images/pull",
            post(|Query(q): Query<std::collections::HashMap<String, String>>| async move {
                let r = q.get("reference").cloned().unwrap_or_default();
                if r == "ghcr.io/o/broken:1" {
                    "{\"stream\":\"Trying to pull ghcr.io/o/broken:1...\\n\"}\n{\"error\":\"manifest unknown\"}\n".to_string()
                } else {
                    "{\"stream\":\"Trying to pull\\n\"}\n{\"stream\":\"Copying blob sha256:abc\\n\"}\n{\"images\":[\"x\"],\"id\":\"x\"}\n".to_string()
                }
            }),
        );
    let listener = tokio::net::UnixListener::bind(&sock).unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (dir, Podman::new(sock))
}

#[tokio::test]
async fn images_containers_and_pulls() {
    let (_d, p) = fake().await;
    assert!(p.ping().await);
    assert_eq!(p.graph_root().await.unwrap().as_deref(), Some("/var/lib/containers/storage"));
    assert!(p.image_exists("ghcr.io/o/here:latest").await.unwrap());
    assert!(!p.image_exists("ghcr.io/o/gone:latest").await.unwrap());
    assert_eq!(p.image_labels("ghcr.io/o/here:latest").await.unwrap().unwrap()["io.wadspaces.projects"], "1");
    assert!(p.image_labels("nope").await.unwrap().is_none());
    assert_eq!(p.container_status("wad-up").await.unwrap(), "running");
    assert_eq!(p.container_status("wad-gone").await.unwrap(), "missing");
    assert_eq!(p.volume_mountpoint("wad-a-config").await.unwrap().as_deref(), Some("/vol/_data"));
    assert_eq!(p.volume_mountpoint("nope").await.unwrap(), None);
    assert_eq!(p.secret_value("github_token").await.unwrap().as_deref(), Some("ghp_x"));
    assert_eq!(p.secret_value("nope").await.unwrap(), None);
    let mut out = vec![];
    let args = serde_json::json!({"BASE_IMAGE": "localhost/wadspaces-base:trixie"}).as_object().unwrap().clone();
    let id =
        p.build(b"tar".to_vec(), "localhost/wadspaces-ok:latest", &args, |l| out.push(l.to_string())).await.unwrap();
    assert_eq!(id, "f".repeat(64));
    assert_eq!(out, ["STEP 1/2: FROM localhost/wadspaces-base:trixie", "STEP 2/2: COPY root/ /", "--> abc"]);
    let e = p.build(b"tar".to_vec(), "localhost/wadspaces-bad:latest", &args, |_| {}).await.unwrap_err();
    assert_eq!(e.to_string(), "RUN failed: exit status 1");
    let mut lines = vec![];
    p.pull("ghcr.io/o/ok:1", |l| lines.push(l.to_string())).await.unwrap();
    assert_eq!(lines, ["Trying to pull", "Copying blob sha256:abc"]);
    let e = p.pull("ghcr.io/o/broken:1", |_| {}).await.unwrap_err();
    assert_eq!(e.to_string(), "pull ghcr.io/o/broken:1: manifest unknown");
}

#[tokio::test]
async fn no_podman() {
    let p = Podman::new("/nonexistent/podman.sock");
    assert!(!p.ping().await);
    assert!(matches!(p.image_exists("x").await, Err(Error::Connect(..))));
}

#[test]
fn segments_are_encoded() {
    assert_eq!(segment("ghcr.io/o/n:1@sha256:ab"), "ghcr.io%2Fo%2Fn%3A1%40sha256%3Aab");
}

/// The real rootless podman (start its socket: systemctl --user start podman.socket).
#[tokio::test]
#[ignore]
async fn real_rootless_podman() {
    let sock = format!("{}/podman/podman.sock", std::env::var("XDG_RUNTIME_DIR").unwrap());
    let p = Podman::new(sock);
    assert!(p.ping().await, "podman.socket isn't running");
    assert!(p.graph_root().await.unwrap().is_some());
    p.pull("docker.io/library/busybox:latest", |l| eprintln!("pull: {l}")).await.unwrap();
    assert!(p.image_exists("docker.io/library/busybox:latest").await.unwrap());
    assert_eq!(p.container_status("wad-does-not-exist").await.unwrap(), "missing");
}

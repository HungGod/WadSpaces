//! Podman's libpod REST API over its Unix socket (rootful
//! /run/podman/podman.sock, rootless $XDG_RUNTIME_DIR/podman/podman.sock).
//! Plain HTTP/1.1 and JSON: one connection per call, which podman handles
//! fine and keeps this simple. Only what wadd uses.

use std::path::PathBuf;
use std::time::Duration;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use serde_json::Value;
use tokio::net::UnixStream;

const API: &str = "/v5.0.0/libpod";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("can't reach podman ({0}): {1}")]
    Connect(String, #[source] std::io::Error),
    #[error("podman: {0}")]
    Http(String),
    /// Podman answered with an error status: what it said.
    #[error("{what}: HTTP {status}: {message}")]
    Status { what: String, status: u16, message: String },
    /// An error inside a streamed answer (a pull or a build).
    #[error("{0}")]
    Stream(String),
    #[error("podman's answer to {0} wasn't what was expected: {1}")]
    Decode(String, String),
}

#[derive(Debug, Clone)]
pub struct Podman {
    socket: PathBuf,
}

/// Percent-encodes one path segment (an image reference has / : @ in it).
pub fn segment(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

impl Podman {
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Self { socket: socket.into() }
    }

    async fn send(&self, method: Method, path: &str, body: Option<(Bytes, &str)>) -> Result<Response<Incoming>, Error> {
        let stream = UnixStream::connect(&self.socket)
            .await
            .map_err(|e| Error::Connect(self.socket.display().to_string(), e))?;
        let (mut sender, conn) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| Error::Http(e.to_string()))?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        let mut req = Request::builder().method(method).uri(format!("{API}{path}")).header("host", "podman");
        let body = match body {
            Some((bytes, content_type)) => {
                req = req.header("content-type", content_type);
                bytes
            }
            None => Bytes::new(),
        };
        let req = req.body(Full::new(body)).map_err(|e| Error::Http(e.to_string()))?;
        sender.send_request(req).await.map_err(|e| Error::Http(e.to_string()))
    }

    async fn body(res: Response<Incoming>) -> Result<Bytes, Error> {
        Ok(res.into_body().collect().await.map_err(|e| Error::Http(e.to_string()))?.to_bytes())
    }

    async fn status_error(what: &str, res: Response<Incoming>) -> Error {
        let status = res.status().as_u16();
        let body = Self::body(res).await.unwrap_or_default();
        let message = serde_json::from_slice::<Value>(&body)
            .ok()
            .and_then(|v| v.get("message").and_then(Value::as_str).map(String::from))
            .unwrap_or_else(|| String::from_utf8_lossy(&body).trim().to_string());
        Error::Status { what: what.into(), status, message }
    }

    async fn get_json(&self, what: &str, path: &str) -> Result<Option<Value>, Error> {
        let res = self.send(Method::GET, path, None).await?;
        match res.status() {
            StatusCode::NOT_FOUND => Ok(None),
            s if s.is_success() => {
                let body = Self::body(res).await?;
                serde_json::from_slice(&body).map(Some).map_err(|e| Error::Decode(what.into(), e.to_string()))
            }
            _ => Err(Self::status_error(what, res).await),
        }
    }

    /// Whether podman answers (within 3 s).
    pub async fn ping(&self) -> bool {
        matches!(
            tokio::time::timeout(Duration::from_secs(3), self.send(Method::GET, "/_ping", None)).await,
            Ok(Ok(r)) if r.status() == StatusCode::OK
        )
    }

    /// Where podman keeps its images (to see which layers it has).
    pub async fn graph_root(&self) -> Result<Option<String>, Error> {
        let info = self.get_json("info", "/info").await?.unwrap_or(Value::Null);
        Ok(info.pointer("/store/graphRoot").and_then(Value::as_str).map(String::from))
    }

    pub async fn image_exists(&self, image: &str) -> Result<bool, Error> {
        let res = self.send(Method::GET, &format!("/images/{}/exists", segment(image)), None).await?;
        match res.status() {
            StatusCode::NO_CONTENT | StatusCode::OK => Ok(true),
            StatusCode::NOT_FOUND => Ok(false),
            _ => Err(Self::status_error(&format!("image exists {image}"), res).await),
        }
    }

    /// An image's labels; None if it isn't here.
    pub async fn image_labels(&self, image: &str) -> Result<Option<serde_json::Map<String, Value>>, Error> {
        let what = format!("inspect image {image}");
        Ok(self.get_json(&what, &format!("/images/{}/json", segment(image))).await?.map(|info| {
            info.get("Labels")
                .or_else(|| info.pointer("/Config/Labels"))
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default()
        }))
    }

    pub async fn inspect_container(&self, name: &str) -> Result<Option<Value>, Error> {
        self.get_json(&format!("inspect {name}"), &format!("/containers/{}/json", segment(name))).await
    }

    /// running | exited | created | paused | ... ; "missing" when there's no such
    /// container (quadlet runs them with --rm, so a stopped one is gone).
    pub async fn container_status(&self, name: &str) -> Result<String, Error> {
        Ok(match self.inspect_container(name).await? {
            None => "missing".into(),
            Some(info) => info.pointer("/State/Status").and_then(Value::as_str).unwrap_or("unknown").to_lowercase(),
        })
    }

    /// Pulls an image; `on_line` gets podman's progress lines as they come
    /// (they can't drive a progress bar: see wadd's pull module).
    pub async fn pull(&self, image: &str, mut on_line: impl FnMut(&str)) -> Result<(), Error> {
        let path = format!("/images/pull?reference={}&policy=missing", segment(image));
        let res = self.send(Method::POST, &path, None).await?;
        if !res.status().is_success() {
            return Err(Self::status_error(&format!("pull {image}"), res).await);
        }
        let mut body = res.into_body();
        let mut buf: Vec<u8> = Vec::new();
        while let Some(frame) = body.frame().await {
            let frame = frame.map_err(|e| Error::Http(e.to_string()))?;
            let Ok(data) = frame.into_data() else { continue };
            buf.extend_from_slice(&data);
            while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = buf.drain(..=nl).collect();
                let Ok(msg) = serde_json::from_slice::<Value>(&line) else { continue };
                if let Some(e) = msg.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()) {
                    return Err(Error::Stream(format!("pull {image}: {e}")));
                }
                if let Some(text) = msg.get("stream").and_then(Value::as_str) {
                    let text = text.trim();
                    if !text.is_empty() {
                        on_line(text);
                    }
                }
            }
        }
        Ok(())
    }

    // ---------------------------------------------------------- secrets
    /// The names of podman's secrets.
    pub async fn secret_names(&self) -> Result<Vec<String>, Error> {
        let list = self.get_json("list secrets", "/secrets/json").await?.unwrap_or(Value::Null);
        Ok(list
            .as_array()
            .map(|a| {
                a.iter().filter_map(|s| s.pointer("/Spec/Name").and_then(Value::as_str).map(String::from)).collect()
            })
            .unwrap_or_default())
    }

    pub async fn delete_secret(&self, name: &str) -> Result<bool, Error> {
        let res = self.send(Method::DELETE, &format!("/secrets/{}", segment(name)), None).await?;
        match res.status() {
            StatusCode::NOT_FOUND => Ok(false),
            s if s.is_success() => Ok(true),
            _ => Err(Self::status_error(&format!("delete secret {name}"), res).await),
        }
    }

    /// Creates (replacing) a secret. The value only ever goes to podman.
    pub async fn create_secret(&self, name: &str, value: &[u8]) -> Result<(), Error> {
        self.delete_secret(name).await?;
        let path = format!("/secrets/create?name={}", segment(name));
        let res =
            self.send(Method::POST, &path, Some((Bytes::copy_from_slice(value), "application/octet-stream"))).await?;
        if res.status().is_success() {
            Ok(())
        } else {
            Err(Self::status_error(&format!("create secret {name}"), res).await)
        }
    }
}

#[cfg(test)]
mod tests;

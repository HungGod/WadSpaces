//! Viewing another machine's stream here (remote.rs): against a stand-in
//! stream with wadd's own certificate, asking for a password like nginx.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use base64::Engine;
use bytes::Bytes;
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, PrivateKeyDer};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use wad_proto::ErrorCode;
use wadd::remote::{RemoteViews, Target};
use wadd::tls::StreamCert;

const USER: &str = "hunggod";
const PASSWORD: &str = "correct horse battery staple";

/// What the stand-in stream saw.
#[derive(Default)]
struct Seen {
    auth: Vec<String>,
    cookies: Vec<String>,
}

/// A stream sidecar: TLS with `dir`'s certificate, basic auth, "/" and an
/// upgrade that echoes.
async fn stream(dir: &std::path::Path, seen: Arc<Mutex<Seen>>) -> (u16, String) {
    let info = StreamCert::new(dir).ensure("other").unwrap();
    let certs = vec![CertificateDer::from_pem_file(dir.join("cert.pem")).unwrap()];
    let key = PrivateKeyDer::from_pem_file(dir.join("key.pem")).unwrap();
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let want = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{USER}:{PASSWORD}")));
    tokio::spawn(async move {
        while let Ok((tcp, _)) = listener.accept().await {
            let (acceptor, seen, want) = (acceptor.clone(), seen.clone(), want.clone());
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(tcp).await else { return };
                let svc = hyper::service::service_fn(move |mut req: Request<Incoming>| {
                    let (seen, want) = (seen.clone(), want.clone());
                    async move {
                        let h = |n| req.headers().get(n).and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
                        let auth = h(hyper::header::AUTHORIZATION);
                        {
                            let mut s = seen.lock().unwrap();
                            s.auth.push(auth.clone());
                            s.cookies.push(h(hyper::header::COOKIE));
                        }
                        if auth != want {
                            let mut r = Response::new(Full::new(Bytes::from("401")));
                            *r.status_mut() = StatusCode::UNAUTHORIZED;
                            r.headers_mut().insert("www-authenticate", "Basic realm=\"Login\"".parse().unwrap());
                            return Ok::<_, Infallible>(r);
                        }
                        if req.headers().contains_key(hyper::header::UPGRADE) {
                            let up = hyper::upgrade::on(&mut req);
                            tokio::spawn(async move {
                                let mut io = TokioIo::new(up.await.unwrap());
                                let mut buf = [0u8; 4];
                                io.read_exact(&mut buf).await.unwrap();
                                io.write_all(&buf).await.unwrap();
                            });
                            let mut r = Response::new(Full::new(Bytes::new()));
                            *r.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
                            r.headers_mut().insert("upgrade", "websocket".parse().unwrap());
                            r.headers_mut().insert("connection", "upgrade".parse().unwrap());
                            return Ok(r);
                        }
                        Ok(Response::new(Full::new(Bytes::from("the stream page"))))
                    }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(tls), svc)
                    .with_upgrades()
                    .await;
            });
        }
    });
    (port, info.sha256)
}

/// One request to the proxy, as text (the head, and the body if `close`).
async fn raw(port: u16, path: &str, cookie: Option<&str>, upgrade: bool) -> (String, TcpStream) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n");
    if let Some(c) = cookie {
        req.push_str(&format!("Cookie: other=1; {c}\r\n"));
    }
    req.push_str(if upgrade { "Connection: Upgrade\r\nUpgrade: websocket\r\n" } else { "Connection: close\r\n" });
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let mut buf = [0u8; 4096];
    loop {
        let n = s.read(&mut buf).await.unwrap();
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        if upgrade && out.windows(4).any(|w| w == b"\r\n\r\n") {
            break;
        }
    }
    (String::from_utf8_lossy(&out).into_owned(), s)
}

#[tokio::test]
async fn a_view_pins_the_certificate_adds_the_password_and_is_only_its_windows() {
    let d = tempfile::tempdir().unwrap();
    let seen = Arc::new(Mutex::new(Seen::default()));
    let (port, sha256) = stream(&d.path().join("tls"), seen.clone()).await;
    let views = RemoteViews::new(std::time::Duration::from_secs(600));
    let target = Target {
        machine: "Desk".into(),
        urls: vec!["https://127.0.0.1:1/".into(), format!("https://127.0.0.1:{port}/")], // the first doesn't answer
        user: USER.into(),
        sha256: sha256.clone(),
    };
    let view = views.open(target.clone(), PASSWORD).await.unwrap();
    assert_eq!(view.machine, "Desk");
    let (local, token) = {
        let rest = view.url.strip_prefix("http://127.0.0.1:").unwrap();
        let (p, t) = rest.split_once("/__wad/").unwrap();
        (p.parse::<u16>().unwrap(), t.to_string())
    };

    // Without the token's cookie: refused, and nothing reaches the stream.
    assert!(raw(local, "/", None, false).await.0.starts_with("HTTP/1.1 403"));
    assert!(raw(local, "/__wad/0000", None, false).await.0.starts_with("HTTP/1.1 403"));
    assert!(seen.lock().unwrap().auth.is_empty());
    // The window's first load: a cookie, and on to the page.
    let (head, _) = raw(local, &format!("/__wad/{token}"), None, false).await;
    assert!(head.starts_with("HTTP/1.1 302"), "{head}");
    assert!(head.contains(&format!("set-cookie: wad_view={token}; HttpOnly; SameSite=Strict")), "{head}");
    let cookie = format!("wad_view={token}");
    let (page, _) = raw(local, "/", Some(&cookie), false).await;
    assert!(page.starts_with("HTTP/1.1 200") && page.ends_with("the stream page"), "{page}");
    {
        let s = seen.lock().unwrap();
        assert!(s.auth.last().unwrap().starts_with("Basic "));
        assert!(s.cookies.iter().all(|c| c.is_empty()), "cookies went on: {:?}", s.cookies);
    }
    // The stream's websocket passes through.
    let (head, mut ws) = raw(local, "/websocket", Some(&cookie), true).await;
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    ws.write_all(b"ping").await.unwrap();
    let mut echo = [0u8; 4];
    ws.read_exact(&mut echo).await.unwrap();
    assert_eq!(&echo, b"ping");

    // A password the stream doesn't take: said in words, never a login prompt.
    let wrong = views.open(target.clone(), "a different long password").await.unwrap();
    let (wl, wt) = {
        let rest = wrong.url.strip_prefix("http://127.0.0.1:").unwrap();
        let (p, t) = rest.split_once("/__wad/").unwrap();
        (p.parse::<u16>().unwrap(), t.to_string())
    };
    let (page, _) = raw(wl, "/", Some(&format!("wad_view={wt}")), false).await;
    assert!(page.starts_with("HTTP/1.1 502") && page.contains("refused the stream password"), "{page}");
    assert!(!page.to_lowercase().contains("www-authenticate"));
    // Each view has its own token.
    assert!(raw(wl, "/", Some(&cookie), false).await.0.starts_with("HTTP/1.1 403"));

    // Another certificate than the account says: not even connected.
    let other = Target { sha256: "ab".repeat(32), ..target.clone() };
    let err = views.open(other, PASSWORD).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Offline);
    assert!(err.message.contains("not the certificate this stream published"), "{}", err.message);

    // Closed: gone.
    assert!(views.close(&view.id));
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    assert!(TcpStream::connect(("127.0.0.1", local)).await.is_err());
    assert!(!views.close(&view.id));
}

/// Against a real stream sidecar (apps/wadd/dev/try-stream.sh sets these):
/// the page and the websocket through a view.
#[tokio::test]
#[ignore = "needs a running stream: apps/wadd/dev/try-stream.sh"]
async fn a_view_of_a_real_stream() {
    let var = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k}"));
    let password = std::fs::read_to_string(var("TRY_STREAM_PASSWORD_FILE")).unwrap();
    let target = Target {
        machine: "this laptop".into(),
        urls: var("TRY_STREAM_URLS").split(',').map(String::from).collect(),
        user: var("TRY_STREAM_USER"),
        sha256: var("TRY_STREAM_SHA256"),
    };
    let views = RemoteViews::new(std::time::Duration::from_secs(600));
    let view = views.open(target, password.trim()).await.unwrap();
    let rest = view.url.strip_prefix("http://127.0.0.1:").unwrap();
    let (p, token) = rest.split_once("/__wad/").unwrap();
    let local: u16 = p.parse().unwrap();
    let cookie = format!("wad_view={token}");
    let (page, _) = raw(local, "/", Some(&cookie), false).await;
    assert!(
        page.starts_with("HTTP/1.1 200") && page.to_lowercase().contains("<html"),
        "{}",
        &page[..page.len().min(300)]
    );
    let mut s = TcpStream::connect(("127.0.0.1", local)).await.unwrap();
    let req = format!(
        "GET /websocket HTTP/1.1\r\nHost: x\r\nCookie: {cookie}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\
         Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n"
    );
    s.write_all(req.as_bytes()).await.unwrap();
    let mut buf = [0u8; 512];
    let n = s.read(&mut buf).await.unwrap();
    let head = String::from_utf8_lossy(&buf[..n]);
    assert!(head.starts_with("HTTP/1.1 101"), "{head}");
    println!("through a view: the page (200) and the websocket (101)");
}

//! Viewing another of the owner's machines' streams on this one: a proxy
//! for Wad Creator's viewer window (a webview of its own, no IPC).
//!
//! The window talks plain HTTP to 127.0.0.1 here; the proxy talks to the
//! other machine's stream sidecar (streams.rs over there):
//!
//! - **pinned TLS**: only the certificate whose SHA-256 that machine put in
//!   the account (relay.sibling_stream reads it with this machine's own
//!   token) is accepted; nothing else is trusted;
//! - **the password added here**: the stream password is this machine's
//!   podman secret (the same account's), so it never reaches the page;
//! - **only that window**: each view has a random token. The window opens
//!   `/__wad/<token>`, which sets a cookie and goes to `/`; anything without
//!   the cookie is refused (another program on this machine can find the
//!   port, not the token). It listens on 127.0.0.1 only;
//! - websockets (Selkies' stream) pass through.
//!
//! A view ends when the window says so, or when it's been idle for a while.

use std::collections::HashMap;
use std::convert::Infallible;
use std::io::Read;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use bytes::Bytes;
use http_body_util::{BodyExt, Empty, Full, combinators::BoxBody};
use hyper::body::Incoming;
use hyper::header::{self, HeaderValue};
use hyper::{Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;
use wad_proto::v1::RemoteView;
use wad_proto::{ApiError, ErrorCode};

const COOKIE: &str = "wad_view";
const CONNECT: Duration = Duration::from_secs(5);

/// Where another machine streams a workspace (from its heartbeat).
#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub machine: String,
    /// https://<address>:<port>/, one per address it has.
    pub urls: Vec<String>,
    pub user: String,
    /// Its certificate's SHA-256 (lowercase hex): the only one accepted.
    pub sha256: String,
}

type Body = BoxBody<Bytes, hyper::Error>;

fn full(status: StatusCode, text: &str) -> Response<Body> {
    let mut r = Response::new(Full::new(Bytes::from(text.to_string())).map_err(|e| match e {}).boxed());
    *r.status_mut() = status;
    r.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("text/plain; charset=utf-8"));
    r
}

fn now_s() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn random_hex(n: usize) -> String {
    let mut b = vec![0u8; n];
    std::fs::File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut b)).expect("/dev/urandom");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Accepts exactly one certificate (by its SHA-256), with real signature
/// checks: a stream's self-signed certificate, vouched for by the account.
#[derive(Debug)]
struct Pinned {
    sha256: String,
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if crate::tls::sha256_hex(end_entity.as_ref()) == self.sha256 {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General("not the certificate this stream published".into()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn connector(sha256: &str) -> Result<TlsConnector, String> {
    let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| e.to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned { sha256: sha256.into(), provider }))
        .with_no_client_auth();
    Ok(TlsConnector::from(Arc::new(config)))
}

/// "https://192.168.1.5:47800/" -> ("192.168.1.5", 47800).
fn host_port(url: &str) -> Option<(String, u16)> {
    let rest = url.strip_prefix("https://")?.trim_end_matches('/');
    let (host, port) = rest.rsplit_once(':')?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    (!host.is_empty() && !host.contains('/')).then(|| Some((host.to_string(), port.parse().ok()?)))?
}

/// One view's proxy.
struct Proxy {
    token: String,
    machine: String,
    tls: TlsConnector,
    host: String,
    port: u16,
    auth: HeaderValue,
    /// Unix seconds of the last request.
    last: AtomicU64,
    /// Websockets open now.
    open: AtomicUsize,
}

impl Proxy {
    async fn connect(&self) -> Result<TlsStream<TcpStream>, String> {
        connect(&self.tls, &self.host, self.port).await
    }

    async fn handle(self: Arc<Self>, req: Request<Incoming>) -> Result<Response<Body>, Infallible> {
        self.last.store(now_s(), Ordering::Relaxed);
        if let Some(rest) = req.uri().path().strip_prefix("/__wad/") {
            if rest != self.token {
                return Ok(full(StatusCode::FORBIDDEN, "not this view"));
            }
            let mut r = full(StatusCode::FOUND, "");
            r.headers_mut().insert(header::LOCATION, HeaderValue::from_static("/"));
            let cookie = format!("{COOKIE}={}; HttpOnly; SameSite=Strict; Path=/", self.token);
            r.headers_mut().insert(header::SET_COOKIE, HeaderValue::from_str(&cookie).expect("ascii"));
            return Ok(r);
        }
        if !self.has_cookie(&req) {
            return Ok(full(StatusCode::FORBIDDEN, "not this view"));
        }
        Ok(match self.clone().forward(req).await {
            Ok(r) => r,
            Err(e) => {
                tracing::info!("remote view of {}: {e}", self.machine);
                full(StatusCode::BAD_GATEWAY, &format!("{}'s stream: {e}", self.machine))
            }
        })
    }

    fn has_cookie(&self, req: &Request<Incoming>) -> bool {
        req.headers().get_all(header::COOKIE).iter().filter_map(|v| v.to_str().ok()).any(|v| {
            v.split(';').any(|c| c.trim().split_once('=').is_some_and(|(k, val)| k == COOKIE && val == self.token))
        })
    }

    async fn forward(self: Arc<Self>, mut req: Request<Incoming>) -> Result<Response<Body>, String> {
        let client_upgrade = req.headers().contains_key(header::UPGRADE).then(|| hyper::upgrade::on(&mut req));
        let (mut parts, body) = req.into_parts();
        let origin = format!("https://{}:{}", self.host, self.port);
        let h = &mut parts.headers;
        // This view's cookie and any credentials stay here; the stream's go on.
        for name in [header::COOKIE, header::AUTHORIZATION, header::PROXY_AUTHORIZATION] {
            h.remove(name);
        }
        h.insert(
            header::HOST,
            HeaderValue::from_str(&format!("{}:{}", self.host, self.port)).map_err(|e| e.to_string())?,
        );
        h.insert(header::AUTHORIZATION, self.auth.clone());
        if h.contains_key(header::ORIGIN) {
            h.insert(header::ORIGIN, HeaderValue::from_str(&origin).map_err(|e| e.to_string())?);
        }
        let pq = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/").to_string();
        parts.uri = pq.parse().map_err(|e: hyper::http::uri::InvalidUri| e.to_string())?;
        let tls = self.connect().await?;
        let (mut sender, conn) =
            hyper::client::conn::http1::handshake(TokioIo::new(tls)).await.map_err(|e| e.to_string())?;
        tokio::spawn(async move {
            let _ = conn.with_upgrades().await;
        });
        let mut resp = sender.send_request(Request::from_parts(parts, body)).await.map_err(|e| e.to_string())?;
        if resp.status() == StatusCode::UNAUTHORIZED {
            // Not passed on: the window would ask for a password itself.
            return Ok(full(
                StatusCode::BAD_GATEWAY,
                &format!("{} refused the stream password: it isn't the account's one there yet", self.machine),
            ));
        }
        if resp.status() == StatusCode::SWITCHING_PROTOCOLS
            && let Some(client) = client_upgrade
        {
            let upstream = hyper::upgrade::on(&mut resp);
            let me = self.clone();
            tokio::spawn(async move {
                let (Ok(a), Ok(b)) = (client.await, upstream.await) else { return };
                me.open.fetch_add(1, Ordering::Relaxed);
                let (mut a, mut b) = (TokioIo::new(a), TokioIo::new(b));
                let _ = tokio::io::copy_bidirectional(&mut a, &mut b).await;
                me.open.fetch_sub(1, Ordering::Relaxed);
                me.last.store(now_s(), Ordering::Relaxed);
            });
            let (p, _) = resp.into_parts();
            return Ok(Response::from_parts(p, Empty::new().map_err(|e| match e {}).boxed()));
        }
        resp.headers_mut().remove(header::WWW_AUTHENTICATE);
        Ok(resp.map(|b| b.boxed()))
    }
}

async fn connect(tls: &TlsConnector, host: &str, port: u16) -> Result<TlsStream<TcpStream>, String> {
    let tcp = tokio::time::timeout(CONNECT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| format!("{host}:{port} didn't answer"))?
        .map_err(|e| format!("{host}:{port}: {e}"))?;
    let name = ServerName::try_from(host.to_string()).map_err(|e| e.to_string())?;
    tokio::time::timeout(CONNECT, tls.connect(name, tcp))
        .await
        .map_err(|_| format!("{host}:{port}: no TLS answer"))?
        .map_err(|e| format!("{host}:{port}: {e}"))
}

struct Open {
    view: RemoteView,
    proxy: Arc<Proxy>,
    task: JoinHandle<()>,
}

pub struct RemoteViews {
    views: Mutex<HashMap<String, Open>>,
    idle: Duration,
}

impl RemoteViews {
    /// Views end after `idle` with nothing going through them.
    pub fn new(idle: Duration) -> Arc<Self> {
        let me = Arc::new(Self { views: Mutex::default(), idle });
        let weak = Arc::downgrade(&me);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(15)).await;
                let Some(me) = weak.upgrade() else { return };
                me.reap();
            }
        });
        me
    }

    fn reap(&self) {
        let now = now_s();
        let idle: Vec<String> = self
            .views
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, o)| {
                o.proxy.open.load(Ordering::Relaxed) == 0
                    && now.saturating_sub(o.proxy.last.load(Ordering::Relaxed)) > self.idle.as_secs()
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in idle {
            tracing::info!("remote view {id}: idle, closed");
            self.close(&id);
        }
    }

    /// Opens a view of `target` (a URL for the window to load).
    pub async fn open(&self, target: Target, password: &str) -> Result<RemoteView, ApiError> {
        let err = |code, m: String| ApiError::new(code, m);
        if password.is_empty() || target.user.is_empty() {
            return Err(err(ErrorCode::Conflict, "there's no stream password on this machine yet".into()));
        }
        let tls = connector(&target.sha256).map_err(|e| err(ErrorCode::Internal, e))?;
        // The first of its addresses that answers with its certificate.
        let mut last = String::from("no addresses");
        let mut found = None;
        for url in &target.urls {
            let Some((host, port)) = host_port(url) else { continue };
            match connect(&tls, &host, port).await {
                Ok(_) => {
                    found = Some((host, port));
                    break;
                }
                Err(e) => last = e,
            }
        }
        let Some((host, port)) = found else {
            return Err(err(ErrorCode::Offline, format!("can't reach {}'s stream: {last}", target.machine)));
        };
        let basic = base64::engine::general_purpose::STANDARD.encode(format!("{}:{password}", target.user));
        let auth =
            HeaderValue::from_str(&format!("Basic {basic}")).map_err(|e| err(ErrorCode::BadRequest, e.to_string()))?;
        let listener =
            TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| err(ErrorCode::Internal, e.to_string()))?;
        let local = listener.local_addr().map_err(|e| err(ErrorCode::Internal, e.to_string()))?.port();
        let token = random_hex(32);
        let proxy = Arc::new(Proxy {
            token: token.clone(),
            machine: target.machine.clone(),
            tls,
            host,
            port,
            auth,
            last: AtomicU64::new(now_s()),
            open: AtomicUsize::new(0),
        });
        let p = proxy.clone();
        let task = tokio::spawn(async move {
            while let Ok((tcp, _)) = listener.accept().await {
                let p = p.clone();
                tokio::spawn(async move {
                    let svc = hyper::service::service_fn(move |req| p.clone().handle(req));
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tcp), svc)
                        .with_upgrades()
                        .await;
                });
            }
        });
        let id = random_hex(8);
        let view = RemoteView {
            id: id.clone(),
            machine: target.machine.clone(),
            url: format!("http://127.0.0.1:{local}/__wad/{token}"),
        };
        tracing::info!("remote view {id}: {} via {}:{}", target.machine, proxy.host, proxy.port);
        self.views.lock().unwrap().insert(id, Open { view: view.clone(), proxy, task });
        Ok(view)
    }

    /// Ends a view (its window closed). False if there's no such view.
    pub fn close(&self, id: &str) -> bool {
        match self.views.lock().unwrap().remove(id) {
            Some(o) => {
                o.task.abort();
                true
            }
            None => false,
        }
    }

    pub fn ids(&self) -> Vec<String> {
        self.views.lock().unwrap().values().map(|o| o.view.id.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        assert_eq!(host_port("https://192.168.1.5:47800/"), Some(("192.168.1.5".into(), 47800)));
        assert_eq!(host_port("https://[fd00::1]:47800/"), Some(("fd00::1".into(), 47800)));
        assert_eq!(host_port("http://192.168.1.5:47800/"), None);
        assert_eq!(host_port("https://x/y:1/"), None);
        assert_eq!(random_hex(32).len(), 64);
    }
}

//! The Python wadd's tests for this (tests/test_registry.py), carried over.

use serde_json::json;
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

use super::*;

#[test]
fn refs() {
    let t = |a: &str, b: &str, c: &str| (a.to_string(), b.to_string(), c.to_string());
    assert_eq!(
        parse_ref("ghcr.io/hunggod/wadspaces-kale-b:latest"),
        t("ghcr.io", "hunggod/wadspaces-kale-b", "latest")
    );
    assert_eq!(parse_ref("busybox"), t("docker.io", "library/busybox", "latest"));
    assert_eq!(parse_ref("docker.io/library/python:3.12-slim"), t("docker.io", "library/python", "3.12-slim"));
    assert_eq!(parse_ref("localhost:5000/x/y@sha256:ab"), t("localhost:5000", "x/y", "sha256:ab"));
    assert_eq!(parse_ref("quay.io/fedora/fedora-bootc:43"), t("quay.io", "fedora/fedora-bootc", "43"));
}

#[test]
fn challenges() {
    let c = parse_challenge(r#"Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/n:pull""#);
    assert_eq!(c["realm"], "https://ghcr.io/token");
    assert_eq!(c["service"], "ghcr.io");
    assert_eq!(c["scope"], "repository:o/n:pull");
}

#[test]
fn credentials() {
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("auth.json");
    std::fs::write(
        &f,
        json!({"auths": {"ghcr.io": {"auth": base64::engine::general_purpose::STANDARD.encode("me:tok:en")}}})
            .to_string(),
    )
    .unwrap();
    let files = vec![f.display().to_string()];
    assert_eq!(registry_credentials("ghcr.io", &files), Some(("me".into(), "tok:en".into())));
    assert_eq!(registry_credentials("quay.io", &files), None);
    assert_eq!(registry_credentials("ghcr.io", &[d.path().join("missing.json").display().to_string()]), None);
}

/// ghcr-like: 401 and the token dance, an index pointing at an amd64 manifest.
async fn registry(private: bool) -> MockServer {
    let s = MockServer::start().await;
    let realm = format!("{}/token", s.uri());
    let challenge = format!(r#"Bearer realm="{realm}",service="ghcr.io",scope="repository:o/n:pull""#);
    if private {
        Mock::given(path("/token"))
            .and(header("authorization", "Basic dTpw"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"token": "T"})))
            .mount(&s)
            .await;
        Mock::given(path("/token")).respond_with(ResponseTemplate::new(401)).mount(&s).await;
    } else {
        Mock::given(path("/token"))
            .and(query_param("scope", "repository:o/n:pull"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({"token": "T"})))
            .mount(&s)
            .await;
    }
    let index = json!({"mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [
        {"digest": "sha256:arm", "platform": {"architecture": "arm64", "os": "linux"}},
        {"digest": "sha256:amd", "platform": {"architecture": "amd64", "os": "linux"}},
    ]});
    let manifest = json!({"mediaType": "application/vnd.oci.image.manifest.v1+json",
        "layers": [{"digest": "sha256:l1", "size": 100}, {"digest": "sha256:l2", "size": 50}]});
    Mock::given(method("GET"))
        .and(path("/v2/o/n/manifests/latest"))
        .and(header("authorization", "Bearer T"))
        .respond_with(ResponseTemplate::new(200).set_body_json(index))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/o/n/manifests/sha256:amd"))
        .and(header("authorization", "Bearer T"))
        .respond_with(ResponseTemplate::new(200).set_body_json(manifest))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .respond_with(ResponseTemplate::new(401).insert_header("www-authenticate", challenge.as_str()))
        .mount(&s)
        .await;
    s
}

#[tokio::test]
async fn sizes_follow_the_token_and_the_index() {
    if arch() != "amd64" {
        return;
    }
    let s = registry(false).await;
    let got = fetch_layer_sizes(&reqwest::Client::new(), "ghcr.io/o/n:latest", &[], Some(&s.uri())).await.unwrap();
    assert_eq!(got, HashMap::from([("sha256:l1".to_string(), 100), ("sha256:l2".to_string(), 50)]));
}

#[tokio::test]
async fn private_images_send_the_saved_login() {
    if arch() != "amd64" {
        return;
    }
    let s = registry(true).await;
    let d = tempfile::tempdir().unwrap();
    let f = d.path().join("auth.json");
    std::fs::write(
        &f,
        json!({"auths": {"ghcr.io": {"auth": base64::engine::general_purpose::STANDARD.encode("u:p")}}}).to_string(),
    )
    .unwrap();
    let got =
        fetch_layer_sizes(&reqwest::Client::new(), "ghcr.io/o/n:latest", &[f.display().to_string()], Some(&s.uri()))
            .await;
    assert_eq!(got.map(|m| m.len()), Some(2));
}

#[tokio::test]
async fn a_failing_registry_is_no_bar() {
    let s = MockServer::start().await;
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(500)).mount(&s).await;
    assert!(fetch_layer_sizes(&reqwest::Client::new(), "ghcr.io/o/n:latest", &[], Some(&s.uri())).await.is_none());
}

#[test]
fn local_layers_and_interfaces() {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join("overlay-layers")).unwrap();
    std::fs::write(
        d.path().join("overlay-layers/layers.json"),
        json!([{"id": "a", "compressed-diff-digest": "sha256:l1"}, {"id": "b"}]).to_string(),
    )
    .unwrap();
    assert_eq!(local_blob_digests(d.path()), HashSet::from(["sha256:l1".to_string()]));
    assert!(local_blob_digests(&d.path().join("nowhere")).is_empty());

    let n = tempfile::tempdir().unwrap();
    for (name, bytes) in [("lo", 999), ("wlp1s0", 100), ("enp0s1", 20), ("podman0", 500), ("veth12", 7)] {
        let s = n.path().join(name).join("statistics");
        std::fs::create_dir_all(&s).unwrap();
        std::fs::write(s.join("rx_bytes"), format!("{bytes}\n")).unwrap();
    }
    assert_eq!(rx_bytes(n.path()), 120);
}

#[test]
fn progress_math() {
    let mut p = Progress::new(Some(1000), 3, 5000);
    p.sample(5000, 0.0);
    assert_eq!((p.percent(), p.eta_s()), (Some(0), None));
    p.sample(5010, 1.0);
    assert_eq!((p.percent(), p.eta_s()), (Some(1), None)); // under 2%: no guess yet
    p.sample(5100, 2.0);
    assert_eq!((p.done_bytes, p.percent()), (100, Some(10)));
    assert!(p.eta_s().is_some_and(|e| e > 0));
    p.sample(9000, 3.0); // other traffic too: never past the cap before finish()
    assert!(p.percent() == Some(99) && !p.unpacking);
    p.sample(9000, 5.0);
    assert!(!p.unpacking);
    p.sample(9000, 6.5); // nothing new for 3.5 s near the end
    assert!(p.unpacking && p.eta_s().is_none());
    assert_eq!(p.describe(), "downloaded 990 B, unpacking");
    p.finish();
    assert_eq!(p.percent(), Some(100));
}

#[test]
fn progress_without_sizes() {
    let mut p = Progress::new(None, 4, 0);
    p.sample(1_000_000_000, 1.0);
    assert!(p.percent().is_none() && p.eta_s().is_none() && p.done_bytes == 1_000_000_000);
    assert_eq!(p.describe(), "downloading 4 layers");
}

#[test]
fn descriptions() {
    let mut p = Progress::new(Some(5_300_000_000), 0, 0);
    p.sample(1_888_000_000, 0.0);
    p.sample(1_900_000_000, 1.0); // 12 MB in the last second
    assert_eq!(p.describe(), "1.9 GB of 5.3 GB · 12.0 MB/s · about 4 min left");
    assert_eq!(Progress::new(Some(0), 0, 0).describe(), "already downloaded, unpacking");
    let mut early = Progress::new(Some(1_000_000_000), 0, 0);
    early.sample(0, 0.0);
    early.sample(7000, 1.0);
    assert_eq!(early.describe(), "7 KB of 1.0 GB"); // no silly "1020 min left"
    assert_eq!(human_bytes(512.0), "512 B");
    assert_eq!(human_bytes(12_000_000.0), "12.0 MB");
}

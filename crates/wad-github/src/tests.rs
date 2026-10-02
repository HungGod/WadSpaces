use super::*;
use serde_json::json;
use wiremock::matchers::{body_partial_json, body_string_contains, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn app() -> AppConfig {
    AppConfig { client_id: "Ov23test".into(), scopes: vec!["repo".into(), "read:org".into()] }
}

async fn server() -> (MockServer, Github) {
    let s = MockServer::start().await;
    let gh = Github::with_base(reqwest::Client::new(), &s.uri(), &s.uri());
    (s, gh)
}

fn ok(body: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(body)
}

async fn mount_start(s: &MockServer, interval: u64, expires_in: u32) {
    Mock::given(method("POST"))
        .and(path("/login/device/code"))
        .and(header("accept", "application/json"))
        .and(body_string_contains("client_id=Ov23test"))
        .and(body_string_contains("scope=repo+read%3Aorg"))
        .respond_with(ok(json!({
            "device_code": "dev123", "user_code": "WDJB-MJHT",
            "verification_uri": "https://github.com/login/device",
            "expires_in": expires_in, "interval": interval,
        })))
        .mount(s)
        .await;
}

async fn mount_poll(s: &MockServer, body: serde_json::Value, times: u64) {
    Mock::given(method("POST"))
        .and(path("/login/oauth/access_token"))
        .and(body_string_contains("device_code=dev123"))
        .and(body_string_contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code"))
        .respond_with(ok(body))
        .up_to_n_times(times)
        .mount(s)
        .await;
}

#[tokio::test]
async fn start_returns_the_code_to_show() {
    let (s, gh) = server().await;
    mount_start(&s, 5, 900).await;
    let start = gh.device_start(&app()).await.unwrap();
    assert_eq!(
        start.code,
        DeviceCode {
            user_code: "WDJB-MJHT".into(),
            verification_uri: "https://github.com/login/device".into(),
            expires_in: 900
        }
    );
    assert_eq!(start.interval, Duration::from_secs(5));
}

#[tokio::test]
async fn waits_through_pending_and_slow_down() {
    let (s, gh) = server().await;
    mount_start(&s, 0, 900).await;
    mount_poll(&s, json!({"error": "authorization_pending"}), 1).await;
    mount_poll(&s, json!({"error": "slow_down", "interval": 0}), 1).await;
    mount_poll(&s, json!({"access_token": "gho_abc", "token_type": "bearer", "scope": "repo"}), 1).await;
    let start = gh.device_start(&app()).await.unwrap();
    let token = gh.device_wait(&app(), &start).await.unwrap();
    assert_eq!(token.expose(), "gho_abc");
    assert_eq!(format!("{token:?}"), "Token(…)");
}

#[tokio::test]
async fn slow_down_without_interval_adds_five_seconds() {
    let (s, gh) = server().await;
    mount_start(&s, 5, 900).await;
    mount_poll(&s, json!({"error": "slow_down"}), 1).await;
    let start = gh.device_start(&app()).await.unwrap();
    match gh.device_poll(&app(), &start).await.unwrap() {
        Poll::SlowDown(d) => assert_eq!(d, Duration::from_secs(10)),
        p => panic!("{p:?}"),
    }
}

#[tokio::test]
async fn poll_errors() {
    for (code, want) in [
        ("expired_token", "Expired"),
        ("access_denied", "Denied"),
        ("device_flow_disabled", "DeviceFlowDisabled"),
        ("incorrect_client_credentials", "BadClient"),
        ("unsupported_grant_type", "Upstream"),
    ] {
        let (s, gh) = server().await;
        mount_start(&s, 0, 900).await;
        mount_poll(&s, json!({"error": code, "error_description": "x"}), 1).await;
        let start = gh.device_start(&app()).await.unwrap();
        let err = gh.device_wait(&app(), &start).await.unwrap_err();
        assert!(format!("{err:?}").starts_with(want), "{code}: {err:?}");
    }
}

#[tokio::test]
async fn start_with_a_bad_client() {
    let (s, gh) = server().await;
    Mock::given(path("/login/device/code"))
        .respond_with(ok(json!({"error": "unauthorized_client", "error_description": "nope"})))
        .mount(&s)
        .await;
    assert!(matches!(gh.device_start(&app()).await, Err(Error::BadClient)));
}

#[tokio::test]
async fn gives_up_when_the_code_expires() {
    let (s, gh) = server().await;
    mount_start(&s, 0, 0).await;
    mount_poll(&s, json!({"error": "authorization_pending"}), 100).await;
    let start = gh.device_start(&app()).await.unwrap();
    assert!(matches!(gh.device_wait(&app(), &start).await, Err(Error::Expired)));
}

#[tokio::test]
async fn user_and_revoked_tokens() {
    let (s, gh) = server().await;
    Mock::given(method("GET"))
        .and(path("/user"))
        .and(header("authorization", "Bearer good"))
        .respond_with(ok(json!({"login": "octocat", "name": "Octo Cat", "avatar_url": "https://a/1", "id": 1})))
        .mount(&s)
        .await;
    Mock::given(method("GET")).and(path("/user")).respond_with(ResponseTemplate::new(401)).mount(&s).await;
    let u = gh.user(&Token::new("good")).await.unwrap();
    assert_eq!(u.login, "octocat");
    assert_eq!(u.name.as_deref(), Some("Octo Cat"));
    assert!(matches!(gh.user(&Token::new("revoked")).await, Err(Error::BadToken)));
}

#[test]
fn errors_map_to_api_codes() {
    assert_eq!(ApiError::from(Error::Expired).code, ErrorCode::Cancelled);
    assert_eq!(ApiError::from(Error::BadToken).code, ErrorCode::Unauthorized);
}

#[test]
fn reads_the_machine_config() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/usr/lib/wadspaces/github.toml");
    let app = AppConfig::load(path.as_ref()).unwrap();
    assert!(app.client_id.starts_with("Ov23"), "{}", app.client_id);
    assert_eq!(app.scopes, ["repo", "workflow", "read:org"]);
}

#[tokio::test]
async fn every_page_of_repos() {
    let s = MockServer::start().await;
    let api = format!("{}/api", s.uri());
    Mock::given(method("GET"))
        .and(path("/api/user"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"login": "HungGod"})))
        .mount(&s)
        .await;
    let repo = |n: &str| json!({"full_name": format!("HungGod/{n}"), "name": n, "private": true, "clone_url": format!("https://github.com/HungGod/{n}.git"), "default_branch": "main", "pushed_at": "2026-10-01T00:00:00Z", "description": null});
    Mock::given(method("GET"))
        .and(path("/api/user/repos"))
        .and(query_param("page", "2"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([repo("two")])))
        .mount(&s)
        .await;
    Mock::given(method("GET"))
        .and(path("/api/user/repos"))
        .and(query_param("affiliation", "owner,collaborator,organization_member"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!([repo("one")])).insert_header(
            "link",
            format!("<{api}/user/repos?page=2>; rel=\"next\", <{api}/user/repos?page=2>; rel=\"last\"").as_str(),
        ))
        .mount(&s)
        .await;
    let gh = Github::with_base(reqwest::Client::new(), &s.uri(), &api);
    let (login, repos) = gh.repos(&Token::new("gho_x")).await.unwrap();
    assert_eq!(login, "HungGod");
    let names: Vec<&str> = repos.iter().map(|r| r.name.as_str()).collect();
    assert_eq!(names, ["one", "two"]);
    assert_eq!(
        (repos[0].url.as_str(), repos[0].private, repos[0].description.as_str()),
        ("https://github.com/HungGod/one.git", true, "")
    );
}

#[tokio::test]
async fn making_a_repo_and_what_github_says_when_it_wont() {
    let s = MockServer::start().await;
    let api = format!("{}/api", s.uri());
    Mock::given(method("POST"))
        .and(path("/api/user/repos"))
        .and(body_partial_json(json!({"name": "notes", "private": true, "auto_init": true})))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({"full_name": "HungGod/notes", "name": "notes", "private": true, "clone_url": "https://github.com/HungGod/notes.git", "default_branch": "main"})))
        .mount(&s)
        .await;
    Mock::given(method("POST"))
        .and(path("/api/user/repos"))
        .and(body_partial_json(json!({"name": "taken"})))
        .respond_with(ResponseTemplate::new(422).set_body_json(json!({"message": "Repository creation failed.", "errors": [{"resource": "Repository", "code": "custom", "field": "name", "message": "name already exists on this account"}]})))
        .mount(&s)
        .await;
    Mock::given(method("GET")).and(path("/api/user")).respond_with(ResponseTemplate::new(401)).mount(&s).await;
    let gh = Github::with_base(reqwest::Client::new(), &s.uri(), &api);
    let tok = Token::new("gho_x");
    let r = gh.create_repo(&tok, "notes", true, "").await.unwrap();
    assert_eq!(r.full_name, "HungGod/notes");
    let e = gh.create_repo(&tok, "taken", true, "").await.unwrap_err();
    assert_eq!(e.to_string(), "name already exists on this account");
    assert!(matches!(gh.repos(&tok).await, Err(Error::BadToken)));
}

#[test]
fn qr_codes() {
    let svg = qr_svg("https://github.com/login/device");
    assert!(svg.starts_with("<?xml") && svg.contains("<svg"));
}

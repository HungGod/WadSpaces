use super::*;
use serde_json::json;
use wiremock::matchers::{body_partial_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn server() -> (MockServer, Github) {
    let s = MockServer::start().await;
    let gh = Github::with_base(reqwest::Client::new(), &s.uri());
    (s, gh)
}

fn ok(body: serde_json::Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(body)
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
    assert_eq!(format!("{:?}", Token::new("good")), "Token(…)");
    assert_eq!(u.login, "octocat");
    assert_eq!(u.name.as_deref(), Some("Octo Cat"));
    assert!(matches!(gh.user(&Token::new("revoked")).await, Err(Error::BadToken)));
}

#[test]
fn errors_map_to_api_codes() {
    assert_eq!(ApiError::from(Error::Invalid("taken".into())).code, ErrorCode::BadRequest);
    assert_eq!(ApiError::from(Error::BadToken).code, ErrorCode::Unauthorized);
}

#[test]
fn reads_the_machine_config() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../host/usr/lib/wadspaces/github.toml");
    let app = AppConfig::load(path.as_ref()).unwrap();
    assert_eq!(app.scopes, ["repo", "workflow", "read:org", "write:packages", "user:email"]);
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
    let gh = Github::with_base(reqwest::Client::new(), &api);
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
    let gh = Github::with_base(reqwest::Client::new(), &api);
    let tok = Token::new("gho_x");
    let r = gh.create_repo(&tok, "notes", true, "").await.unwrap();
    assert_eq!(r.full_name, "HungGod/notes");
    let e = gh.create_repo(&tok, "taken", true, "").await.unwrap_err();
    assert_eq!(e.to_string(), "name already exists on this account");
    assert!(matches!(gh.repos(&tok).await, Err(Error::BadToken)));
}

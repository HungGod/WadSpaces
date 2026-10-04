use super::*;
use image::Rgba;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

/// A `side` px PNG: a black plus on transparency.
fn plus_png(side: u32) -> Vec<u8> {
    let img = RgbaImage::from_fn(side, side, |x, y| {
        let (a, b) = (side * 3 / 8, side * 5 / 8);
        if (a..b).contains(&x) || (a..b).contains(&y) { Rgba([0, 0, 0, 255]) } else { Rgba([0, 0, 0, 0]) }
    });
    png(&img)
}

fn page(head: &str) -> ResponseTemplate {
    ResponseTemplate::new(200)
        .insert_header("content-type", "text/html")
        .set_body_string(format!("<html><head>{head}</head><body>hi</body></html>"))
}

fn image_resp(bytes: Vec<u8>, kind: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).insert_header("content-type", kind).set_body_bytes(bytes)
}

fn decoded(icon: &Icon) -> RgbaImage {
    image::load_from_memory(&icon.png).unwrap().to_rgba8()
}

#[tokio::test]
async fn picks_the_biggest_picture() {
    let s = MockServer::start().await;
    Mock::given(path("/"))
        .respond_with(page(r#"<link rel=icon href=/s.png sizes=16x16><link rel=apple-touch-icon href=/big.png>"#))
        .mount(&s)
        .await;
    Mock::given(path("/s.png")).respond_with(image_resp(plus_png(16), "image/png")).mount(&s).await;
    Mock::given(path("/big.png")).respond_with(image_resp(plus_png(180), "image/png")).mount(&s).await;
    Mock::given(path("/favicon.ico")).respond_with(ResponseTemplate::new(404)).mount(&s).await;
    let r = Resolver::new(None).allow_local();
    let img = r.best_icon(&Url::parse(&s.uri()).unwrap()).await.unwrap();
    assert_eq!(img.dimensions(), (180, 180));
}

#[tokio::test]
async fn svg_comes_first() {
    let s = MockServer::start().await;
    let svg = r##"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>"##;
    Mock::given(path("/"))
        .respond_with(page(
            r#"<link rel=icon href=/big.png sizes=512x512><link rel=icon type="image/svg+xml" href=/i.svg>"#,
        ))
        .mount(&s)
        .await;
    Mock::given(path("/i.svg")).respond_with(image_resp(svg.into(), "image/svg+xml")).mount(&s).await;
    Mock::given(path("/big.png")).respond_with(image_resp(plus_png(512), "image/png")).expect(0).mount(&s).await;
    let r = Resolver::new(None).allow_local();
    let img = r.best_icon(&Url::parse(&s.uri()).unwrap()).await.unwrap();
    assert_eq!(img.dimensions(), (decode::SVG_PX, decode::SVG_PX));
}

#[tokio::test]
async fn a_broken_page_still_has_its_favicon() {
    let s = MockServer::start().await;
    Mock::given(path("/")).respond_with(ResponseTemplate::new(500)).mount(&s).await;
    Mock::given(path("/favicon.ico")).respond_with(image_resp(plus_png(32), "image/x-icon")).mount(&s).await;
    let r = Resolver::new(None).allow_local();
    let icon = r.site(&s.uri()).await;
    assert_eq!(icon.source, Source::Site);
    let img = decoded(&icon);
    assert_eq!(img.dimensions(), (style::SIZE, style::SIZE));
    assert_eq!(img.get_pixel(256, 256), &Rgba([0, 0, 0, 255]), "the plus, inked");
}

#[tokio::test]
async fn a_site_with_nothing_gets_a_text_card() {
    let s = MockServer::start().await;
    Mock::given(method("GET")).respond_with(ResponseTemplate::new(404)).mount(&s).await;
    let r = Resolver::new(None).allow_local();
    let icon = r.site(&s.uri()).await;
    assert_eq!(icon.source, Source::Fallback);
    // The black square with white letters in it.
    let img = decoded(&icon);
    assert_eq!(img.get_pixel(256, 60), &Rgba([0, 0, 0, 255]));
    assert!(img.pixels().any(|p| p == &Rgba([255, 255, 255, 255])));
}

#[tokio::test]
async fn hosts_on_this_network_are_never_asked() {
    let s = MockServer::start().await;
    Mock::given(method("GET")).respond_with(image_resp(plus_png(32), "image/png")).expect(0).mount(&s).await;
    let icon = Resolver::new(None).site(&s.uri()).await;
    assert_eq!(icon.source, Source::Fallback);
}

#[tokio::test]
async fn the_cache_saves_asking_again() {
    let s = MockServer::start().await;
    Mock::given(path("/")).respond_with(page("")).expect(1).mount(&s).await;
    Mock::given(path("/favicon.ico")).respond_with(image_resp(plus_png(32), "image/png")).expect(1).mount(&s).await;
    Mock::given(path("/apple-touch-icon.png")).respond_with(ResponseTemplate::new(404)).mount(&s).await;
    let tmp = tempfile::tempdir().unwrap();
    let first = Resolver::new(Some(Cache::new(tmp.path()))).allow_local().site(&s.uri()).await;
    let again = Resolver::new(Some(Cache::new(tmp.path()))).allow_local().site(&s.uri()).await;
    assert_eq!(first.source, Source::Site);
    assert_eq!(first.png, again.png);
}

#[tokio::test]
async fn the_users_picture_wins() {
    let b64 = base64::engine::general_purpose::STANDARD.encode(plus_png(64));
    let icon = Resolver::new(None).icon("https://example.invalid", Some(&format!("data:image/png;base64,{b64}"))).await;
    assert_eq!(icon.source, Source::Custom);
    let img = decoded(&icon);
    assert_eq!(img.dimensions(), (style::SIZE, style::SIZE));
    assert_eq!(img.get_pixel(0, 0)[3], 0, "no card: the picture as it is");
}

#[tokio::test]
async fn too_big_is_refused() {
    let s = MockServer::start().await;
    Mock::given(path("/huge.png")).respond_with(image_resp(vec![0u8; IMAGE_CAP + 1], "image/png")).mount(&s).await;
    let r = Resolver::new(None).allow_local();
    assert!(r.get(&Url::parse(&format!("{}/huge.png", s.uri())).unwrap(), IMAGE_CAP).await.is_none());
}

#[test]
fn data_urls() {
    assert_eq!(data_url("data:text/plain;base64,aGk=").unwrap(), b"hi");
    assert_eq!(data_url("data:image/svg+xml,%3Csvg%3E").unwrap(), b"<svg>");
    assert!(data_url("nope").is_none());
}

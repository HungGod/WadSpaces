//! Web apps' icons for WadSpaces images, made before the image builds.
//!
//! A web app's icon is its site's favicon as a black silhouette on a white
//! card ([`style::card`]), or a picture the user chose ([`style::plain`]), or,
//! when there's nothing to use (a site on this network, a site that won't
//! answer), a card with its host's name ([`style::text_card`]). wadd makes
//! them as Wad Creator designs (`fetch`), keeps them in a [`cache::Cache`],
//! and puts them in the build folder: the image itself fetches nothing.

pub mod cache;
pub mod decode;
pub mod html;
#[cfg(feature = "fetch")]
pub mod resolve;
pub mod style;
mod text;

#[cfg(feature = "fetch")]
pub use resolve::{Icon, Resolver, Source};

use image::RgbaImage;
use url::Url;

/// The icon as PNG bytes.
pub fn png(img: &RgbaImage) -> Vec<u8> {
    let mut out = std::io::Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Png).expect("PNG encoding to memory");
    out.into_inner()
}

/// The text card's label for `url`: its host, without "www.", with the port
/// when it isn't the scheme's own.
pub fn label_for(url: &str) -> String {
    let Ok(u) = Url::parse(url) else { return url.chars().take(40).collect() };
    let host = u.host_str().unwrap_or("?").trim_start_matches("www.");
    match u.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    }
}

/// Hosts the fetcher never asks: loopback, private and link-local addresses,
/// .local and localhost. From wadd they'd be the machine's own network, not
/// the workspace's, so they get a text card.
pub fn local_host(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => {
            let d = d.to_ascii_lowercase();
            d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") || !d.contains('.')
        }
        Some(url::Host::Ipv4(ip)) => {
            // 100.64/10 too: carrier NAT, and Tailscale's addresses.
            let [a, b, ..] = ip.octets();
            ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || (a == 100 && b & 0xc0 == 64)
        }
        Some(url::Host::Ipv6(ip)) => ip.is_loopback() || ip.is_unique_local() || ip.is_unicast_link_local(),
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(label_for("https://www.example.com/x"), "example.com");
        assert_eq!(label_for("http://localhost:8080/"), "localhost:8080");
        assert_eq!(label_for("https://claude.ai:443/"), "claude.ai");
        assert_eq!(label_for("http://192.168.1.4:3000"), "192.168.1.4:3000");
    }

    #[test]
    fn local_hosts() {
        let l = |s: &str| local_host(&Url::parse(s).unwrap());
        assert!(l("http://localhost:3000"));
        assert!(l("http://127.0.0.1/"));
        assert!(l("http://10.1.2.3/"));
        assert!(l("http://printer.local/"));
        assert!(l("http://intranet/"));
        assert!(l("http://[::1]/"));
        assert!(l("http://100.101.102.103/"));
        assert!(!l("https://github.com"));
        assert!(!l("https://8.8.8.8"));
    }
}

//! What's left of the old Builder's designs that the migration onto the
//! layers needs (layers.rs `migrate_wadspace_v1`): the site a desktop's web
//! icon opens.

use serde_json::Value;

use crate::js;
use crate::url;

/// The site a web icon opens: its own url, else the domain of its favicon URL.
pub(crate) fn site_of(icon: &Value) -> Option<String> {
    if let Some(u) = icon.get("url").filter(|u| js::truthy(u)) {
        return Some(js::string(u));
    }
    let icon_url = icon.get("iconUrl").map(js::string).unwrap_or_else(|| "undefined".into());
    if url::host(&icon_url, "local")? == "www.google.com" { url::query_param(&icon_url, "domain") } else { None }
}

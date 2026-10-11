//! The Builder's layer images on this machine, and wadspaces installed on
//! them.
//!
//! - `GET /v1/images`: each layer image here, from its labels (builds.rs
//!   puts them on): its build folder's sha and the id of the image it was
//!   built on. WadSpaces compares those with the layer as it is now to show
//!   Built, Changed since built, or Not built.
//! - `DELETE /v1/images/{layer}`: when a template or customization is deleted
//!   for good. Refused while a workspace here runs on it.
//! - `PUT /v1/wadspaces/{id}`: a wadspace (no image of its own) installed,
//!   or updated, as a workspace on its layer's image (wad-core's
//!   `workspace_for`): its name and wallpaper at run time, a /config of its
//!   own, its sign-ins, and the github_token secret when the machine has one.
//! - `PUT /v1/workspaces/{id}/wallpaper`: the wallpaper it's started with,
//!   kept in its extra folder (mounted at /run/wadspaces-extra).

use std::path::{Path, PathBuf};

use base64::Engine;
use serde::Deserialize;
use serde_json::{Value, json};
use wad_proto::v1::{ImageRow, WallpaperUpload, Workspace, WorkspaceSaved};
use wad_proto::{ApiError, ErrorCode};

use crate::backend::Backend;
use crate::builds::{Builds, FROM_LABEL, LAYER_LABEL, SHA_LABEL};
use crate::registry::Registry;

/// A wallpaper's size limit.
pub const MAX_WALLPAPER: usize = 16 << 20;

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::new(ErrorCode::BadRequest, msg)
}

fn internal(e: impl std::fmt::Display) -> ApiError {
    ApiError::new(ErrorCode::Internal, e.to_string())
}

/// "template:<id>" / "custom:<id>" with a valid id.
pub fn layer_ok(layer: &str) -> bool {
    matches!(layer.split_once(':'), Some(("template" | "custom", id)) if wad_core::spec::is_id(id))
}

/// The layer images here.
pub async fn list(backend: &dyn Backend) -> Result<Vec<ImageRow>, ApiError> {
    let found = backend.images_labelled(SHA_LABEL).await.map_err(internal)?;
    let mut rows: Vec<ImageRow> = found
        .into_iter()
        .filter_map(|i| {
            let layer = i.labels.get(LAYER_LABEL).and_then(Value::as_str).filter(|l| layer_ok(l))?.to_string();
            let image_ref = wad_core::layers::image_ref(&layer);
            // Only the image the layer's name points at (not an older build).
            i.tags.iter().any(|t| t == &image_ref).then(|| ImageRow {
                dockerfile_sha: i.labels.get(SHA_LABEL).and_then(Value::as_str).unwrap_or_default().into(),
                from: i.labels.get(FROM_LABEL).and_then(Value::as_str).unwrap_or_default().into(),
                layer,
                image_ref,
                id: i.id,
                built_at: i.created,
                size_mb: (i.size as f64 / 1_000_000.0).round(),
            })
        })
        .collect();
    rows.sort_by(|a, b| a.layer.cmp(&b.layer));
    Ok(rows)
}

/// Removes a layer's image; not while a workspace runs on it, or it builds.
pub async fn delete(registry: &Registry, builds: &Builds, backend: &dyn Backend, layer: &str) -> Result<(), ApiError> {
    if !layer_ok(layer) {
        return Err(bad(format!("{layer:?} isn't a layer")));
    }
    let image = wad_core::layers::image_ref(layer);
    let users: Vec<String> = registry.workspaces().into_iter().filter(|w| w.image == image).map(|w| w.name).collect();
    if !users.is_empty() {
        return Err(ApiError::new(ErrorCode::Conflict, format!("{} run on it; delete them first", users.join(", "))));
    }
    if builds.building(layer) {
        return Err(ApiError::new(ErrorCode::Conflict, "it's building"));
    }
    if !backend.remove_image(&image).await.map_err(internal)? {
        return Err(ApiError::new(ErrorCode::NotFound, format!("no image {image}")));
    }
    tracing::info!("removed the image {image}");
    Ok(())
}

/// PUT /v1/wadspaces/{id}: a wadspace and the layers it's on.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Install {
    pub wadspace: Value,
    pub template: Value,
    #[serde(default)]
    pub customization: Option<Value>,
    /// The time zone its clock shows (the client's).
    #[serde(default)]
    pub tz: Option<String>,
}

/// The workspace a wadspace installs as (wad-core), in workspaces.json's shape.
pub async fn workspace_of(backend: &dyn Backend, id: &str, req: &Install) -> Result<Value, ApiError> {
    let w = &req.wadspace;
    if w.get("id").and_then(Value::as_str) != Some(id) || !wad_core::spec::is_id(id) {
        return Err(bad(format!("{id:?}: the wadspace sent is another")));
    }
    if w.get("version").and_then(Value::as_u64) != Some(2) {
        return Err(bad("a wadspace from before the layers: WadSpaces moves it to them first"));
    }
    let setup = match &req.customization {
        Some(c) => {
            let base = &w["base"];
            if base["kind"] != "customization" || base["id"] != c["id"] || c["templateId"] != req.template["id"] {
                return Err(bad("the customization sent isn't this wadspace's"));
            }
            wad_core::layers::setup_of(c)
        }
        None => {
            if w["base"]["kind"] != "template" || w["base"]["id"] != req.template["id"] {
                return Err(bad("the template sent isn't this wadspace's"));
            }
            wad_core::layers::empty_setup(req.template["id"].as_str().unwrap_or_default())
        }
    };
    // Git's credentials, when the machine has them.
    let secrets: Vec<String> =
        backend.secret_names().await.unwrap_or_default().into_iter().filter(|n| n == "github_token").collect();
    let tz = req.tz.as_deref().filter(|t| !t.is_empty() && t.len() < 64 && !t.contains(char::is_control));
    let opts = json!({ "tz": tz.unwrap_or("Etc/UTC"), "secrets": secrets });
    Ok(wad_core::layers::workspace_for(w, &req.template, &setup, &opts))
}

/// Installs or updates it; whether it's running with the old settings.
pub async fn install(
    registry: &Registry,
    backend: &dyn Backend,
    id: &str,
    req: &Install,
) -> Result<WorkspaceSaved, ApiError> {
    let fresh = workspace_of(backend, id, req).await?;
    let (list, updated) = crate::builds::merged(&registry.workspaces(), &fresh).map_err(bad)?;
    let running = registry.state(id).is_some_and(|s| s.container == "running");
    registry.set_workspaces(list).await.map_err(internal)?;
    let workspace = registry.workspace(id)?;
    if !workspace.image.is_empty() && backend.image_exists(&workspace.image).await.unwrap_or(false) {
        registry.image_here(id);
    }
    Ok(WorkspaceSaved { workspace, restart_required: updated && running })
}

/// `<state_dir>/extra/<id>`: what's mounted in at /run/wadspaces-extra.
pub fn extra_dir(state_dir: &Path, id: &str) -> PathBuf {
    state_dir.join("extra").join(id)
}

/// Keeps a picture as the wadspace's wallpaper.
pub fn put_wallpaper(state_dir: &Path, ws: &Workspace, up: &WallpaperUpload) -> Result<String, ApiError> {
    if ws.kind != wad_proto::v1::Kind::Container {
        return Err(bad(format!("{} is an app: it has no wallpaper", ws.name)));
    }
    let bytes = decode_wallpaper(up)?;
    write_wallpaper(state_dir, &ws.id, &up.ext, &bytes).map_err(internal)
}

/// A wallpaper's picture: a png or a jpg, 16 MB at most.
pub fn decode_wallpaper(up: &WallpaperUpload) -> Result<Vec<u8>, ApiError> {
    let bytes =
        base64::engine::general_purpose::STANDARD.decode(&up.data).map_err(|e| bad(format!("wallpaper: {e}")))?;
    if bytes.len() > MAX_WALLPAPER {
        return Err(bad("the wallpaper is too big (16 MB max)"));
    }
    let ok = match up.ext.as_str() {
        "png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "jpg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        _ => return Err(bad("a wallpaper is a png or a jpg")),
    };
    if !ok {
        return Err(bad(format!("that isn't a {} picture", up.ext)));
    }
    Ok(bytes)
}

/// Writes it (and drops the other kind), readable inside.
pub fn write_wallpaper(state_dir: &Path, id: &str, ext: &str, bytes: &[u8]) -> std::io::Result<String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = extra_dir(state_dir, id);
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))?;
    let path = dir.join(format!("wallpaper.{ext}"));
    let tmp = dir.join(format!(".wallpaper.{ext}.tmp"));
    std::fs::write(&tmp, bytes)?;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o644))?;
    std::fs::rename(&tmp, &path)?;
    for other in ["png", "jpg"].iter().filter(|e| **e != ext) {
        let _ = std::fs::remove_file(dir.join(format!("wallpaper.{other}")));
    }
    crate::projects::relabel(&dir, false);
    Ok(path.to_string_lossy().into_owned())
}

/// Makes sure the extra folder is there (the unit mounts it).
pub fn ensure_extra(state_dir: &Path, id: &str) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let dir = extra_dir(state_dir, id);
    std::fs::create_dir_all(&dir)?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755))
}

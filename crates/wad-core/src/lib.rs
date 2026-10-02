//! WadSpaces' core logic, shared by wadd (native) and the UI (WebAssembly, via
//! wad-wasm): a Builder design → the build spec, the build folder's files
//! (Dockerfile, compose, quadlet, ...), projects, presets and the catalog.
//!
//! It replaces the TypeScript core (apps/wadcreator/src/core) and returns the
//! same results, byte for byte: fixtures/core/goldens.json holds what that
//! returned for a wide corpus, and the tests here check every case. Values are
//! JSON, as in the TypeScript, so objects keep their keys' order and absent
//! fields stay absent.
//!
//! [`call`] is the one entry point by name (the WebAssembly boundary uses it).

pub mod build;
pub mod generator;
pub mod icons;
pub mod js;
pub mod model;
pub mod presets;
pub mod projects;
pub mod recipes;
pub mod spec;
pub mod tar;
mod url;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};

/// `{"$bytes": base64}` → bytes.
fn bytes_of(v: &Value) -> Option<Vec<u8>> {
    v.get("$bytes").and_then(Value::as_str).and_then(|s| B64.decode(s).ok())
}

fn bytes_json(b: &[u8]) -> Value {
    json!({ "$bytes": B64.encode(b) })
}

fn files_json(files: Vec<(String, generator::Content)>) -> Value {
    Value::Array(
        files
            .into_iter()
            .map(|(path, c)| match c {
                generator::Content::Text(t) => json!({ "path": path, "content": t }),
                generator::Content::Bytes(b) => json!({ "path": path, "content": bytes_json(&b) }),
            })
            .collect(),
    )
}

/// Calls a core function by its TypeScript name with JSON arguments. Errors
/// are what the TypeScript threw (its message), or an unknown name.
pub fn call(name: &str, args: &[Value]) -> Result<Value, String> {
    let a = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let s = |i: usize| args.get(i).and_then(Value::as_str).unwrap_or("");
    let opt_s = |i: usize| args.get(i).and_then(Value::as_str);
    let list = |i: usize| args.get(i).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    Ok(match name {
        // model
        "defaultAdvanced" => model::default_advanced(opt_s(0).unwrap_or("Etc/UTC")),
        "newWadspaceId" => {
            let rand: Vec<f64> = list(1).iter().filter_map(Value::as_f64).collect();
            model::new_wadspace_id(s(0), &rand).into()
        }
        "dropFileIcons" => model::drop_file_icons(a(0)),
        "orderedIcons" => Value::Array(model::ordered_icons(a(0))),
        // spec
        "slugify" => spec::slugify(s(0)).into(),
        "newSpec" => spec::new_spec(a(0)),
        "resolveFeatures" => json!(spec::resolve_features(a(0))),
        "volumesFor" => json!(spec::volumes_for(a(0))),
        "toWaddSpec" => spec::to_wadd_spec(a(0)),
        "fromWaddSpec" => spec::from_wadd_spec(a(0), args.get(1)),
        "validate" => json!(spec::validate(a(0))),
        "baseImageFor" => spec::base_image_for(opt_s(0)).into(),
        "features" => json!(spec::FEATURES),
        // generator
        "dockerfile" => generator::dockerfile(a(0)).into(),
        "compose" => generator::compose(a(0)).into(),
        "readme" => generator::readme(a(0)).into(),
        "kaleResourcesJson" => generator::kale_resources_json(a(0)).into(),
        "layoutJson" => build::layout_json(a(0)).into(),
        "quadlet" => generator::quadlet(
            a(0),
            opt_s(1).unwrap_or(generator::PROJECTS_DIR),
            opt_s(2).unwrap_or(generator::STATE_DIR),
            args.get(3).and_then(Value::as_u64).map(|u| u as u32),
        )
        .into(),
        "workspacesYamlSnippet" => generator::workspaces_yaml_snippet(a(0)).into(),
        "bundleFiles" => {
            let wallpaper = args.get(1).and_then(bytes_of);
            files_json(generator::bundle_files(a(0), wallpaper.as_deref(), opt_s(2)))
        }
        // build
        "toBuildSpec" => build::to_build_spec(a(0), a(1)),
        "kaleDesktop" => build::kale_desktop(s(0)).into(),
        // catalog
        "recipeFor" => recipes::recipe_for(s(0), opt_s(1)).to_json(),
        "localIcon" => icons::local_icon(s(0)).into(),
        // presets
        "presetWadspace" => presets::preset_wadspace(s(0)).unwrap_or(Value::Null),
        "presetProjects" => presets::preset_projects(s(0)),
        "presets" => Value::Array(presets::presets().to_vec()),
        // projects
        "validateProject" => json!(projects::validate_project(a(0))),
        "cleanDraft" => projects::clean_draft(a(0)),
        "cleanSource" => projects::clean_source(a(0)),
        "sourceLabel" => projects::source_label(a(0)),
        "sourcePath" => projects::source_path(a(0)),
        "repoName" => projects::repo_name(s(0)).into(),
        "githubUrl" => projects::github_url(s(0)).map(Value::from).unwrap_or(Value::Null),
        "repoFullName" => projects::repo_full_name(s(0)).into(),
        "sameRepo" => projects::same_repo(s(0), s(1)).into(),
        "toMountName" => projects::to_mount_name(s(0)).into(),
        "freeMountName" => projects::free_mount_name(list(0), s(1)).into(),
        "baseName" => projects::base_name(s(0)).into(),
        "repoToDraft" => projects::repo_to_draft(a(0)),
        "toProjectDoc" => projects::to_project_doc(s(0), a(1)),
        "reposToProjects" => Value::Array(projects::repos_to_projects(list(0))),
        "projectForRepo" => projects::project_for_repo(list(0), a(1)).cloned().unwrap_or(Value::Null),
        "findProject" => projects::find_project(list(0), a(1)).cloned().unwrap_or(Value::Null),
        // the patterns firestore.rules and the UI's inputs use
        "isGithubUrl" => projects::is_github_url(s(0)).into(),
        "isMount" => projects::is_mount(s(0)).into(),
        "isProjectId" => projects::is_project_id(s(0)).into(),
        "isDriveUuid" => projects::is_drive_uuid(s(0)).into(),
        "isRepoName" => projects::is_repo_name(s(0)).into(),
        "isId" => spec::is_id(s(0)).into(),
        // tar
        "tar" => {
            let owned: Vec<(String, Vec<u8>)> = list(0)
                .iter()
                .map(|e| {
                    let path = e.get("path").and_then(Value::as_str).unwrap_or("").to_string();
                    let content = match e.get("content") {
                        Some(Value::String(t)) => t.as_bytes().to_vec(),
                        Some(b) => bytes_of(b).unwrap_or_default(),
                        None => vec![],
                    };
                    (path, content)
                })
                .collect();
            let entries: Vec<tar::Entry> = owned.iter().map(|(p, c)| tar::Entry { path: p, content: c }).collect();
            bytes_json(&tar::tar(&entries)?)
        }
        _ => return Err(format!("no core function {name}")),
    })
}

#[cfg(test)]
mod goldens;

//! The types wadd and WadSpaces Client share: wadd's `/v1` API over its socket,
//! and the Tauri commands the UI calls. Everything here derives
//! `specta::Type`, so the UI's TypeScript types are generated from it
//! (`apps/client/src/gen/bindings.ts`). JSON is camelCase.

pub mod error;
pub mod github;
pub mod v1;

pub use error::{ApiError, ErrorCode};

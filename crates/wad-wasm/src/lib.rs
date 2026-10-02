//! wad-core for the UI: one function, [`call`], taking a core function's
//! TypeScript name and its arguments as JSON, returning its result as JSON.
//! The UI's wrapper (apps/wadcreator/src/core/wasm.ts) gives each function
//! its old name and types back.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn call(name: &str, args: &str) -> Result<String, JsError> {
    let args: Vec<serde_json::Value> =
        serde_json::from_str(args).map_err(|e| JsError::new(&format!("bad arguments for {name}: {e}")))?;
    let out = wad_core::call(name, &args).map_err(|e| JsError::new(&e))?;
    Ok(serde_json::to_string(&out).expect("JSON values serialize"))
}

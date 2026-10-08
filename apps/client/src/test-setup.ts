// Before any test: load the core (crates/wad-core as WebAssembly, src/gen/wasm).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initCoreSync } from "./core/wasm";

initCoreSync(readFileSync(fileURLToPath(new URL("./gen/wasm/wad_wasm_bg.wasm", import.meta.url))));

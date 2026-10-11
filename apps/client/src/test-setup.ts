// Before any test: load the core (crates/wad-core as WebAssembly, src/gen/wasm).
// Found from the project root: under jsdom, import.meta.url isn't a file: URL.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initCoreSync } from "./core/wasm";

initCoreSync(readFileSync(resolve(process.cwd(), "src/gen/wasm/wad_wasm_bg.wasm")));

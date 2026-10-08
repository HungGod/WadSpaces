// Catalog icons ship with the app (public/catalog, scripts/fetch-catalog-icons.mjs).
// Layouts saved before that point at Google's favicon service; show the
// bundled copy instead so icons work with no internet. wad-core's
// crates/wad-core/src/icons.rs, run as WebAssembly.
import { call } from "../wasm";

export function localIcon(url: string): string {
  return call("localIcon", url);
}

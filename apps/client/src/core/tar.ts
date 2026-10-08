// A ustar archive of the build folder: what wadd builds from. wad-core's
// crates/wad-core/src/tar.rs, run as WebAssembly: entries in UTF-8 byte order
// with their parent directories, mtime 0, so a folder always gives the same bytes.
import { call } from "./wasm";

export interface TarEntry {
  path: string;
  content: string | Uint8Array;
}

/** Files (paths relative to the folder) as a tar, with parent directories. */
export function tar(entries: TarEntry[]): Uint8Array {
  return call("tar", entries);
}

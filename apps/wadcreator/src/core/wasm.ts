// The core runs as WebAssembly: crates/wad-core, built by `cargo xtask wasm`
// into src/gen/wasm/. Each module here keeps its old names and types and
// calls into it with `call`. initCore() must finish before the first call
// (main.tsx waits for it; vitest's setup loads it synchronously).
//
// Arguments and results cross as JSON: undefined object fields are dropped
// (as Firestore and JSON drop them), Uint8Array travels as {"$bytes": base64}.
import init, { call as rawCall, initSync } from "@/gen/wasm/wad_wasm";

let ready = false;

/** Loads the core: the .wasm next to the app's bundle. */
export async function initCore(): Promise<void> {
  if (ready) return;
  const { default: url } = await import("@/gen/wasm/wad_wasm_bg.wasm?url");
  await init({ module_or_path: url });
  ready = true;
}

/** Loads the core from its bytes (tests, Node). */
export function initCoreSync(bytes: BufferSource): void {
  if (ready) return;
  initSync({ module: bytes });
  ready = true;
}

function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Calls a wad-core function by name (crates/wad-core/src/lib.rs `call`). */
export function call<T>(name: string, ...args: unknown[]): T {
  if (!ready) throw new Error("the core isn't loaded yet (initCore)");
  const json = JSON.stringify(args, (_k, v) => (v instanceof Uint8Array ? { $bytes: toBase64(v) } : v));
  return JSON.parse(rawCall(name, json), (_k, v) =>
    v && typeof v === "object" && typeof v.$bytes === "string" && Object.keys(v).length === 1 ? fromBase64(v.$bytes) : v,
  ) as T;
}

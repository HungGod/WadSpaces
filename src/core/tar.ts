// A ustar archive of the build folder: what wadd builds from.
// Plain TypeScript over Uint8Array, so it runs in the browser and in Functions.

export interface TarEntry {
  path: string;
  content: string | Uint8Array;
}

const enc = new TextEncoder();

function header(name: string, size: number, type: "0" | "5"): Uint8Array {
  const h = new Uint8Array(512);
  let prefix = "";
  let base = name;
  if (enc.encode(name).length > 100) {
    const cut = name.lastIndexOf("/", 155);
    prefix = name.slice(0, cut);
    base = name.slice(cut + 1);
    if (cut < 0 || enc.encode(base).length > 100 || enc.encode(prefix).length > 155) throw new Error(`path too long for a build folder: ${name}`);
  }
  const put = (s: string, at: number) => h.set(enc.encode(s), at);
  const oct = (n: number, len: number) => n.toString(8).padStart(len - 1, "0") + "\0";
  put(base, 0);
  put(type === "5" ? "0000755\0" : "0000644\0", 100);
  put("0000000\0", 108);
  put("0000000\0", 116);
  put(oct(size, 12), 124);
  put(oct(0, 12), 136); // mtime 0: the same folder gives the same bytes (and build cache hits)
  put("        ", 148);
  put(type, 156);
  put("ustar\0", 257);
  put("00", 263);
  put(prefix, 345);
  const sum = h.reduce((a, b) => a + b, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

/** Files (paths relative to the folder) as a tar, with parent directories. */
export function tar(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = [];
  const dirs = new Set<string>();
  for (const e of [...entries].sort((a, b) => a.path.localeCompare(b.path))) {
    if (e.path.startsWith("/") || e.path.split("/").includes("..")) throw new Error(`bad path in build folder: ${e.path}`);
    const segs = e.path.split("/");
    for (let i = 1; i < segs.length; i++) {
      const d = `${segs.slice(0, i).join("/")}/`;
      if (!dirs.has(d)) {
        dirs.add(d);
        parts.push(header(d, 0, "5"));
      }
    }
    const data = typeof e.content === "string" ? enc.encode(e.content) : e.content;
    parts.push(header(e.path, data.length, "0"), data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) parts.push(new Uint8Array(pad));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

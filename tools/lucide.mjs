// Writes the lucide icons the WadSpaces Client uses as plain SVGs
// (assets/lucide/<name>.svg, stroke in currentColor), for the native app:
//   node tools/lucide.mjs
// Reads the names imported from lucide-react anywhere in apps/client/src,
// resolves them (aliases too) with lucide-react's own export map, and takes
// each icon's drawing from its module. Run again when the client uses more.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const client = join(root, "apps/client");
const lucide = join(client, "node_modules/lucide-react");
const out = join(root, "assets/lucide");

const files = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? files(join(d, f)) : /\.tsx?$/.test(f) ? [join(d, f)] : []));
const names = new Set();
for (const f of files(join(client, "src"))) {
  for (const m of readFileSync(f, "utf8").matchAll(/import\s*\{([^}]*)\}\s*from\s*"lucide-react"/g)) {
    for (const n of m[1].split(",")) {
      const name = n.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0];
      if (/^[A-Z]/.test(name) && name !== "LucideIcon" && name !== "LucideProps") names.add(name);
    }
  }
}
// Some the native app draws that the client gets elsewhere.
for (const n of ["ChevronDown", "Search", "Settings"]) names.add(n);

const map = new Map();
for (const m of readFileSync(join(lucide, "dist/esm/lucide-react.mjs"), "utf8").matchAll(/export \{([^}]*)\} from '\.\/icons\/([^']+)\.mjs'/g)) {
  for (const part of m[1].split(",")) {
    const alias = part.trim().split(/\s+as\s+/)[1];
    if (alias) map.set(alias, m[2]);
  }
}

mkdirSync(out, { recursive: true });
const attrs = (o) => Object.entries(o).filter(([k]) => k !== "key").map(([k, v]) => `${k}="${v}"`).join(" ");
const written = [];
for (const name of [...names].sort()) {
  const file = map.get(name);
  if (!file) throw new Error(`lucide-react has no ${name}`);
  const { __iconData } = await import(pathToFileURL(join(lucide, "dist/esm/icons", `${file}.mjs`)).href);
  const body = __iconData.node.map(([tag, a]) => `<${tag} ${attrs(a)}/>`).join("");
  writeFileSync(join(out, `${file}.svg`), `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>\n`);
  written.push(`${name} ${file}`);
}
const version = JSON.parse(readFileSync(join(lucide, "package.json"), "utf8")).version;
writeFileSync(join(out, "NAMES"), `# lucide-react ${version} (ISC license): React name, file\n${written.join("\n")}\n`);
console.log(`wrote ${written.length} icons to assets/lucide`);

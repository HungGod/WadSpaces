// Writes the lucide icons the WadSpaces Client (and the HUD) draw as plain
// SVGs (assets/lucide/<name>.svg, stroke in currentColor), from lucide-react
// as the web app has it (its repo beside this one: WADSPACES_CLIENT_DIR,
// default ../wadspaces-client, after npm install):
//   node tools/lucide.mjs [Name ...]
// Takes the icons already listed in assets/lucide/NAMES and the React names
// given, resolves them (aliases too) with lucide-react's own export map, and
// takes each icon's drawing from its module. Run it with a new icon's name
// when the client wants one.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = process.env.WADSPACES_CLIENT_DIR ?? join(root, "../wadspaces-client");
const lucide = join(web, "node_modules/lucide-react");
const out = join(root, "assets/lucide");

const names = new Set(process.argv.slice(2));
const listed = join(out, "NAMES");
if (existsSync(listed)) {
  for (const line of readFileSync(listed, "utf8").split("\n")) if (line && !line.startsWith("#")) names.add(line.split(" ")[0]);
}

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

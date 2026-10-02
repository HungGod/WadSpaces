// Generators for a workspace bundle: wad-core's crates/wad-core/src/generator.rs,
// run as WebAssembly. The output has the same shape as the hand-written
// Wadspaces-David/<dir>/ directories:
//
//   Dockerfile  docker-compose.yml  README.md  wad-<id>.container  workspaces.yaml.snippet
//   root/etc/wadspaces/layout.json                  (Builder desktops: icons in order)
//   root/etc/wadspaces/kalebrowser-resources.json   (Kale Browser apps only)
//   root/usr/share/backgrounds/wallpaper.<ext>      (when a wallpaper is set)
//
// and builds with `Wadspaces-David/build.sh --only <id>` after copying it into
// Wadspaces-David/<id>/, or through wadd on the machine. Project files are
// never in it: wadd mounts the project folders when it launches the wadspace.
import type { CreatorSpec, WaddSpec } from "../spec";
import { call } from "../wasm";

export function dockerfile(spec: CreatorSpec): string {
  return call("dockerfile", spec);
}

export function kaleResourcesJson(spec: CreatorSpec): string {
  return call("kaleResourcesJson", spec);
}

/** docker-compose.yml, for running it by hand. A native (display: host)
 *  workspace runs remotely as two containers: the workspace and the stream
 *  sidecar it draws on. A streamed one is a single all-in-one Selkies container. */
export function compose(spec: CreatorSpec): string {
  return call("compose", spec);
}

// Where wadd keeps project folders and each workspace's projects.json
// (wadd/config.py DaemonConfig.projects_dir and state_dir).
export const PROJECTS_DIR = "/var/lib/wadspaces-projects";
export const STATE_DIR = "/var/lib/wadspaces";

/** Byte-identical to legacy/wadd-py/wadd/quadlet.py render_container_unit(). */
export function quadlet(w: WaddSpec, projectsDir = PROJECTS_DIR, stateDir = STATE_DIR): string {
  return call("quadlet", w, projectsDir, stateDir);
}

export function workspacesYamlSnippet(w: WaddSpec): string {
  return call("workspacesYamlSnippet", w);
}

export function readme(spec: CreatorSpec): string {
  return call("readme", spec);
}

export interface BundleFile {
  path: string;
  content: string | Uint8Array;
}

/** The build folder. `dockerfileText` replaces the generated Dockerfile (a hand edit). */
export function bundleFiles(spec: CreatorSpec, wallpaper?: Uint8Array, dockerfileText?: string): BundleFile[] {
  return call("bundleFiles", spec, wallpaper ?? null, dockerfileText ?? null);
}

export async function bundleZip(spec: CreatorSpec, wallpaper?: Uint8Array, dockerfileText?: string): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const dir = zip.folder(spec.id)!;
  for (const f of bundleFiles(spec, wallpaper, dockerfileText)) dir.file(f.path, f.content);
  return zip.generateAsync({ type: "blob" });
}

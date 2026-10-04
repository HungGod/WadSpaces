// Generators for a workspace bundle: wad-core's crates/wad-core/src/generator.rs,
// run as WebAssembly. The output (a build folder) is:
//
//   Dockerfile  docker-compose.yml  README.md  wad-<id>.container  workspaces.yaml.snippet
//   root/etc/wadspaces/layout.json                  (Builder desktops: icons in order)
//   root/etc/wadspaces/wadbrowser.conf              (a WadBrowser on the desktop: what links open in)
//   root/usr/share/backgrounds/wallpaper.<ext>      (when a wallpaper is set)
//   root/usr/share/icons/hicolor/512x512/apps/wadspaces-webapp-<id>.png   (web apps' icons: wadd makes them)
//
// and builds through wadd on the machine, or with `podman build` in it on the
// base image (images/build.sh in the monorepo). Project files are
// never in it: wadd mounts the project folders when it launches the wadspace.
import type { CreatorSpec, WaddSpec } from "../spec";
import { call } from "../wasm";

export function dockerfile(spec: CreatorSpec): string {
  return call("dockerfile", spec);
}

/** /etc/wadspaces/wadbrowser.conf, when the desktop has a WadBrowser (null otherwise). */
export function wadbrowserConf(spec: CreatorSpec): string | null {
  return call("wadbrowserConf", spec);
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

/** Byte-identical to wadd's units (fixtures/quadlet). */
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

/** The build folder. `dockerfileText` replaces the generated Dockerfile (a
 *  hand edit); `icons`: web apps' icons (PNG) by app id. A folder made here
 *  for download has none: the image's helper writes a card with the site's
 *  name instead. */
export function bundleFiles(
  spec: CreatorSpec,
  wallpaper?: Uint8Array,
  dockerfileText?: string,
  icons?: Record<string, Uint8Array>,
): BundleFile[] {
  return call("bundleFiles", spec, wallpaper ?? null, dockerfileText ?? null, icons ?? null);
}

export async function bundleZip(spec: CreatorSpec, wallpaper?: Uint8Array, dockerfileText?: string): Promise<Blob> {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  const dir = zip.folder(spec.id)!;
  for (const f of bundleFiles(spec, wallpaper, dockerfileText)) dir.file(f.path, f.content);
  return zip.generateAsync({ type: "blob" });
}

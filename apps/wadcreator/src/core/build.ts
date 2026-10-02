// A Builder wadspace (model.ts) → what the generator needs (spec.ts): wad-core's
// crates/wad-core/src/build.rs, run as WebAssembly.
//
// Desktop icons become, in order, entries of /etc/wadspaces/layout.json, and
// each app is installed the way its catalog recipe says. Apps that can't be
// installed yet are reported in `skipped` so the UI can say so.
import type { WadspaceSpec } from "./model";
import type { Project } from "./projects";
import type { CreatorSpec } from "./spec";
import { call } from "./wasm";

export interface BuildOptions {
  /** Image name prefix, e.g. localhost/wadspaces- (offline builds). */
  imagePrefix?: string;
  /** Full image reference; wins over the prefix and the wadspace's own. */
  image?: string;
  /** Base image reference; defaults to the local base for the display kind. */
  baseImage?: string;
  /** The rendered wallpaper's file name in root/usr/share/backgrounds/. */
  wallpaperFile?: string;
  /** The user's projects, to name the default ones (unknown ids are left out). */
  projects?: Project[];
}

export interface BuildPlan {
  spec: CreatorSpec;
  skipped: { label: string; reason: string }[];
}

/** The launcher KaleBrowser's packager writes for an app: WADspaces-<slug>.desktop (packager.py slugify). */
export function kaleDesktop(appName: string): string {
  return call("kaleDesktop", appName);
}

export function toBuildSpec(ws: WadspaceSpec, opts: BuildOptions = {}): BuildPlan {
  return call("toBuildSpec", ws, opts);
}

/** /etc/wadspaces/layout.json: the desktop, in order. */
export function layoutJson(spec: CreatorSpec): string {
  return call("layoutJson", spec);
}

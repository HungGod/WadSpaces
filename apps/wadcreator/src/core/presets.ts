// The six hand-written workspaces in Wadspaces-David, as generator specs and as
// Builder wadspaces: wad-core's crates/wad-core/src/presets.rs, run as
// WebAssembly. Used when a workspace on the machine has no library copy yet.
//
// Their repos are default projects. Project ids belong to each user, so a
// preset carries drafts (presetProjects); the data layer finds or creates the
// user's matching projects and puts their ids in advanced.projects.
import type { WadspaceSpec } from "./model";
import type { ProjectDraft } from "./projects";
import type { CreatorSpec } from "./spec";
import { call } from "./wasm";

/** The presets, as generator specs. */
export function presets(): CreatorSpec[] {
  return call("presets");
}

export const preset = (id: string) => presets().find((p) => p.id === id);

/** Each preset's default projects. Writing's folder must stay "Writing": the
 *  image's init-writing-vault looks for ~/Desktop/Writing. */
export const presetProjects = (id: string): ProjectDraft[] => call("presetProjects", id);

/** A preset as a Builder wadspace: its real desktop plus its build and run
 *  settings. advanced.projects is empty: the data layer fills it in from
 *  presetProjects(). */
export function presetWadspace(id: string): WadspaceSpec | undefined {
  return call<WadspaceSpec | null>("presetWadspace", id) ?? undefined;
}

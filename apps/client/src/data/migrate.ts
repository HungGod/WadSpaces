// Moving a library to stacks, the first time it's loaded since:
//
//   - its Extensions layers, kept as "customizations" before the layer had
//     that name, move to the `extensions` collection (same ids, so images
//     built for them stay theirs);
//   - each version 2 wadspace becomes a stack (wad-core's migrateV2): its base
//     its template (and Extensions), its own fields its customization, its
//     projects its own (GitHub ones cloned in, folder and drive ones copied
//     in once), its web apps' secrets WadBrowser key groups. They go on the
//     board after the stacks already there, oldest first.
//
// Pure: what to write. The store writes it through the backend, and runs it
// again on the next load if a write failed (it only ever finds what's left).
import { migrateV2, type Extensions, type Template, type Wadspace, type WadspaceV2 } from "@core/layers";
import type { Project } from "@core/projects";

/** A wadspace document as it's stored: a stack, or one from before. */
export type StoredWadspace = Wadspace | WadspaceV2;

export interface Migration {
  /** Extensions layers to save in `extensions`. */
  extensions: Extensions[];
  /** Old `customizations` documents to delete once they're moved. */
  dropCustomizations: string[];
  /** Stacks to save over the version 2 documents (same ids). */
  wadspaces: Wadspace[];
}

/** What moving this library to stacks writes; null when there's nothing to move. */
export function migration(docs: { templates: Template[]; customizations: Extensions[]; extensions: Extensions[]; wadspaces: StoredWadspace[]; projects: Project[] }): Migration | null {
  const old = docs.wadspaces.filter((w): w is WadspaceV2 => w.version === 2);
  if (!old.length && !docs.customizations.length) return null;
  // An Extensions layer moved already (a write after it failed) isn't moved twice.
  const extensions = docs.customizations.filter((c) => !docs.extensions.some((e) => e.id === c.id));
  const lib = { templates: docs.templates, customizations: [...docs.extensions, ...docs.customizations] };
  let order = Math.max(0, ...docs.wadspaces.filter((w): w is Wadspace => w.version === 3).map((w) => w.order ?? 0));
  const wadspaces = [...old]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((w) => ({ ...migrateV2(w, lib, docs.projects), order: ++order }) as Wadspace);
  return { extensions, dropCustomizations: docs.customizations.map((c) => c.id), wadspaces };
}

/** The library as it is once moved (what's shown even if a write fails). */
export function applied(wadspaces: StoredWadspace[], extensions: Extensions[], m: Migration): { wadspaces: Wadspace[]; extensions: Extensions[] } {
  const moved = new Map(m.wadspaces.map((w) => [w.id, w]));
  return {
    wadspaces: wadspaces.map((w) => moved.get(w.id) ?? (w as Wadspace)).filter((w) => w.version === 3),
    extensions: [...extensions, ...m.extensions],
  };
}

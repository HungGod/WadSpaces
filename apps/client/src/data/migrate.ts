// Moving a library from before the Builder's layers onto them, once per
// backend on the first load after the upgrade (in the background, like
// migrateRepos). Each wadspace from before (a library design, an account
// design, a preset on the machine, or a workspace installed by hand) becomes,
// through wad-core's migrateWadspaceV1:
//
//   - a template (one with the same apps is reused), a customization when
//     anything differs from it, and a version 2 wadspace with the same id;
//   - installed again on a machine that has it, running its old image
//     (`legacyImage`) until its layers are built;
//   - a one-time notice for what couldn't come across.
//
// Drafts are discarded (the Builder has none now), and a throwaway copy of an
// old Quick Launch template (one with a templateId) is deleted softly, so it
// can still be restored. Running it again changes nothing: a wadspace with a
// version 2 document isn't migrated twice.
import { migrateWadspaceV1, type Customization, type Template, type WadspaceV2 } from "@core/layers";
import type { Wadspace } from "@/lib/types";
import type { Backend, LayerLibrary } from "./backend";

export interface MigrationResult {
  /** Wadspaces moved onto the layers. */
  migrated: string[];
  /** What couldn't come across, to tell once. */
  notices: string[];
  /** Drafts discarded. */
  drafts: number;
}

/** The image a wadspace from before is installed with here, if it is. */
function legacyImageOf(w: Wadspace): string | null {
  if (!w.installed) return null;
  return w.advanced?.image || `localhost/wadspaces-${w.id}:latest`;
}

/** Moves what `backend` has from before onto the layers. `owner`: the user's
 *  key in documents (the uid online, "local" offline). */
export async function migrateToLayers(backend: Backend, owner: string, now = new Date().toISOString()): Promise<MigrationResult> {
  const [old, v2, templates, customizations, browsers, signins, projects] = await Promise.all([
    backend.listOldWadspaces(),
    backend.listWadspaces(),
    backend.listTemplates(),
    backend.listCustomizations(),
    backend.listBrowsers(),
    backend.caps.signins || backend.target === "online" ? backend.listSignIns().catch(() => []) : Promise.resolve([]),
    backend.caps.projects ? backend.listProjects().catch(() => []) : Promise.resolve([]),
  ]);
  const lib: LayerLibrary = { templates: [...templates], customizations: [...customizations], wadspaces: [...v2], browsers };
  const done = new Set(v2.map((w) => w.id));
  const result: MigrationResult = { migrated: [], notices: [], drafts: 0 };
  // The machine's own apps (the terminal, WadBrowser) aren't wadspaces.
  for (const w of old.filter((x) => !x.app && !done.has(x.id) && !x.machineOnly)) {
    const m = migrateWadspaceV1(w, lib, {
      owner,
      now,
      signins: signins.map((s) => ({ id: s.id, name: s.name, app: s.app })),
      legacyImage: legacyImageOf(w),
      projects: projects.map((p) => p.id),
    });
    if (m.newTemplate) {
      const t: Template = await backend.saveTemplate(m.template);
      lib.templates.push(t);
    }
    if (m.customization) {
      const c: Customization = await backend.saveCustomization(m.customization);
      lib.customizations.push(c);
    }
    let wadspace: WadspaceV2 = m.wadspace;
    // A throwaway copy of an old Quick Launch template: deleted, softly.
    if (w.templateId) wadspace = { ...wadspace, deletedAt: now };
    else if (w.deletedAt) wadspace = { ...wadspace, deletedAt: w.deletedAt };
    lib.wadspaces.push(wadspace);
    await backend.saveWadspace(wadspace, lib);
    result.migrated.push(w.id);
    if (m.notice) result.notices.push(m.notice);
  }
  result.drafts = await discardDrafts(backend);
  return result;
}

/** Drafts are gone from the Builder: each one deleted, and the app's own copy. */
export async function discardDrafts(backend: Backend): Promise<number> {
  const n = await backend.discardDrafts().catch(() => 0);
  try {
    // Named for the WadSpaces Client's old name, and kept until now.
    localStorage.removeItem("wadcreator.drafts.v1");
  } catch {
    // No storage: nothing kept there.
  }
  return n;
}

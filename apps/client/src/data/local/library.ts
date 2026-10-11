// The library from before the Builder's layers on this machine: designs (in
// wadd's `wadspaces` collection, beside the version 2 documents, which this
// leaves out), read so data/migrate.ts can move them onto the layers. A
// wadd with a library keeps them under /var/lib/wadspaces/library (and
// removes its drafts itself); an older one left them, and drafts, in the
// app's own storage: the designs move into wadd the first time it has a
// library, the drafts are only there to be discarded.
import { dropFileIcons } from "@core/model";
import type { Draft } from "@/lib/types";
import { wadd } from "@/lib/wadd";
import { drafts as legacyDrafts, library as legacyLibrary, type LibraryEntry } from "./store";

export type { LibraryEntry } from "./store";

export class LocalLibrary {
  private wadspaces: Record<string, LibraryEntry> = {};
  private draftMap: Record<string, Draft> = {};
  inWadd = false;

  async load(inWadd: boolean): Promise<void> {
    this.inWadd = inWadd;
    const keep = (ws: LibraryEntry[], dr: Draft[]) => {
      this.wadspaces = Object.fromEntries(ws.filter((e) => e?.spec?.id).map((e) => [e.spec.id, { ...e, spec: { ...e.spec, layout: dropFileIcons(e.spec.layout) } }]));
      this.draftMap = Object.fromEntries(dr.filter((d) => d?.id).map((d) => [d.id, d]));
    };
    if (!inWadd) return keep(Object.values(legacyLibrary.all()), Object.values(legacyDrafts.all()));
    keep(await wadd.library<LibraryEntry>("wadspaces"), Object.values(legacyDrafts.all()));
    // Move what an older app version kept in its own storage.
    for (const e of Object.values(legacyLibrary.all())) {
      if (!this.wadspaces[e.spec.id]) await this.put(e);
      legacyLibrary.remove(e.spec.id);
    }
  }

  entries(): LibraryEntry[] {
    return Object.values(this.wadspaces);
  }

  get(id: string): LibraryEntry | undefined {
    return this.wadspaces[id];
  }

  async put(e: LibraryEntry): Promise<void> {
    if (this.inWadd) await wadd.libraryPut("wadspaces", e.spec.id, e);
    else legacyLibrary.put(e);
    this.wadspaces[e.spec.id] = e;
  }

  drafts(): Draft[] {
    return Object.values(this.draftMap);
  }

  /** Drafts from the app's own storage, discarded. */
  removeDraft(id: string) {
    legacyDrafts.remove(id);
    delete this.draftMap[id];
  }
}

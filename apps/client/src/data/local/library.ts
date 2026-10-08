// The Builder's library and drafts on this machine. A wadd with a library
// (/api/library) keeps them under /var/lib/wadspaces/library, which survives
// app updates and reinstalls; an older wadd leaves them in the app's own
// storage. The first time a wadd with a library is seen, anything in the app's
// storage moves into it.
import { dropFileIcons } from "@core/model";
import type { Draft } from "@/lib/types";
import { wadd } from "@/lib/wadd";
import { migrateDraft } from "../backend";
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
      this.draftMap = Object.fromEntries(dr.filter((d) => d?.id).map((d) => [d.id, migrateDraft(d)]));
    };
    if (!inWadd) return keep(Object.values(legacyLibrary.all()), Object.values(legacyDrafts.all()));
    const [ws, dr] = await Promise.all([wadd.library<LibraryEntry>("wadspaces"), wadd.library<Draft>("drafts")]);
    keep(ws, dr);
    // Move what an older app version kept in its own storage.
    for (const e of Object.values(legacyLibrary.all())) {
      if (!this.wadspaces[e.spec.id]) await this.put(e);
      legacyLibrary.remove(e.spec.id);
    }
    for (const d of Object.values(legacyDrafts.all())) {
      if (!this.draftMap[d.id]) await this.putDraft(d);
      legacyDrafts.remove(d.id);
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

  async remove(id: string): Promise<void> {
    if (!this.wadspaces[id]) return;
    if (this.inWadd) await wadd.libraryDelete("wadspaces", id).catch(() => {});
    else legacyLibrary.remove(id);
    delete this.wadspaces[id];
  }

  drafts(): Draft[] {
    return Object.values(this.draftMap);
  }

  draft(id: string): Draft | undefined {
    return this.draftMap[id];
  }

  async putDraft(d: Draft): Promise<void> {
    if (this.inWadd) await wadd.libraryPut("drafts", d.id, d);
    else legacyDrafts.put(d);
    this.draftMap[d.id] = d;
  }

  async removeDraft(id: string): Promise<void> {
    if (this.inWadd) await wadd.libraryDelete("drafts", id).catch(() => {});
    else legacyDrafts.remove(id);
    delete this.draftMap[id];
  }
}

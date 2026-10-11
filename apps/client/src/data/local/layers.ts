// The Builder's layers on this machine, through wadd: the documents in its
// library (/v1/library: templates, customizations, wadspaces with version 2,
// browsers, and `meta` for the starter templates' flag), and what's done
// with them here: a wadspace installed on its layer's image with its
// wallpaper, layer images built and listed, the launcher's pick launched.
//
// The offline backend uses all of it; the machine app only the machine half
// (its documents are the account's).
import { STARTERS } from "@core/catalog/catalog";
import { imageKey, type BrowserSetup, type Customization, type LayerKey, type Template, type Wadspace } from "@core/layers";
import { wadd, type LibraryCollection } from "@/lib/wadd";
import type { LayerLibrary, LayerPatch } from "../backend";
import { byLayer, imageState, installBody, launchItem, layerRequest, timeZone, wallpaperUpload, type ImageRow, type RunItem } from "../layers";

type Doc = { id: string };

/** A collection of wadd's library, kept in memory once read. */
class Collection<T extends Doc> {
  private items = new Map<string, T>();
  private loaded = false;

  constructor(
    private readonly name: LibraryCollection,
    private readonly keep: (d: T) => boolean = () => true,
  ) {}

  async list(): Promise<T[]> {
    if (!this.loaded) {
      const all = await wadd.library<T>(this.name);
      this.items = new Map(all.filter((d) => d?.id && this.keep(d)).map((d) => [d.id, d]));
      this.loaded = true;
    }
    return [...this.items.values()];
  }

  get(id: string): T | undefined {
    return this.items.get(id);
  }

  async put(d: T): Promise<T> {
    await wadd.libraryPut(this.name, d.id, d);
    this.items.set(d.id, d);
    return d;
  }

  async patch(id: string, patch: LayerPatch): Promise<T> {
    await this.list();
    const d = this.items.get(id);
    if (!d) throw new Error("It's gone.");
    const next = { ...d, ...patch, updatedAt: new Date().toISOString() } as T & { deletedAt?: string | null };
    if (next.deletedAt === null) delete next.deletedAt;
    return this.put(next as T);
  }

  async remove(id: string): Promise<void> {
    await wadd.libraryDelete(this.name, id);
    this.items.delete(id);
  }

  /** Forget what's in memory (wadd said it changed). */
  reset() {
    this.loaded = false;
  }
}

const isV2 = (w: { version?: number }) => w.version === 2;

/** The Builder's documents in wadd's library. */
export class WaddLayerDocs {
  readonly templates = new Collection<Template>("templates");
  readonly customizations = new Collection<Customization>("customizations");
  /** The `wadspaces` collection also holds designs from before the layers: those are left out. */
  readonly wadspaces = new Collection<Wadspace>("wadspaces", isV2);
  readonly browsers = new Collection<BrowserSetup>("browsers");

  constructor(private readonly owner: () => string) {}

  /** The starter templates, made the first time this library is seen (a
   *  `meta` document says so, so a deleted one stays deleted). */
  async createStarters(): Promise<Template[]> {
    const meta = await wadd.library<{ id: string; startersCreated?: boolean }>("meta").catch(() => []);
    if (meta.some((m) => m.id === "library" && m.startersCreated)) return [];
    const have = await this.templates.list();
    const now = new Date().toISOString();
    const made: Template[] = [];
    for (const s of STARTERS) {
      if (have.some((t) => t.id === s.id)) continue;
      made.push(await this.templates.put({ ...s, owner: this.owner(), starter: true, createdAt: now, updatedAt: now }));
    }
    await wadd.libraryPut("meta", "library", { id: "library", startersCreated: true });
    return made;
  }
}

/** This machine's half: wadspaces installed on their layers, layer images,
 *  launches. */
export class WaddMachine {
  /** Layers building here now (from build events). */
  readonly building = new Set<string>();

  /** Installs or updates a wadspace here, with its wallpaper drawn now. */
  async install(w: Wadspace, lib: LayerLibrary): Promise<void> {
    await wadd.installWadspace(w.id, installBody(w, lib, timeZone()));
    await wadd.putWallpaper(w.id, await wallpaperUpload(w.wallpaper));
  }

  async uninstall(id: string): Promise<void> {
    await wadd.remove(id).catch(() => {});
  }

  images(): Promise<ImageRow[]> {
    return wadd.images();
  }

  async build(key: LayerKey, lib: LayerLibrary): Promise<string> {
    const b = await wadd.buildLayer(layerRequest(key, lib));
    this.building.add(key);
    return b.id;
  }

  async deleteImage(key: LayerKey): Promise<void> {
    await wadd.deleteImage(key).catch((e: { status?: number }) => {
      if (e?.status !== 404) throw e;
    });
  }

  /** The launcher's pick: each wadspace installed as it is now (and its
   *  layer built when it isn't, which the launch waits for), then all
   *  launched together. */
  async launch(items: RunItem[], focusMinutes: number | null, lib: LayerLibrary): Promise<string[]> {
    const images = byLayer(await this.images().catch(() => []));
    const ids = new Set(items.flatMap((i) => (i.kind === "wadspace" ? [i.wadspaceId] : [])));
    for (const id of ids) {
      const w = lib.wadspaces.find((x) => x.id === id);
      if (!w) continue;
      await this.install(w, lib);
      const key = imageKey(w.base);
      if (imageState(key, lib, images, this.building) !== "built" && !this.building.has(key)) await this.build(key, lib);
    }
    const projectsOf = (id: string) => lib.wadspaces.find((w) => w.id === id)?.projects ?? [];
    const launchItems = await Promise.all(items.map((it, i) => launchItem(it, { background: i > 0, projectsOf })));
    return wadd.launchBatch(launchItems, focusMinutes);
  }

  async screen(): Promise<{ width: number; height: number }> {
    const m = await wadd.machine().catch(() => null);
    return m?.screen ? { width: m.screen.width, height: m.screen.height } : { width: 1920, height: 1080 };
  }
}

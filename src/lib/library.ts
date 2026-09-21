// The workspace library: saved CreatorSpecs. Firestore (users/{uid}/workspaces)
// when signed in, otherwise this browser's localStorage.
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
import { getBytes, ref, uploadBytes } from "firebase/storage";
import { db, storage } from "./firebase";
import type { CreatorSpec } from "./spec";

const LS_KEY = "wadcreator.library.v1";

function lsRead(): Record<string, CreatorSpec> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
  } catch {
    return {};
  }
}

function lsWrite(all: Record<string, CreatorSpec>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(all));
  } catch {
    throw new Error("Could not save in this browser (storage full or blocked).");
  }
}

// Firestore rejects undefined values; strip them.
const clean = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

export async function listSpecs(uid: string | null): Promise<CreatorSpec[]> {
  let specs: CreatorSpec[];
  if (uid && db) {
    const snap = await getDocs(collection(db, "users", uid, "workspaces"));
    specs = snap.docs.map((d) => d.data() as CreatorSpec);
  } else {
    specs = Object.values(lsRead());
  }
  return specs.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSpec(uid: string | null, id: string): Promise<CreatorSpec | null> {
  if (uid && db) {
    const d = await getDoc(doc(db, "users", uid, "workspaces", id));
    return d.exists() ? (d.data() as CreatorSpec) : null;
  }
  return lsRead()[id] ?? null;
}

export async function saveSpec(uid: string | null, spec: CreatorSpec): Promise<void> {
  const s = clean({ ...spec, updatedAt: Date.now() });
  if (uid && db) {
    // Wallpapers go to Storage; the doc keeps only the path.
    if (s.wallpaper?.dataUrl && storage) {
      const path = `users/${uid}/workspaces/${s.id}/${s.wallpaper.fileName}`;
      const blob = await (await fetch(s.wallpaper.dataUrl)).blob();
      await uploadBytes(ref(storage, path), blob);
      s.wallpaper = { ...s.wallpaper, storagePath: path, dataUrl: undefined };
    }
    await setDoc(doc(db, "users", uid, "workspaces", s.id), clean(s));
    return;
  }
  const all = lsRead();
  all[s.id] = s;
  lsWrite(all);
}

export async function deleteSpec(uid: string | null, id: string): Promise<void> {
  if (uid && db) {
    await deleteDoc(doc(db, "users", uid, "workspaces", id));
    return;
  }
  const all = lsRead();
  delete all[id];
  lsWrite(all);
}

/** Wallpaper bytes for a bundle, from the data URL or Firebase Storage. */
export async function wallpaperBytes(spec: CreatorSpec): Promise<Uint8Array | undefined> {
  const w = spec.wallpaper;
  if (!w) return undefined;
  if (w.dataUrl) return new Uint8Array(await (await fetch(w.dataUrl)).arrayBuffer());
  if (w.storagePath && storage) return new Uint8Array(await getBytes(ref(storage, w.storagePath)));
  return undefined;
}

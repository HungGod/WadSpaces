// The Customization editor: the look (name, description, background), its
// projects, and its secrets: a key per app (or per group of WadBrowser's
// apps), new or picked from the keys already made of the same kind.
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, File as FileIcon, Folder, FolderGit2, HardDrive, ImagePlus, KeyRound, Plus, Trash2, X } from "lucide-react";
import { backend } from "@/data";
import type { FolderListing } from "@/data/backend";
import { useApp } from "@/lib/store";
import { SECRET_KIND_LABEL, WALLPAPERS, keyGroupsOf, keyMap, keyOf, wallpaperCss, type BrowserItem, type KeyLine } from "../catalog";
import { BLANK_WALLPAPER, subOf, uid, type CustomSub, type CustomizationModule, type FoldersSub, type LookSub, type Mount, type SecretKind, type SecretRef, type SecretsSub, type Stack } from "../model";
import { keysOfKind, useBoard } from "../store";
import { useDraggable, useDropTarget, useDrag } from "../drag";
import { Img, MiniDesktop } from "../faces";

/** A picture from this computer, scaled down (a wallpaper needn't be bigger than a screen) and kept as a data URL. */
async function pictureFrom(file: File): Promise<string> {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / img.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function CustomizationEditor({ stack, draft, set, focus }: { stack: Stack; draft: CustomizationModule; set(c: CustomizationModule): void; focus?: string }) {
  const look: LookSub = subOf(draft, "look") ?? { key: "look", id: uid("look"), origin: "", name: "", description: "", wallpaper: BLANK_WALLPAPER };
  const name = look.name.trim() || "Untitled";
  const folders: FoldersSub = subOf(draft, "folders") ?? { key: "folders", id: uid("folders"), origin: name, mounts: [] };
  const secrets: SecretsSub = subOf(draft, "secrets") ?? { key: "secrets", id: uid("secrets"), origin: name, bySlot: {} };
  const put = (sub: CustomSub) => set({ ...draft, subs: [...draft.subs.filter((s) => s.key !== sub.key), sub] });
  // A picture from this computer: kept as a choice while the editor's open.
  const picker = useRef<HTMLInputElement>(null);
  // (also a picture it already had that isn't one of the choices, e.g. the demo board's)
  const [mine, setMine] = useState<string | null>(look.wallpaper.type === "image" ? look.wallpaper.value : null);

  const refs = { look: useRef<HTMLElement>(null), folders: useRef<HTMLElement>(null), secrets: useRef<HTMLElement>(null) };
  useEffect(() => {
    const el = focus && refs[focus as keyof typeof refs]?.current;
    if (el) setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "start" }), 360);
    // Only on open.
  }, []);

  return (
    <div className="cz-editor" data-autoscroll>
      <section ref={refs.look} className={`panel cz-look${focus === "look" ? " focused" : ""}`}>
        <div className="cz-look-fields">
          <div className="field">
            <label>Name</label>
            <input value={look.name} placeholder="Name this wadspace" onChange={(e) => put({ ...look, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Description</label>
            <input value={look.description} placeholder="Optional" onChange={(e) => put({ ...look, description: e.target.value })} />
          </div>
          <div className="wallpapers">
            {WALLPAPERS.map((w) => (
              <button key={w.value} className={`wp${look.wallpaper.value === w.value ? " on" : ""}`} style={{ background: wallpaperCss(w) }} title={w.name} onClick={() => put({ ...look, wallpaper: { type: w.type, value: w.value } })} />
            ))}
            {mine && (
              <button className={`wp${look.wallpaper.value === mine ? " on" : ""}`} style={{ background: wallpaperCss({ type: "image", value: mine }) }} title={mine.startsWith("data:") ? "Your picture" : "Current picture"} onClick={() => put({ ...look, wallpaper: { type: "image", value: mine } })} />
            )}
            <button className="wp wp-pick" title="Choose a picture on this computer" onClick={() => picker.current?.click()}>
              <ImagePlus size={16} />
              <span>Choose a picture…</span>
            </button>
            <input
              ref={picker}
              type="file"
              accept="image/*"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const value = await pictureFrom(file);
                setMine(value);
                put({ ...look, wallpaper: { type: "image", value } });
              }}
            />
          </div>
        </div>
        <MiniDesktop stack={stack} rows={4} className="big" />
      </section>

      <div className="cz-cols">
        <section ref={refs.folders} className={`panel${focus === "folders" ? " focused" : ""}`}>
          <div className="panel-title">Projects</div>
          <Folders stack={stack} sub={folders} put={put} />
        </section>
        <section ref={refs.secrets} className={`panel${focus === "secrets" ? " focused" : ""}`}>
          <div className="panel-title">Secrets</div>
          <Secrets stack={stack} sub={secrets} name={name} put={put} />
        </section>
      </div>
    </div>
  );
}

// ─────────────────────────────── projects ───────────────────────────────

const sizeOf = (bytes = 0) => (bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

function ProjectFace({ m }: { m: Mount }) {
  return (
    <span className="mount-face">
      {m.kind === "github" ? <FolderGit2 size={13} /> : <HardDrive size={13} />}
      <span className="proj-name">{m.as}</span>
      <span className="faint">
        {m.kind === "github"
          ? `cloned from ${m.repo}`
          : `copied from ${m.source.drive ? `the drive ${m.source.drive.label || m.source.drive.uuid}` : "this machine"}${m.files ? ` · ${m.files} file${m.files === 1 ? "" : "s"}, ${sizeOf(m.bytes)}` : " at its first start"}`}
      </span>
    </span>
  );
}

/** What a project is, to tell two apart: a repo, or a copy (by its id). */
const projectKey = (m: Mount) => (m.kind === "github" ? `github:${m.repo.toLowerCase()}` : `copy:${m.id}`);

/**
 * Projects: the files a wadspace starts with, kept inside it at
 * ~/Desktop/<name>. Nothing is mounted: your GitHub repositories are cloned
 * in (+ New project makes one on GitHub, on a machine), and folders or files
 * on the machine are copied in (wadd makes the copy now; the wadspace takes
 * it in when it starts).
 */
function Folders({ stack, sub, put }: { stack: Stack; sub: FoldersSub; put(s: FoldersSub): void }) {
  const stacks = useBoard((s) => s.stacks);
  const repos = useBoard((s) => s.repos);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [problem, setProblem] = useState("");
  const [picking, setPicking] = useState<"folder" | "files" | null>(null);
  const [copying, setCopying] = useState(false);
  useEffect(() => {
    if (repos === null) void useBoard.getState().loadRepos();
  }, [repos]);
  // Each lives at its own ~/Desktop/<name>.
  const freeAs = (want: string) => {
    const clean = want.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "Project";
    let as = clean;
    for (let n = 2; sub.mounts.some((m) => m.as.toLowerCase() === as.toLowerCase()); n++) as = `${clean}-${n}`;
    return as;
  };
  const add = (m: Mount) => put({ ...sub, mounts: [...sub.mounts, { ...m, as: freeAs(m.as) }] });
  const cloned = (repo: string) => sub.mounts.some((m) => m.kind === "github" && m.repo.toLowerCase() === repo.toLowerCase());
  const clone = (repo: string) => !cloned(repo) && add({ id: uid("project"), kind: "github", repo, as: repo.split("/").pop()! });
  const create = async () => {
    const made = await useBoard.getState().createProject(newName);
    if (typeof made === "string") return setProblem(made);
    clone(made.repo);
    setCreating(false);
    setNewName("");
    setProblem("");
  };
  // Paths on the machine: wadd copies them now, and the wadspace takes the copy in.
  const copyIn = async (paths: string[]) => {
    setPicking(null);
    if (!paths.length || !backend.makeCopy) return;
    setCopying(true);
    try {
      const made = await backend.makeCopy(paths);
      const name = paths.length === 1 ? paths[0].split("/").pop()! : "Files";
      add({ id: made.id, kind: "copy", source: { machineId: backend.defaultMachineId() ?? "local", paths }, as: name, files: made.files, bytes: made.bytes });
    } catch (e) {
      useBoard.getState().toast(`Couldn't copy that: ${(e as Error).message}`);
    } finally {
      setCopying(false);
    }
  };
  // What other wadspaces have, to add here too.
  const elsewhere = useMemo(() => {
    const seen = new Set(sub.mounts.map(projectKey));
    const out: Mount[] = [];
    for (const s of stacks)
      if (s.id !== stack.id)
        for (const m of subOf(s.customization, "folders")?.mounts ?? [])
          if (!seen.has(projectKey(m))) {
            seen.add(projectKey(m));
            out.push(m);
          }
    return out;
  }, [stacks, stack.id, sub.mounts]);

  return (
    <div className="cz-list">
      <p className="rail-note proj-note">Cloned or copied into the wadspace: the files live inside it, at ~/Desktop. Nothing is mounted.</p>
      {sub.mounts.map((m) => (
        <div key={m.id} className="cz-row">
          <ProjectFace m={m} />
          <button className="icon-btn" title="Take it out of this wadspace (its files there stay)" onClick={() => put({ ...sub, mounts: sub.mounts.filter((x) => x.id !== m.id) })}>
            <Trash2 size={12} />
          </button>
        </div>
      ))}
      {sub.mounts.length === 0 && <p className="empty-note">No projects yet.</p>}

      <div className="group-label">Your GitHub repositories</div>
      <div className="gh-list">
        {repos === null && <p className="faint small">Loading…</p>}
        {repos?.length === 0 && <p className="faint small">None to show: sign this machine in to GitHub (Secrets, GitHub sign-in).</p>}
        {repos?.map((r) => (
          <button key={r.fullName} className={`gh-proj${cloned(r.fullName) ? " on" : ""}`} onClick={() => clone(r.fullName)} disabled={cloned(r.fullName)} title={r.description ?? r.fullName}>
            <FolderGit2 size={13} />
            <span className="gh-name">{r.name}</span>
            {r.private && <span className="gh-private">private</span>}
            <span className="gh-meta">{r.pushedAt ? new Date(r.pushedAt).toLocaleDateString() : ""}</span>
            <span className="gh-act">{cloned(r.fullName) ? "Cloned" : "Clone"}</span>
          </button>
        ))}
      </div>
      {creating ? (
        <form
          className="add-row new-proj"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input autoFocus placeholder="Repository name" value={newName} onChange={(e) => (setNewName(e.target.value), setProblem(""))} />
          <button className="btn-mini">Create and clone</button>
          <button type="button" className="btn-mini ghost" onClick={() => (setCreating(false), setProblem(""))}>
            Cancel
          </button>
          {problem && <span className="name-clash in-head">{problem}</span>}
          {!problem && newName.trim() && <span className="faint small">Makes a private repository on GitHub</span>}
        </form>
      ) : (
        <button className="btn-ghost new-proj-btn" onClick={() => setCreating(true)} disabled={backend.target === "online"} title={backend.target === "online" ? "Make it on github.com, or from a machine" : undefined}>
          <Plus size={13} /> New project
        </button>
      )}

      <div className="group-label">From this machine</div>
      {backend.caps.copies ? (
        <div className="copy-row">
          <button className="btn-ghost" disabled={copying} onClick={() => setPicking("folder")}>
            <HardDrive size={13} /> {copying ? "Copying…" : "Copy a folder"}
          </button>
          <button className="btn-ghost" disabled={copying} onClick={() => setPicking("files")}>
            <Plus size={13} /> Copy files
          </button>
        </div>
      ) : (
        <p className="faint small">Files are copied in from a machine: open WadSpaces on it to copy some.</p>
      )}
      {elsewhere.length > 0 && (
        <div className="suggest">
          <span className="faint">In other wadspaces:</span>
          {elsewhere.map((m) => (
            <button key={m.id} className="sug" onClick={() => add({ ...m })} title={m.kind === "github" ? `Clone ${m.repo}` : `Copy ${m.as} in too`}>
              {m.kind === "github" ? <FolderGit2 size={12} /> : <HardDrive size={12} />} {m.as}
            </button>
          ))}
        </div>
      )}
      {picking && <MachinePicker files={picking === "files"} onPick={(p) => void copyIn(p)} onClose={() => setPicking(null)} />}
    </div>
  );
}

/** Folders (and files) on the machine, inside the places wadd lets you copy from: one folder, or files, to copy in. */
function MachinePicker({ files, onPick, onClose }: { files: boolean; onPick(paths: string[]): void; onClose(): void }) {
  const [at, setAt] = useState<string | undefined>(undefined);
  const [list, setList] = useState<FolderListing | null>(null);
  const [problem, setProblem] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  useEffect(() => {
    let off = false;
    setList(null);
    backend.browseFolders?.({ path: at, files })?.then(
      (l) => !off && (setList(l), setProblem("")),
      (e) => !off && setProblem((e as Error).message),
    );
    return () => {
      off = true;
    };
  }, [at, files]);
  const toggle = (p: string) => setPicked((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p]));
  return (
    <div className="picker" role="dialog" aria-label={files ? "Copy files" : "Copy a folder"}>
      <div className="picker-head">
        <span>{files ? "Copy files" : "Copy a folder"}</span>
        <span className="faint picker-path">{list?.path ?? "Places you can copy from"}</span>
        <button className="icon-btn" onClick={onClose} title="Close">
          <X size={13} />
        </button>
      </div>
      <div className="picker-list">
        {list?.path && (
          <button className="picker-row" onClick={() => setAt(list.parent ?? undefined)}>
            <ArrowUp size={13} /> Up
          </button>
        )}
        {list?.dirs.map((d) => (
          <button key={d.path} className="picker-row" onClick={() => setAt(d.path)}>
            <Folder size={13} /> {d.name}
          </button>
        ))}
        {files &&
          list?.files?.map((f) => (
            <label key={f.path} className={`picker-row${picked.includes(f.path) ? " on" : ""}`}>
              <input type="checkbox" checked={picked.includes(f.path)} onChange={() => toggle(f.path)} />
              <FileIcon size={13} /> {f.name}
            </label>
          ))}
        {!list && !problem && <p className="faint small">Loading…</p>}
        {problem && <p className="name-clash">{problem}</p>}
        {list && !list.dirs.length && !(files && list.files?.length) && <p className="faint small">Nothing here.</p>}
      </div>
      <div className="picker-foot">
        {files ? (
          <button className="btn-mini" disabled={!picked.length} onClick={() => onPick(picked)}>
            Copy {picked.length || ""} file{picked.length === 1 ? "" : "s"}
          </button>
        ) : (
          <button className="btn-mini" disabled={!list?.path} onClick={() => list?.path && onPick([list.path])}>
            Copy this folder
          </button>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────── secrets ───────────────────────────────

/**
 * Secrets, as keys: each app in the stack wired to its key ("No key" until
 * one's made or picked). VS Code has a key for its settings and one per
 * extension that signs in; WadBrowser's apps (the browser and its web apps)
 * share keys in groups, one group by default. Drag an app between groups to
 * regroup; Ctrl+click apps to drag several at once. New group makes an empty
 * group to drag apps into (or drop apps on it to start one with them).
 */
function Secrets({ stack, sub, name, put }: { stack: Stack; sub: SecretsSub; name: string; put(s: SecretsSub): void }) {
  const apps = keyMap(stack, sub);
  const groups = keyGroupsOf(stack, sub);
  const setKey = (line: KeyLine, ref: SecretRef | null) => {
    if (line.group) return put({ ...sub, groups: groups.map((g) => (g.id === line.group!.id ? { ...g, key: ref ?? undefined } : g)) });
    const bySlot = { ...sub.bySlot };
    if (ref) bySlot[line.slot] = ref;
    else delete bySlot[line.slot];
    put({ ...sub, bySlot });
  };
  // Apps Ctrl+clicked to move together.
  const [picked, setPicked] = useState<string[]>([]);
  const toggle = (m: string) => setPicked((p) => (p.includes(m) ? p.filter((x) => x !== m) : [...p, m]));
  // Apps move to another group (or a new one). A group they leave empty goes;
  // an empty group made with New group stays until it's filled or removed.
  const regroup = (members: string[], to: string | null) => {
    const moved = groups.map((g) => ({ ...g, members: g.members.filter((m) => !members.includes(m)) }));
    const next = to ? moved.map((g) => (g.id === to ? { ...g, members: [...g.members, ...members] } : g)) : [...moved, { id: uid("group"), members }];
    put({ ...sub, groups: next.filter((g, i) => g.members.length || (i < groups.length && !groups[i].members.length)) });
    setPicked([]);
  };
  const newGroup = () => put({ ...sub, groups: [...groups, { id: uid("group"), members: [] }] });
  const dropGroup = (id: string) => put({ ...sub, groups: groups.filter((g) => g.id !== id) });
  // A renamed key, wherever this draft keeps it.
  const renameInDraft = (id: string, to: string) => {
    const swap = <K extends SecretRef | undefined>(k: K): K => (k && k.id === id ? ({ ...k, name: to } as K) : k);
    put({ ...sub, bySlot: Object.fromEntries(Object.entries(sub.bySlot).map(([k, v]) => [k, swap(v)])), groups: groups.map((g) => ({ ...g, key: swap(g.key) })) });
  };
  if (!apps.length) return <p className="empty-note">Nothing in this wadspace keeps a key.</p>;
  const base = name.replace(/\s/g, "") || "Wadspace";
  return (
    <RenameInDraft.Provider value={renameInDraft}>
    <div className="keys">
      {apps.map((a) => (
        <div key={a.id} className={`key-app key-app-${a.id}`}>
          <div className="key-app-head">
            <Img src={a.icon} />
            <span>{a.name}</span>
          </div>
          <div className="key-lines">
            {a.lines.map((l) =>
              l.group ? (
                <GroupLine
                  key={l.slot}
                  line={l}
                  value={keyOf(sub, l)}
                  onSet={(r) => setKey(l, r)}
                  onMembers={(m) => regroup(m, l.group!.id)}
                  onRemove={() => dropGroup(l.group!.id)}
                  picked={picked}
                  onPick={toggle}
                  defaultName={`${base}-${l.appId}`}
                />
              ) : (
                <div key={l.slot} className="key-line">
                  <span className="key-src">
                    <Img src={l.icon} />
                    {l.label}
                  </span>
                  <Wire on={!!keyOf(sub, l)} />
                  <KeyPicker kind={l.kind} value={keyOf(sub, l)} defaultName={`${base}-${l.appId}`} onSet={(r) => setKey(l, r)} />
                </div>
              ),
            )}
            {a.id === "wadbrowser" && <NewGroup onMembers={(m) => regroup(m, null)} onClick={newGroup} />}
          </div>
        </div>
      ))}
      <p className="faint small">No key: that app is signed out when the wadspace stops.</p>
    </div>
    </RenameInDraft.Provider>
  );
}

const Wire = ({ on }: { on: boolean }) => <span className={`wire${on ? " on" : ""}`} />;

/** Renames a key in the draft being edited too (the board's copies are renamed by the store). */
const RenameInDraft = createContext<(id: string, name: string) => void>(() => {});

const appsWord = (n: number) => (n === 1 ? "it" : `these ${n}`);

/** A WadBrowser key group: its apps (drag them between groups) wired to the key they share. */
function GroupLine({
  line,
  value,
  onSet,
  onMembers,
  onRemove,
  picked,
  onPick,
  defaultName,
}: {
  line: KeyLine;
  value?: SecretRef;
  onSet(r: SecretRef | null): void;
  onMembers(m: string[]): void;
  onRemove(): void;
  picked: string[];
  onPick(m: string): void;
  defaultName: string;
}) {
  const id = line.group!.id;
  const drop = useDropTarget(`keygroup:${id}`, {
    accepts: (p) => (p.type !== "member" ? null : p.group === id && p.members.every((m) => line.group!.members.includes(m)) ? null : { ok: true, why: value ? `Share ${value.name} (${appsWord(p.members.length)})` : `Join this group (${appsWord(p.members.length)})` }),
    onDrop: (p) => p.type === "member" && onMembers(p.members),
  });
  const empty = !line.members!.length;
  return (
    <div {...drop.props} className={`key-line group${empty ? " empty" : ""}${drop.over?.ok ? " drop-ok" : drop.could ? " drop-could" : ""}`}>
      <span className="key-src members">
        {line.members!.map((m) => (
          <Member key={m.id} member={m} group={id} picked={picked} onPick={onPick} />
        ))}
        {empty && <span className="drop-here">Drag apps here</span>}
      </span>
      <Wire on={!!value} />
      <KeyPicker kind="web" value={value} defaultName={defaultName} onSet={onSet} />
      {empty && (
        <button className="icon-btn" title="Remove this empty group" onClick={onRemove}>
          <X size={13} />
        </button>
      )}
    </div>
  );
}

/** One of WadBrowser's apps in a key group. Drag it to another group; Ctrl+click picks several to drag together. */
function Member({ member, group, picked, onPick }: { member: BrowserItem; group: string; picked: string[]; onPick(m: string): void }) {
  const on = picked.includes(member.id);
  const face = (n = 1) => (
    <span className={`member${on ? " picked" : ""}`}>
      <Img src={member.icon} />
      {member.name}
      {n > 1 && <span className="member-more">+{n - 1}</span>}
    </span>
  );
  // A picked app drags every picked app with it.
  const drag = useDraggable(() => {
    const members = on ? picked : [member.id];
    return { payload: { type: "member", members, group }, ghost: face(members.length) };
  });
  return (
    <span
      className="member-grab"
      onPointerDown={drag.onPointerDown}
      onClick={(e) => (e.ctrlKey || e.metaKey) && onPick(member.id)}
      title="Drag to another group · Ctrl+click to pick several"
    >
      {face()}
    </span>
  );
}

/** New group: press it for an empty group to drag apps into, or drop apps on it for a group of their own. */
function NewGroup({ onMembers, onClick }: { onMembers(m: string[]): void; onClick(): void }) {
  const { active } = useDrag();
  const drop = useDropTarget("keygroup:new", {
    accepts: (p) => (p.type === "member" ? { ok: true, why: `A new group, with a key of its own (${appsWord(p.members.length)})` } : null),
    onDrop: (p) => p.type === "member" && onMembers(p.members),
  });
  return (
    <button {...drop.props} className={`key-line new-group${active?.payload.type === "member" ? " live" : ""}${drop.over?.ok ? " drop-ok" : ""}`} onClick={onClick}>
      <Plus size={13} /> New group
    </button>
  );
}

/** A key: "No key", or its name. Click it to make a new key or pick one of the same kind. */
function KeyPicker({ kind, value, defaultName, onSet }: { kind: SecretKind; value?: SecretRef; defaultName: string; onSet(r: SecretRef | null): void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useApp((s) => s.signIns);
  const keys = useApp.getState().knownSignIns();
  const stacks = useBoard((s) => s.stacks);
  const existing = keysOfKind(keys, stacks, kind).filter((k) => k.id !== value?.id);
  // The machine's name for it: renamed elsewhere (the Secrets page), a wadspace may still keep the old one.
  const shown = (value && keys.find((k) => k.id === value.id)?.name) ?? value?.name ?? "";
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    // Esc closes the menu only, not the whole editor (caught before the editor's own listener).
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopImmediatePropagation(), setOpen(false));
    addEventListener("mousedown", away);
    addEventListener("keydown", esc, true);
    return () => (removeEventListener("mousedown", away), removeEventListener("keydown", esc, true));
  }, [open]);
  const pick = (r: SecretRef | null) => {
    onSet(r);
    setOpen(false);
  };
  // Click the key's name to rename it, in place: everywhere it's kept, this draft included.
  const renameInDraft = useContext(RenameInDraft);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const stop = () => (setRenaming(null), setProblem(""));
  const rename = (keepOnClash: boolean) => {
    if (!value || renaming === null) return;
    if (!renaming.trim() || renaming.trim() === shown) return stop();
    const why = useBoard.getState().renameKey(value.id, renaming);
    if (why) return keepOnClash ? setProblem(why) : stop();
    renameInDraft(value.id, renaming.trim());
    stop();
  };
  if (value && renaming !== null)
    return (
      <span ref={ref} className="key-pick">
        <span className="key-edit">
          <KeyRound size={13} />
          <input
            autoFocus
            className={problem ? "clash" : ""}
            value={renaming}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => (setRenaming(e.target.value), setProblem(""))}
            // Enter saves; clicking away saves too, unless the name's taken.
            onBlur={() => rename(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") rename(true);
              // Esc cancels the rename only, not the whole editor.
              if (e.key === "Escape") (e.nativeEvent.stopPropagation(), stop());
            }}
          />
        </span>
        {problem && <span className="name-clash key-clash">{problem}</span>}
      </span>
    );
  return (
    <span ref={ref} className="key-pick">
      <button
        className={`key-btn${value ? " set" : ""}`}
        // The name renames the key; the key icon (or No key) opens the menu.
        onClick={(e) => {
          if (value && (e.target as HTMLElement).closest(".secret-name")) return (setOpen(false), setRenaming(shown));
          setOpen((o) => !o);
        }}
        title={value ? `${SECRET_KIND_LABEL[kind]} · click the name to rename it, the key for more` : SECRET_KIND_LABEL[kind]}
      >
        <KeyRound size={13} />
        <span className={`secret-name${value ? " renamable" : ""}`}>{value ? shown : "No key"}</span>
      </button>
      {open && (
        <div className="key-menu">
          <button
            onClick={() =>
              void useBoard
                .getState()
                .createKey(kind, defaultName)
                .then(pick, (e) => useBoard.getState().toast(`Couldn't make the key: ${(e as Error).message}`))
            }
          >
            <Plus size={12} /> New key <span className="faint">{defaultName}</span>
          </button>
          {existing.length > 0 && <div className="group-label">Your {SECRET_KIND_LABEL[kind]} keys</div>}
          {existing.map((k) => (
            <button key={k.id} onClick={() => pick(k)}>
              <KeyRound size={12} /> {k.name}
            </button>
          ))}
          {value && (
            <button className="danger-text" onClick={() => pick(null)}>
              No key
            </button>
          )}
        </div>
      )}
    </span>
  );
}

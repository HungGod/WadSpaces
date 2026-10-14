// Files: what's saved on this machine's disk outside the images (wadd's
// /v1/files): your files on the machine (WadBrowser's downloads, and so on),
// each wadspace's home, and what was copied in. Look through them, open a
// text file to read or edit it, delete what you don't need. Secrets (saved
// sign-ins, WadBrowser's profiles, keys and tokens) never show here.
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, File, FileText, Folder, HardDrive, Loader2, Pencil, RefreshCw, Trash2 } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { timeAgo } from "@/lib/format";
import { useApp } from "@/lib/store";
import { formatBytes, type FileList, type FileRoot } from "@/lib/wadd";
import { Button, EmptyState, IconButton, Modal, Textarea } from "./ui";

export function MachineFiles() {
  const files = backend.files;
  const [roots, setRoots] = useState<FileRoot[]>([]);
  const [root, setRoot] = useState<string | null>(null);
  const [path, setPath] = useState("");
  const [list, setList] = useState<FileList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ path: string; text: string } | null>(null);
  const [deleting, setDeleting] = useState<{ path: string; dir: boolean } | null>(null);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    files
      ?.roots()
      .then((r) => {
        setRoots(r);
        setRoot((cur) => cur ?? r[0]?.id ?? null);
      })
      .catch((e) => setError((e as Error).message));
  }, [files]);

  const load = useCallback(async () => {
    if (!files || !root) return;
    setBusy(true);
    try {
      setList(await files.list(root, path));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [files, root, path]);
  useEffect(() => void load(), [load]);

  if (!files) return null;
  const join = (name: string) => (path ? `${path}/${name}` : name);
  const crumbs = path ? path.split("/") : [];
  const open = async (name: string) => {
    try {
      setEditing({ path: join(name), text: await files.readText(root!, join(name)) });
    } catch (e) {
      toast({ title: "Couldn't open it", body: (e as Error).message, tone: "error" });
    }
  };
  const save = async () => {
    if (!editing) return;
    try {
      await files.writeText(root!, editing.path, editing.text);
      toast({ title: "Saved", body: editing.path, tone: "success" });
      setEditing(null);
      void load();
    } catch (e) {
      toast({ title: "Couldn't save it", body: (e as Error).message, tone: "error" });
    }
  };
  const remove = async () => {
    if (!deleting) return;
    try {
      await files.delete(root!, deleting.path);
      setDeleting(null);
      void load();
    } catch (e) {
      toast({ title: "Couldn't delete it", body: (e as Error).message, tone: "error" });
    }
  };

  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div>
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
            <HardDrive className="size-4 text-accent" /> Files
          </h3>
          <p className="mt-0.5 text-xs text-muted">What&apos;s saved on this machine outside the images. Secrets (saved sign-ins, keys, tokens) stay out of here.</p>
        </div>
        <IconButton label="Look again" onClick={() => void load()} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
        </IconButton>
      </div>
      <div className="grid md:grid-cols-[220px_1fr]">
        <div className="border-b border-line p-3 md:border-b-0 md:border-r">
          {roots.map((r) => (
            <button
              key={r.id}
              type="button"
              title={r.detail}
              onClick={() => (setRoot(r.id), setPath(""))}
              className={clsx("block w-full truncate rounded-xl px-3 py-2 text-left text-sm", r.id === root ? "bg-accent-soft font-medium text-fg" : "text-muted hover:bg-surface-2")}
            >
              {r.label}
            </button>
          ))}
          {!roots.length && <p className="px-3 py-2 text-xs text-muted">Nothing to look through.</p>}
        </div>
        <div className="min-w-0 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-1 px-1 text-sm">
            <button type="button" className="font-medium hover:underline" onClick={() => setPath("")}>
              {roots.find((r) => r.id === root)?.label ?? "…"}
            </button>
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                <ChevronRight className="size-3.5 text-faint" />
                <button type="button" className="hover:underline" onClick={() => setPath(crumbs.slice(0, i + 1).join("/"))}>
                  {c}
                </button>
              </span>
            ))}
          </div>
          {error ? (
            <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>
          ) : !list ? (
            <p className="px-1 text-sm text-muted">Looking…</p>
          ) : !list.entries.length ? (
            <EmptyState icon={<Folder className="size-6" />} title="Empty" body="Nothing saved here." />
          ) : (
            <ul className="divide-y divide-line rounded-2xl ring-1 ring-line">
              {list.entries.map((f) => (
                <li key={f.name} className="flex items-center gap-3 px-3 py-2">
                  {f.dir ? <Folder className="size-4 shrink-0 text-accent" /> : f.text ? <FileText className="size-4 shrink-0 text-muted" /> : <File className="size-4 shrink-0 text-muted" />}
                  <button
                    type="button"
                    disabled={!f.dir && !f.text}
                    onClick={() => (f.dir ? setPath(join(f.name)) : void open(f.name))}
                    className={clsx("min-w-0 flex-1 truncate text-left text-sm", (f.dir || f.text) && "hover:underline")}
                  >
                    {f.name}
                  </button>
                  <span className="hidden w-24 shrink-0 text-right font-mono text-xs text-muted sm:block">{f.dir ? "" : formatBytes(f.bytes)}</span>
                  <span className="hidden w-24 shrink-0 text-right text-xs text-faint md:block">{f.modified ? timeAgo(new Date(f.modified * 1000).toISOString()) : ""}</span>
                  {f.text && (
                    <IconButton label={`Edit ${f.name}`} onClick={() => void open(f.name)}>
                      <Pencil className="size-3.5" />
                    </IconButton>
                  )}
                  <IconButton label={`Delete ${f.name}`} onClick={() => setDeleting({ path: join(f.name), dir: f.dir })}>
                    <Trash2 className="size-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.path.split("/").pop()} subtitle={editing?.path} width={760}>
        <Textarea value={editing?.text ?? ""} onChange={(e) => setEditing((x) => x && { ...x, text: e.target.value })} className="h-[50vh] font-mono text-xs" spellCheck={false} aria-label="The file's text" />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setEditing(null)}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </div>
      </Modal>
      <Modal open={!!deleting} onClose={() => setDeleting(null)} title={`Delete ${deleting?.path.split("/").pop()}?`} subtitle={deleting?.dir ? "The folder and everything in it, for good." : "For good: it isn't kept anywhere else."}>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setDeleting(null)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void remove()}>
            <Trash2 className="size-4" /> Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
}

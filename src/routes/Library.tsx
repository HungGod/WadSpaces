import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Notice, PageTitle, useBusy } from "../components/ui";
import { useAuth } from "../lib/auth";
import { firebaseEnabled } from "../lib/firebase";
import { deleteSpec, listSpecs, wallpaperBytes } from "../lib/library";
import { type CreatorSpec, resolveFeatures } from "../lib/spec";
import { bundleZip } from "../templates";

export function download(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export default function Library() {
  const { user, ready } = useAuth();
  const uid = user?.uid ?? null;
  const [specs, setSpecs] = useState<CreatorSpec[] | null>(null);
  const { busy, error, run } = useBusy();

  const load = () => listSpecs(uid).then(setSpecs);
  useEffect(() => {
    if (ready) run("load", load);
  }, [uid, ready]);

  const where = uid ? "your Wad Creator account" : "this browser";

  return (
    <>
      <PageTitle
        title="Workspaces"
        sub={`Saved workspace designs, kept in ${where}. Download one as a build folder, or install it on this machine.`}
        actions={<Link className="btn btn-primary" to="/new">New workspace</Link>}
      />
      {firebaseEnabled && !uid && ready && (
        <div className="mb-4">
          <Notice>Sign in to keep workspaces in your account instead of this browser.</Notice>
        </div>
      )}
      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
      {specs && specs.length === 0 && (
        <div className="card p-8 text-center text-sm text-muted">
          Nothing saved yet. <Link className="text-accent underline" to="/new">Create a workspace</Link>.
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {specs?.map((s) => (
          <div key={s.id} className="card flex flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-semibold">{s.name}</div>
                <div className="font-mono text-xs text-faint">{s.id}</div>
              </div>
              {s.hotkey && <span className="kbd">Super {s.hotkey}</span>}
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {resolveFeatures(s).map((f) => (
                <span key={f} className="rounded-md bg-hover px-2 py-0.5 text-xs text-muted">{f}</span>
              ))}
            </div>
            <div className="mt-2 text-xs text-faint">
              {s.repos.length} repos · {s.webapps.length} web apps · {s.kaleResources.length} Kale Browser apps
            </div>
            <div className="mt-auto flex flex-wrap gap-2 pt-4">
              <Link className="btn btn-sm" to={`/edit/${s.id}`}>Edit</Link>
              <button
                className="btn btn-sm"
                disabled={busy === `zip:${s.id}`}
                onClick={() => run(`zip:${s.id}`, async () => download(await bundleZip(s, await wallpaperBytes(s)), `${s.id}.zip`))}
              >
                Download
              </button>
              <button
                className="btn btn-sm btn-danger"
                onClick={() => confirm(`Delete ${s.name} from ${where}?`) && run(`del:${s.id}`, async () => { await deleteSpec(uid, s.id); await load(); })}
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

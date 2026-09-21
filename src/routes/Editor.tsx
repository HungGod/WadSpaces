import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Field, Notice, PageTitle, RowList, Section, useBusy } from "../components/ui";
import { useAuth } from "../lib/auth";
import { getSpec, saveSpec, wallpaperBytes } from "../lib/library";
import { preset } from "../lib/presets";
import {
  type CreatorSpec,
  FEATURES,
  type FeatureId,
  IMAGE_PREFIX,
  fromWaddSpec,
  newSpec,
  resolveFeatures,
  slugify,
  toWaddSpec,
  validate,
} from "../lib/spec";
import { WaddError, wadd } from "../lib/wadd";
import { bundleFiles, bundleZip } from "../templates";
import { download } from "./Library";

const MAX_WALLPAPER = 3 * 1024 * 1024;

export default function Editor() {
  const { id } = useParams();
  const editing = Boolean(id);
  const navigate = useNavigate();
  const { user, ready } = useAuth();
  const uid = user?.uid ?? null;
  const [spec, setSpec] = useState<CreatorSpec | null>(editing ? null : newSpec());
  const [onMachine, setOnMachine] = useState(false);
  const [idTouched, setIdTouched] = useState(editing);
  const [preview, setPreview] = useState("Dockerfile");
  const [ok, setOk] = useState<string | null>(null);
  const { busy, error, setError, run } = useBusy();

  // Load: library copy (build settings) merged with the machine's run settings.
  useEffect(() => {
    if (!editing || !ready) return;
    (async () => {
      const lib = (await getSpec(uid, id!).catch(() => null)) ?? preset(id!) ?? null;
      let machine = null;
      try {
        machine = await wadd.spec(id!);
      } catch (e) {
        if (!(e instanceof WaddError && e.status === 404)) setError((e as Error).message);
      }
      setOnMachine(Boolean(machine));
      if (!lib && !machine) return setError(`No workspace ${id} in the library or on this machine.`);
      setSpec(machine ? fromWaddSpec(machine, lib ?? undefined) : lib);
    })();
  }, [id, uid, ready]);

  const errors = useMemo(() => (spec ? validate(spec) : []), [spec]);
  const files = useMemo(() => (spec && !errors.length ? bundleFiles(spec) : []), [spec, errors]);

  if (!spec) return <PageTitle title="Loading…" sub={error && <span className="text-danger">{error}</span>} />;

  const set = (patch: Partial<CreatorSpec>) => {
    setOk(null);
    setSpec((s) => ({ ...s!, ...patch }));
  };
  const setName = (name: string) => {
    if (idTouched) return set({ name });
    const nid = slugify(name);
    set({ name, id: nid, image: nid ? `${IMAGE_PREFIX}${nid}:latest` : "" });
  };
  const toggleFeature = (f: FeatureId) =>
    set({ features: spec.features.includes(f) ? spec.features.filter((x) => x !== f) : [...spec.features, f] });

  const onWallpaper = (file: File | undefined) => {
    if (!file) return set({ wallpaper: undefined });
    if (file.size > MAX_WALLPAPER) return setError("Wallpaper must be under 3 MB.");
    const ext = file.type === "image/jpeg" ? "jpg" : "png";
    if (!["image/png", "image/jpeg"].includes(file.type)) return setError("Use a PNG or JPEG wallpaper.");
    const r = new FileReader();
    r.onload = () =>
      set({ wallpaper: { fileName: `wallpaper.${ext}`, dataUrl: String(r.result), mode: spec.wallpaper?.mode ?? "center", color: spec.wallpaper?.color ?? "#0b0b14" } });
    r.readAsDataURL(file);
  };

  const save = () =>
    run("save", async () => {
      await saveSpec(uid, spec);
      setOk(`Saved to ${uid ? "your account" : "this browser"}.`);
      if (!editing) navigate(`/edit/${spec.id}`, { replace: true });
    });

  const install = () =>
    run("install", async () => {
      await saveSpec(uid, spec);
      if (onMachine) {
        const res = await wadd.update(spec.id, toWaddSpec(spec));
        setOk(res.restart_required ? "Updated. Restart the workspace to apply the changes." : "Updated on this machine.");
      } else {
        await wadd.create(toWaddSpec(spec));
        setOnMachine(true);
        setOk(
          `Installed. The image ${spec.image} must exist before it can start: download the build folder and run containers/build.sh --only ${spec.id}.`,
        );
        if (!editing) navigate(`/edit/${spec.id}`, { replace: true });
      }
    });

  const zip = () => run("zip", async () => download(await bundleZip(spec, await wallpaperBytes(spec)), `${spec.id}.zip`));

  const current = files.find((f) => f.path === preview) ?? files[0];
  const picker = FEATURES.filter((f) => !f.hidden);
  const implied = resolveFeatures(spec).filter((f) => !spec.features.includes(f));

  return (
    <>
      <PageTitle
        title={editing ? spec.name || spec.id : "New workspace"}
        sub={onMachine ? "Installed on this machine." : "Not installed on this machine yet."}
        actions={
          <>
            <button className="btn" disabled={!!errors.length || busy === "save"} onClick={save}>Save</button>
            <button className="btn" disabled={!!errors.length || busy === "zip"} onClick={zip}>Download build folder</button>
            <button className="btn btn-primary" disabled={!!errors.length || busy === "install"} onClick={install}>
              {onMachine ? "Update on this machine" : "Install on this machine"}
            </button>
          </>
        }
      />

      <div className="mb-6 space-y-2">
        {error && <Notice kind="error">{error}</Notice>}
        {ok && <Notice kind="ok">{ok}</Notice>}
        {errors.length > 0 && (
          <Notice>
            <ul className="list-inside list-disc">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </Notice>
        )}
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
        <div className="space-y-6">
          <Section title="Basics">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name">
                <input className="field" value={spec.name} onChange={(e) => setName(e.target.value)} placeholder="Deep Work" />
              </Field>
              <Field label="ID" hint={editing ? "Cannot change after creation." : "Container is wad-<id>."}>
                <input
                  className="field font-mono"
                  value={spec.id}
                  disabled={editing}
                  onChange={(e) => {
                    setIdTouched(true);
                    set({ id: e.target.value.toLowerCase() });
                  }}
                />
              </Field>
              <Field label="Wallpaper" hint="PNG or JPEG, shown centred on the workspace desktop.">
                <input type="file" accept="image/png,image/jpeg" className="field file:mr-3 file:rounded-md file:border-0 file:bg-hover file:px-2 file:py-1 file:text-ink" onChange={(e) => onWallpaper(e.target.files?.[0])} />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Fit">
                  <select className="field" disabled={!spec.wallpaper} value={spec.wallpaper?.mode ?? "center"} onChange={(e) => spec.wallpaper && set({ wallpaper: { ...spec.wallpaper, mode: e.target.value as never } })}>
                    {["center", "fill", "fit", "stretch", "tile"].map((m) => <option key={m}>{m}</option>)}
                  </select>
                </Field>
                <Field label="Backdrop">
                  <input type="color" className="field h-[38px] p-1" disabled={!spec.wallpaper} value={spec.wallpaper?.color ?? "#0b0b14"} onChange={(e) => spec.wallpaper && set({ wallpaper: { ...spec.wallpaper, color: e.target.value } })} />
                </Field>
              </div>
            </div>
            {spec.wallpaper?.dataUrl && (
              <img src={spec.wallpaper.dataUrl} alt="" className="mt-4 max-h-40 rounded-lg border border-line" style={{ background: spec.wallpaper.color }} />
            )}
          </Section>

          <Section title="Apps" hint="Installed into the image. Web apps and Kale Browser apps add their browser automatically.">
            <div className="grid gap-2 sm:grid-cols-2">
              {picker.map((f) => (
                <label key={f.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${spec.features.includes(f.id) ? "border-accent/60 bg-hover" : "border-line hover:border-line-strong"}`}>
                  <input type="checkbox" className="mt-0.5 accent-[#8fd18a]" checked={spec.features.includes(f.id)} onChange={() => toggleFeature(f.id)} />
                  <span>
                    <span className="block text-sm font-medium">{f.label}</span>
                    <span className="block text-xs text-muted">{f.description}</span>
                  </span>
                </label>
              ))}
            </div>
            {implied.length > 0 && <p className="mt-3 text-xs text-faint">Also installed: {implied.join(", ")}</p>}
          </Section>

          <Section title="Repositories" hint="Cloned onto the desktop at every start (fast-forwarded if present). Uses the github_token secret for private repos.">
            <RowList
              items={spec.repos}
              onChange={(repos) => set({ repos })}
              blank={() => ({ url: "", dest: "", postClone: "" })}
              addLabel="Add repository"
              render={(r, setR) => (
                <>
                  <input className="field font-mono" placeholder="https://github.com/you/repo.git" value={r.url} onChange={(e) => setR({ ...r, url: e.target.value })} />
                  <input className="field" placeholder="Folder (default: repo name)" value={r.dest} onChange={(e) => setR({ ...r, dest: e.target.value })} />
                  <input className="field font-mono" placeholder="Once after clone, e.g. npm install" value={r.postClone ?? ""} onChange={(e) => setR({ ...r, postClone: e.target.value })} />
                </>
              )}
            />
          </Section>

          <Section title="Web apps" hint="Chrome app windows with their own desktop icon. All share one Chrome profile.">
            <RowList
              items={spec.webapps}
              onChange={(webapps) => set({ webapps })}
              blank={() => ({ name: "", url: "" })}
              addLabel="Add web app"
              render={(w, setW) => (
                <>
                  <input className="field" placeholder="Name" value={w.name} onChange={(e) => setW({ ...w, name: e.target.value })} />
                  <input className="field font-mono" placeholder="https://…" value={w.url} onChange={(e) => setW({ ...w, url: e.target.value })} />
                </>
              )}
            />
          </Section>

          <Section title="Kale Browser apps" hint="Sites packaged as single-purpose Kale Browser apps (no URL bar).">
            <RowList
              items={spec.kaleResources}
              onChange={(kaleResources) => set({ kaleResources })}
              blank={() => ({ app_name: "", app_url: "" })}
              addLabel="Add Kale Browser app"
              render={(k, setK) => (
                <>
                  <input className="field" placeholder="Name" value={k.app_name} onChange={(e) => setK({ ...k, app_name: e.target.value })} />
                  <input className="field font-mono" placeholder="https://…" value={k.app_url} onChange={(e) => setK({ ...k, app_url: e.target.value })} />
                </>
              )}
            />
          </Section>

          <Section title="On this machine" hint="How wadd runs it. Stored in /etc/wadspaces/workspaces.yaml.">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Port" hint="127.0.0.1 only">
                <input type="number" className="field" value={spec.port} onChange={(e) => set({ port: Number(e.target.value) })} />
              </Field>
              <Field label="Hotkey" hint="Super + number">
                <select className="field" value={spec.hotkey ?? ""} onChange={(e) => set({ hotkey: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">None</option>
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => <option key={n} value={n}>Super+{n}</option>)}
                </select>
              </Field>
              <Field label="Shared memory">
                <input className="field" value={spec.shmSize} onChange={(e) => set({ shmSize: e.target.value })} />
              </Field>
              <div className="sm:col-span-3">
                <Field label="Image">
                  <input className="field font-mono" value={spec.image} onChange={(e) => set({ image: e.target.value })} />
                </Field>
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-3">
                <input type="checkbox" className="accent-[#8fd18a]" checked={spec.persistConfig} onChange={(e) => set({ persistConfig: e.target.checked })} />
                Keep the home folder (/config) between restarts: extensions, logins, clones
              </label>
              <Field label="Secrets" hint="Comma separated podman secret names">
                <input className="field font-mono" value={spec.secrets.join(", ")} onChange={(e) => set({ secrets: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
              </Field>
              <Field label="Devices" hint="/dev/kvm for Android emulators">
                <input className="field font-mono" value={spec.devices.join(", ")} onChange={(e) => set({ devices: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })} />
              </Field>
              <Field label="Environment" hint="KEY=value, one per line">
                <textarea
                  className="field min-h-20 font-mono"
                  value={Object.entries(spec.env).map(([k, v]) => `${k}=${v}`).join("\n")}
                  onChange={(e) =>
                    set({
                      env: Object.fromEntries(
                        e.target.value.split("\n").map((l) => l.split(/=(.*)/s)).filter(([k]) => k?.trim()).map(([k, v]) => [k.trim(), v ?? ""]),
                      ),
                    })
                  }
                />
              </Field>
            </div>
          </Section>
        </div>

        <div className="xl:sticky xl:top-20 xl:self-start">
          <Section title="Build folder" hint="What Download produces; same layout as WadSpaces/containers/<id>/.">
            {files.length === 0 ? (
              <p className="text-sm text-muted">Fix the issues above to preview.</p>
            ) : (
              <>
                <div className="mb-3 flex flex-wrap gap-1">
                  {files.map((f) => (
                    <button key={f.path} onClick={() => setPreview(f.path)} className={`rounded-md px-2 py-1 font-mono text-xs ${current?.path === f.path ? "bg-hover text-ink" : "text-muted hover:text-ink"}`}>
                      {f.path.split("/").pop()}
                    </button>
                  ))}
                </div>
                <pre className="max-h-[70vh] overflow-auto rounded-lg border border-line bg-bg p-4 font-mono text-xs leading-relaxed text-muted">
                  {typeof current?.content === "string" ? current.content : "(binary)"}
                </pre>
              </>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}

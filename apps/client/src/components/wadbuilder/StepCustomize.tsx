// Step 2: Template customization. Everything the template's apps can be set
// up with, what opens at boot, and command-line tools. Changes are saved as a
// customization: its own image, built on the template's. Import merges in
// parts of another customization.
import { useState } from "react";
import { Download, Info, KeyRound, Plus, Power, Trash2 } from "lucide-react";
import clsx from "clsx";
import { appById, EXTENSIONS, extensionById, SECRET_KINDS, TOOLS, type AppDef } from "@core/catalog/catalog";
import { bootables, emptySetup, IMPORT_PARTS, importable, importInto, nameTaken, resolve, sameSetup, webappIcon, webappId, type Customization, type ImportPart, type Setup, type Template } from "@core/layers";
import { alive, useApp } from "@/lib/store";
import { useTour } from "@/lib/tour";
import { Badge, Button, Input, Modal, Toggle } from "../ui";
import { AppDetails } from "./AppDetails";
import { useDraft } from "./draft";
import { Choice, Heading } from "./parts";
import { customizationSummary } from "./StepTemplate";

export function StepCustomize() {
  const base = useDraft((s) => s.base);
  const setup = useDraft((s) => s.setup);
  const setSetup = useDraft((s) => s.setSetup);
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const [details, setDetails] = useState<AppDef | null>(null);
  const [importing, setImporting] = useState(false);
  const r = base && resolve({ templates, customizations }, base);
  if (!r || !setup) return null;
  const { template } = r;

  return (
    <div className="space-y-7 p-5" data-tour="step-customize">
      <div>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-accent">Customizing</div>
            <div className="mt-0.5 font-display text-lg font-semibold tracking-tight">{r.customization ? `${r.customization.name}` : `${template.name} template`}</div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setImporting(true)} title="Bring in web apps, extensions, tools and more from another customization" data-tour="import">
            <Download className="size-3.5" /> Import
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {template.apps.map((id) => {
            const a = appById(id);
            return a ? (
              <button key={id} type="button" onClick={() => setDetails(a)} className="flex items-center gap-1.5 rounded-lg bg-surface-2 py-1 pl-1.5 pr-2 text-xs ring-1 ring-line hover:ring-line-strong">
                <img src={a.icon} alt="" className="size-4 object-contain" /> {a.name} <Info className="size-3 text-faint" />
              </button>
            ) : null;
          })}
        </div>
      </div>

      {template.apps.map((id) => {
        const app = appById(id);
        if (!app) return null;
        return (
          <section key={id} className="rounded-2xl bg-surface-2/50 p-4 ring-1 ring-line">
            <div className="mb-3 flex items-center gap-2.5">
              <img src={app.icon} alt="" className="size-6 object-contain" />
              <span className="flex-1 text-sm font-semibold">{app.name}</span>
              {app.secret && (
                <Badge tone="accent">
                  <KeyRound className="size-3" /> Sign-in in Step 3
                </Badge>
              )}
            </div>
            {app.options === "wadbrowser" ? (
              <BrowserOptions setup={setup} setSetup={setSetup} />
            ) : app.options === "vscode" ? (
              <VsCodeOptions setup={setup} setSetup={setSetup} />
            ) : (
              <p className="text-xs text-muted">Nothing to set up for {app.name}.{app.secret ? ` ${SECRET_KINDS[app.secret.kind].label}: chosen when you construct the wadspace.` : ""}</p>
            )}
          </section>
        );
      })}

      <section>
        <Heading hint="They open, one after another, when the wadspace's container starts.">Open at boot</Heading>
        <div className="space-y-1">
          {bootables(template, setup).map((b) => (
            <div key={b.key} className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-surface-2">
              <img src={b.iconUrl} alt="" className="size-5 shrink-0 object-contain" />
              <span className="min-w-0 flex-1 truncate text-sm">{b.name}</span>
              <Toggle
                checked={setup.autostart.includes(b.key)}
                onChange={(on) => setSetup({ autostart: on ? [...setup.autostart, b.key] : setup.autostart.filter((k) => k !== b.key) })}
                label={`Open ${b.name} at boot`}
              />
            </div>
          ))}
        </div>
        <p className="mt-2 flex items-center gap-1.5 text-xs text-faint">
          <Power className="size-3" /> {setup.autostart.length || "Nothing"} open{setup.autostart.length === 1 ? "s" : ""} at boot
        </p>
      </section>

      <section>
        <Heading hint="Command-line tools, installed into the customization's image.">Tools</Heading>
        <div className="space-y-1">
          {TOOLS.map((t) => (
            <label key={t.id} className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-surface-2">
              <input
                type="checkbox"
                checked={setup.tools.includes(t.id)}
                onChange={(e) => setSetup({ tools: e.target.checked ? [...setup.tools, t.id] : setup.tools.filter((x) => x !== t.id) })}
                className="size-4 accent-[var(--accent)]"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{t.name}</span>
                <span className="block text-xs text-muted">{t.description}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <AppDetails app={details} onClose={() => setDetails(null)} />
      <ImportDialog open={importing} onClose={() => setImporting(false)} template={template} setup={setup} exclude={r.customization?.id} onImport={(next) => setSetup(next)} />
    </div>
  );
}

/** A starting point from past work: another customization's web apps, extensions, tools, boot apps and WadBrowser mode, merged in. */
function ImportDialog({ open, onClose, template, setup, exclude, onImport }: { open: boolean; onClose: () => void; template: Template; setup: Setup; exclude?: string; onImport: (s: Setup) => void }) {
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const [from, setFrom] = useState<Customization | null>(null);
  const [parts, setParts] = useState<ImportPart[]>([]);
  const sources = alive(customizations).filter((c) => c.id !== exclude);
  const pick = (c: Customization) => {
    setFrom(c);
    const can = importable(c, template);
    setParts(IMPORT_PARTS.map((p) => p.part).filter((p) => can[p].ok));
  };
  const close = () => {
    setFrom(null);
    onClose();
  };
  const can = from && importable(from, template);
  return (
    <Modal open={open} onClose={close} width={640} title="Import a customization" subtitle={`Start from past work: bring parts of any customization, from ${template.name} or another template, into this one.`}>
      {sources.length ? (
        <div className="space-y-2">
          {sources.map((c) => {
            const t = templates.find((x) => x.id === c.templateId);
            return (
              <button key={c.id} type="button" onClick={() => pick(c)} className={clsx("flex w-full items-center gap-3 rounded-2xl p-3 text-left ring-1", from?.id === c.id ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{c.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {t?.name ?? "?"} · {customizationSummary(c)}
                  </span>
                </span>
                {t && t.id !== template.id && <Badge>Other template</Badge>}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted ring-1 ring-line">No other customizations yet. Each one you save shows up here to import from.</p>
      )}
      {from && can && (
        <div className="mt-4 space-y-1 rounded-2xl bg-surface-2/60 p-3 ring-1 ring-line">
          <div className="mb-1 text-xs font-semibold uppercase tracking-[0.12em] text-faint">From {from.name}</div>
          {IMPORT_PARTS.map(({ part, label }) => {
            const c = can[part];
            return (
              <label key={part} className={clsx("flex items-center gap-2.5 rounded-xl px-2 py-1.5", c.ok ? "cursor-pointer hover:bg-surface" : "opacity-50")}>
                <input type="checkbox" disabled={!c.ok} checked={parts.includes(part)} onChange={(e) => setParts(e.target.checked ? [...parts, part] : parts.filter((p) => p !== part))} className="size-4 accent-[var(--accent)]" aria-label={label} />
                <span className="flex-1 text-sm">{label}</span>
                <span className="text-xs text-muted">{c.why ?? (part === "browserMode" ? (c.count ? "Focus" : "Default") : c.count)}</span>
              </label>
            );
          })}
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2 border-t border-line pt-4">
        <Button variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          disabled={!from || !parts.length}
          onClick={() => {
            if (from) onImport(importInto(setup, from, template, parts));
            close();
          }}
        >
          <Download className="size-4" /> Import
        </Button>
      </div>
    </Modal>
  );
}

type Props = { setup: Setup; setSetup: (p: Partial<Setup>) => void };

function BrowserOptions({ setup, setSetup }: Props) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const add = () => {
    const n = name.trim();
    let u = url.trim();
    if (!n || !u) return;
    if (!/^https?:\/\//.test(u)) u = `https://${u}`;
    let id = webappId(n);
    for (let i = 2; setup.webapps.some((w) => w.id === id); i++) id = `${webappId(n)}-${i}`;
    setSetup({ webapps: [...setup.webapps, { id, name: n, url: u }] });
    setName("");
    setUrl("");
  };
  const remove = (id: string) => setSetup({ webapps: setup.webapps.filter((w) => w.id !== id), autostart: setup.autostart.filter((k) => k !== `web:${id}`) });
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <Choice on={setup.browserMode === "browser"} onClick={() => setSetup({ browserMode: "browser" })} title="WadBrowser" body="Tabs and an address bar" />
        <Choice on={setup.browserMode === "focus"} onClick={() => setSetup({ browserMode: "focus" })} title="WadBrowser Focus" body="No address bar: pages only arrive by links" />
      </div>
      <div>
        <div className="mb-1.5 text-xs font-medium text-muted">Web apps: each its own window and desktop icon</div>
        <div className="space-y-1">
          {setup.webapps.map((w) => (
            <div key={w.id} className="flex items-center gap-2.5 rounded-xl bg-surface px-2.5 py-1.5 ring-1 ring-line">
              <img src={webappIcon(w.url)} alt="" className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{w.name}</span>
                <span className="block truncate text-[11px] text-muted">{w.url}</span>
              </span>
              <button type="button" onClick={() => remove(w.id)} className="grid size-7 place-items-center rounded-lg text-faint hover:bg-surface-3 hover:text-fg" aria-label={`Remove ${w.name}`}>
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="h-9 !w-32 text-[13px]" aria-label="Web app name" />
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" className="h-9 flex-1 text-[13px]" aria-label="Web app address" />
          <Button size="sm" type="submit" className="h-9" disabled={!name.trim() || !url.trim()}>
            <Plus className="size-3.5" /> Add
          </Button>
        </form>
        <p className="mt-2 text-xs text-faint">Web apps can share one sign-in (a cookie profile) or keep their own: chosen in Step 3.</p>
      </div>
    </div>
  );
}

function VsCodeOptions({ setup, setSetup }: Props) {
  const [custom, setCustom] = useState("");
  const toggle = (id: string, on: boolean) => setSetup({ extensions: on ? [...setup.extensions, id] : setup.extensions.filter((x) => x !== id) });
  const extra = setup.extensions.filter((id) => !EXTENSIONS.some((e) => e.id === id));
  return (
    <div>
      <div className="mb-1.5 text-xs font-medium text-muted">Extensions, installed into the image</div>
      <div className="space-y-0.5">
        {[...EXTENSIONS, ...extra.map(extensionById)].map((e) => (
          <label key={e.id} className="flex cursor-pointer items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-surface">
            <input type="checkbox" checked={setup.extensions.includes(e.id)} onChange={(ev) => toggle(e.id, ev.target.checked)} className="size-4 accent-[var(--accent)]" />
            <span className="min-w-0 flex-1">
              <span className="block text-sm">{e.name}</span>
              <span className="block truncate font-mono text-[11px] text-muted">{e.id}</span>
            </span>
            {e.secret && (
              <Badge tone="accent" className="shrink-0">
                <KeyRound className="size-3" /> Needs a secret
              </Badge>
            )}
          </label>
        ))}
      </div>
      <form
        className="mt-2 flex gap-2"
        onSubmit={(ev) => {
          ev.preventDefault();
          const id = custom.trim().toLowerCase();
          if (id && !setup.extensions.includes(id)) toggle(id, true);
          setCustom("");
        }}
      >
        <Input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="publisher.extension" className="h-9 flex-1 font-mono text-[12px]" aria-label="Extension id" />
        <Button size="sm" type="submit" className="h-9" disabled={!custom.trim()}>
          <Plus className="size-3.5" /> Add
        </Button>
      </form>
      <p className="mt-2 text-xs text-faint">AI extensions that keep a sign-in (Claude Code, Codex) get a secret in Step 3.</p>
    </div>
  );
}

/** Saving Step 2: whether there's anything to save, and what it'd be saved as. */
export function useCustomizeSave() {
  const base = useDraft((s) => s.base);
  const setup = useDraft((s) => s.setup);
  const rebase = useDraft((s) => s.rebase);
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const saveCustomization = useApp((s) => s.saveCustomization);
  const build = useApp((s) => s.build);
  const r = base && resolve({ templates, customizations }, base);
  const dirty = !!(r && setup && !sameSetup(setup, r.setup));
  const empty = !!(setup && sameSetup(setup, emptySetup(setup.templateId)));
  /** Why a new name won't do: changes to a template or a customization are saved under a name of their own. */
  const nameProblem = (name: string) => (!name.trim() ? "Give it a new name" : nameTaken(name, { templates, customizations }) ? `"${name.trim()}" is taken: pick a new name` : null);
  const save = async (name: string, update: boolean) => {
    if (!r || !setup) return;
    try {
      const c = await saveCustomization({ ...setup, id: update ? r.customization?.id : undefined, name, description: update ? (r.customization?.description ?? "") : "" });
      void build(`custom:${c.id}`);
      rebase({ kind: "customization", id: c.id }, c);
      useTour.getState().signal("customization-saved");
      useApp.getState().toast({ title: update ? `Updated ${c.name}` : `Saved ${c.name}`, body: "Building its image.", tone: "success" });
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't save the customization", body: (e as Error).message, tone: "error" });
    }
  };
  return { r, dirty, empty, save, nameProblem, template: r?.template as Template | undefined };
}

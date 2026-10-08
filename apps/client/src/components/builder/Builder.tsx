import { Link, useNavigate } from "react-router";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AppWindow, ArrowLeft, ArrowRight, Bot, Check, Download, Save, Eye, FileCode2, FolderGit2, Hammer, Loader2, LayoutDashboard, Lock, Monitor, Paintbrush, Redo2, Settings2, Undo2, X } from "lucide-react";
import clsx from "clsx";
import { toBuildSpec } from "@core/build";
import { bundleZip, dockerfile as renderDockerfile } from "@core/generator";
import { defaultAdvanced } from "@core/model";
import { backend } from "@/data";
import { clockTime } from "@/lib/format";
import { startBuild } from "@/lib/build";
import { renderWallpaper } from "@/lib/wallpaperRender";
import { useApp } from "@/lib/store";
import { templateById, templateLayout } from "@/lib/templates";
import { useTour } from "@/lib/tour";
import type { Advanced, AgentConfig, Layout, LayoutIcon, Visibility, Wadspace } from "@/lib/types";
import { Desktop, arrangeLayout, iconFromDrag, type DraggedApp } from "../desktop/Desktop";
import { TASKBAR_H, cellToPx, nextFreeCell } from "../desktop/geometry";
import { WALLPAPER_PRESETS } from "../desktop/wallpapers";
import { RunDesktop } from "../RunDesktop";
import { Button, IconButton, Segmented } from "../ui";
import { AdvancedPanel } from "./AdvancedPanel";
import { DockerfileEditor } from "./DockerfileEditor";
import { Catalog } from "./Catalog";
import { Customize, DesktopSettings } from "./Properties";
import { ProjectsPanel } from "./ProjectsPanel";
import { hasLocal } from "@/lib/machine";
import { usePrefetchIcons } from "@/lib/webappIcons";

/** The Builder walks through these in order, then builds. */
type Step = "apps" | "projects" | "customize";
const STEPS: { value: Step; label: string; icon: typeof AppWindow; hint: string }[] = [
  { value: "apps", label: "Apps", icon: AppWindow, hint: "Add your apps to the desktop" },
  { value: "projects", label: "Projects", icon: FolderGit2, hint: "Pick the projects it opens with" },
  { value: "customize", label: "Customize", icon: Paintbrush, hint: "Name it, pick a background, then build" },
];
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";

async function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const blankLayout = (): Layout => ({ wallpaper: WALLPAPER_PRESETS[0].wallpaper, icons: [], grid: true });

function useHistory<T>(initial: T) {
  const [h, setH] = useState({ past: [] as T[], present: initial, future: [] as T[] });
  const commit = useCallback((next: T) => setH((s) => ({ past: [...s.past.slice(-100), s.present], present: next, future: [] })), []);
  const undo = useCallback(() => setH((s) => (s.past.length ? { past: s.past.slice(0, -1), present: s.past[s.past.length - 1], future: [s.present, ...s.future] } : s)), []);
  const redo = useCallback(() => setH((s) => (s.future.length ? { past: [...s.past, s.present], present: s.future[0], future: s.future.slice(1) } : s)), []);
  const reset = useCallback((v: T) => setH({ past: [], present: v, future: [] }), []);
  return { value: h.present, commit, undo, redo, reset, canUndo: h.past.length > 0, canRedo: h.future.length > 0 };
}

/**
 * `agent` opens a new wadspace with an AI agent already added and its tab showing.
 * `template` starts from a Quick Launch template's desktop, apps and agent, ready to customise.
 */
export function Builder({ id, duplicate = false, agent: startWithAgent = false, template, draft }: { id?: string; duplicate?: boolean; agent?: boolean; template?: string; draft?: string }) {
  const navigate = useNavigate();
  const user = useApp((s) => s.user);
  const focus = useApp((s) => s.focus);
  const loadWadspaces = useApp((s) => s.loadWadspaces);
  const tourStep = useTour((s) => s.step);
  const tourSignal = useTour((s) => s.signal);
  const projects = useApp((s) => s.projects);

  const [loading, setLoading] = useState(!!id || !!draft);
  /** The saved draft this session is working on, if any. */
  const [draftId, setDraftId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [, setExisting] = useState<Wadspace | null>(null);
  const initialName = startWithAgent && !id ? "Untitled agent environment" : "Untitled wadspace";
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>("private");
  // AI agents are coming soon: kept on wadspaces that have one, never added here yet.
  const [agent, setAgent] = useState<AgentConfig | undefined>(undefined);
  const [advanced, setAdvanced] = useState<Advanced>(() => defaultAdvanced(tz()));
  const [rightTab, setRightTab] = useState<"desktop" | "advanced" | "agent">(startWithAgent ? "agent" : "desktop");
  const history = useHistory<Layout>(blankLayout());
  const layout = history.value;
  const [saved, setSaved] = useState("");
  const [starting, setStarting] = useState(false);
  const [preview, setPreview] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const [step, setStep] = useState<Step>("apps");
  const stepIndex = STEPS.findIndex((x) => x.value === step);
  /** The center pane: the live desktop, or the raw Dockerfile. */
  const [view, setView] = useState<"desktop" | "dockerfile">("desktop");
  /** A hand-edited Dockerfile; null means it's generated from the desktop. */
  const [dockerfile, setDockerfile] = useState<string | null>(null);

  // The tutorial drives which step is showing.
  useEffect(() => {
    if (tourStep === "apps" || tourStep === "projects") setStep(tourStep);
  }, [tourStep]);

  // Web apps' icons, made on the machine while you design, ready for the build.
  usePrefetchIcons({ layout, advanced });

  const snapshot = JSON.stringify({ name, description, visibility, layout, agent, dockerfile, advanced });
  const dirty = snapshot !== saved;

  // Pick a saved draft back up, on the step it was saved from.
  useEffect(() => {
    if (!draft || id) return;
    (async () => {
      try {
        const d = await backend.getDraft(draft);
        const ws = d.wadspaceId ? await backend.getWadspace(d.wadspaceId).catch(() => null) : null;
        const adv = d.advanced ?? ws?.advanced ?? defaultAdvanced(tz());
        setAdvanced(adv);
        setDraftId(d.id);
        setName(d.name);
        setDescription(d.description);
        setVisibility(d.visibility);
        history.reset(d.layout);
        setAgent(d.agent);
        setDockerfile(d.dockerfile ?? null);
        setStep(d.step);
        if (d.agent?.enabled) setRightTab("agent");
        setEditingId(ws?.id ?? null);
        setExisting(ws);
        setSaved(JSON.stringify({ name: d.name, description: d.description, visibility: d.visibility, layout: d.layout, agent: d.agent, dockerfile: d.dockerfile ?? null, advanced: adv }));
      } catch (e) {
        setLoadError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, id]);

  // Load an existing layout for editing (or duplicating).
  useEffect(() => {
    if (draft && !id) return;
    if (!id) {
      // A fresh agent environment counts as unsaved: the user asked for it but hasn't built it yet.
      setSaved(JSON.stringify({ name: initialName, description: "", visibility: "private", layout: history.value, agent: undefined, dockerfile: null, advanced }));
      return;
    }
    backend
      .getWadspace(id)
      .then((ws) => {
        const own = ws.owner === user?.username && !duplicate;
        const n = own ? ws.name : `Copy of ${ws.name}`;
        const d = ws.description;
        const v = own ? ws.visibility : "private";
        setName(n);
        setDescription(d);
        setVisibility(v);
        history.reset(ws.layout);
        setAgent(ws.agent);
        setDockerfile(ws.dockerfile ?? null);
        setAdvanced(ws.advanced);
        setEditingId(own ? ws.id : null);
        setExisting(own ? ws : null);
        setSaved(own ? JSON.stringify({ name: n, description: d, visibility: v, layout: ws.layout, agent: ws.agent, dockerfile: ws.dockerfile ?? null, advanced: ws.advanced }) : "");
      })
      .catch((e) => setLoadError((e as Error).message))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, duplicate, user?.username]);

  // Start from a Quick Launch template once the app catalog has loaded. Left unsaved on purpose.
  const catalog = useApp((s) => s.apps);
  const appliedTemplate = useRef(false);
  useEffect(() => {
    const t = template && !id ? templateById(template) : undefined;
    if (!t || !catalog.length || appliedTemplate.current) return;
    appliedTemplate.current = true;
    setName(t.name);
    setDescription(t.description);
    history.reset(templateLayout(t, catalog));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template, id, catalog]);

  // Warn before leaving with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Undo / redo shortcuts.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.target as HTMLElement).closest("input, textarea")) return;
      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
      } else if (e.key.toLowerCase() === "y") {
        e.preventDefault();
        history.redo();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [history]);

  // Fit a 16:9 canvas inside the center pane.
  const pane = useRef<HTMLDivElement>(null);
  const [canvas, setCanvas] = useState({ w: 0, h: 0 });
  /** Room in the pane when it isn't held to 16:9 (the Dockerfile editor uses all of it). */
  const [room, setRoom] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = pane.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const pw = e.contentRect.width - 40;
      const ph = e.contentRect.height - 64;
      const w = Math.max(320, Math.min(pw, (ph * 16) / 9));
      setCanvas({ w: Math.floor(w), h: Math.floor((w * 9) / 16) });
      setRoom({ w: Math.floor(pw), h: Math.floor(ph) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [loading]);
  const area = { w: canvas.w, h: canvas.h - TASKBAR_H };

  /** Every layout change goes through here so the tutorial can notice new apps. */
  const commitLayout = useCallback(
    (next: Layout) => {
      const prev = history.value;
      history.commit(next);
      if (next.icons.length > prev.icons.length) tourSignal("app-added");
    },
    [history, tourSignal],
  );

  /** Double-click / "+" in the library: drop the item into the next free grid cell. */
  const addItem = (item: DraggedApp) => {
    const cell = nextFreeCell(layout.icons, area);
    const px = cellToPx(cell.col, cell.row);
    const icon: LayoutIcon = { ...iconFromDrag(item), cell, x: px.x / area.w, y: px.y / area.h };
    commitLayout({ ...layout, icons: [...layout.icons, icon] });
  };

  const arrange = () => commitLayout(arrangeLayout(layout, area));

  const flashWallpaper = () => {
    setStep("customize");
    requestAnimationFrame(() => document.getElementById("wallpaper")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    setHighlight(true);
    setTimeout(() => setHighlight(false), 1400);
  };

  /** Save the wadspace itself (not a draft). */
  const saveWadspace = async () => {
    const body = {
      name: name.trim() || "Untitled wadspace",
      description: description.trim(),
      visibility,
      layout,
      advanced,
      agent,
      dockerfile: dockerfile ?? undefined,
    };
    const ws = editingId ? await backend.patchWadspace(editingId, body) : await backend.createWadspace(body);
    if (!editingId) {
      setEditingId(ws.id);
      // Update the URL without remounting the Builder.
      window.history.replaceState(null, "", `/builder/${ws.id}`);
    }
    setExisting(ws);
    setSaved(JSON.stringify({ name: body.name, description: body.description, visibility, layout, agent, dockerfile, advanced }));
    await loadWadspaces();
    return ws.id;
  };

  /** Keep the work as a draft without building it. It shows up under Drafts in the Wadspaces Manager. */
  const saveDraft = async () => {
    setSaving(true);
    const body = { name: name.trim() || "Untitled wadspace", description, visibility, layout, advanced, agent, dockerfile: dockerfile ?? undefined, step, wadspaceId: editingId ?? undefined };
    try {
      const d = await backend.saveDraft(draftId, body);
      if (!draftId) {
        setDraftId(d.id);
        window.history.replaceState(null, "", `/builder?draft=${d.id}`);
      }
      setSaved(JSON.stringify({ name, description, visibility, layout, agent, dockerfile, advanced }));
      useApp.getState().loadDrafts();
      useApp.getState().toast({ title: "Draft saved", body: "Pick it up any time from Drafts in the Wadspaces Manager.", tone: "success" });
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't save", body: (e as Error).message, tone: "error" });
    } finally {
      setSaving(false);
    }
  };
  const saveRef = useRef(saveDraft);
  saveRef.current = saveDraft;

  // Ctrl+S saves a draft (the Dockerfile editor handles its own Ctrl+S first).
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "s" || e.defaultPrevented) return;
      e.preventDefault();
      saveRef.current();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  /** Save the wadspace, start the image build in the background, and move to the Wadspaces Manager. */
  const build = async () => {
    setStarting(true);
    const rebuild = !!editingId;
    try {
      const wadspaceId = await saveWadspace();
      // Saved as a wadspace now, so the draft has done its job.
      if (draftId) {
        await backend.deleteDraft(draftId).catch(() => {});
        setDraftId(null);
        useApp.getState().loadDrafts();
      }
      const started = await startBuild({ wadspaceId, name: name.trim() || "Untitled wadspace", rebuild });
      if (started) {
        // Hand off to the Wadspaces Manager, where the card shows it building and the
        // wait sheet offers things to do in the meantime.
        useApp.getState().setWaitingFor(wadspaceId);
        navigate("/manager");
      }
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't build", body: (e as Error).message, tone: "error" });
    } finally {
      setStarting(false);
    }
  };
  const building = useApp((s) => s.builds.some((b) => b.wadspaceId === editingId && b.status === "building"));

  if (loading) {
    return (
      <div className="grid h-full place-items-center text-muted">
        <Loader2 className="size-6 animate-spin" />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="max-w-md rounded-3xl border border-line bg-surface p-8 text-center">
          <h2 className="font-display text-xl font-semibold">Can&apos;t open in Builder</h2>
          <p className="mt-2 text-sm text-muted">{loadError}</p>
          <Link to="/builder">
            <Button variant="primary" className="mt-6">Start a new wadspace</Button>
          </Link>
        </div>
      </div>
    );
  }

  const locked = !!focus;
  const plan = toBuildSpec({ id: editingId ?? "new-wadspace", name: name.trim() || "Untitled wadspace", description, layout, advanced, agent }, { wallpaperFile: "wallpaper.png", projects });
  const generated = renderDockerfile(plan.spec);
  const downloadFolder = async () => {
    try {
      const wp = await renderWallpaper(layout.wallpaper);
      const spec = { ...plan.spec, wallpaper: { fileName: wp.fileName, mode: "fill" as const, color: "#0b0b14" } };
      const zip = await bundleZip(spec, new Uint8Array(await wp.blob.arrayBuffer()), dockerfile ?? undefined);
      await downloadBlob(zip, `${spec.id}.zip`);
    } catch (e) {
      useApp.getState().toast({ title: "Couldn't make the build folder", body: (e as Error).message, tone: "error" });
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Top bar */}
      <div className="flex h-16 shrink-0 items-center gap-3 border-b border-line bg-bg-2/60 px-4 backdrop-blur-xl">
        <Link to="/manager" className="grid size-9 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg" aria-label="Back to wadspaces">
          <ArrowLeft className="size-4" />
        </Link>
        <div className="min-w-0 flex-1 basis-0">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">{draftId ? "Draft" : editingId ? "Editing wadspace" : "Wadspace Builder"}</div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-display text-lg font-semibold tracking-tight">{name.trim() || "Untitled wadspace"}</span>
            {dirty && (
              <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
                <span className="size-1.5 rounded-full bg-accent" /> Unsaved
              </span>
            )}
          </div>
        </div>

        {/* Steps */}
        <ol className="flex shrink-0 items-center gap-1 rounded-2xl bg-surface-2/70 p-1 ring-1 ring-line">
          {STEPS.map((x, i) => {
            const on = x.value === step;
            const past = i < stepIndex;
            return (
              <li key={x.value} className="flex items-center gap-1">
                {i > 0 && <span className={clsx("h-px w-4", past || on ? "bg-accent/60" : "bg-line-strong")} />}
                <button
                  type="button"
                  data-tour={`step-${x.value}`}
                  onClick={() => setStep(x.value)}
                  aria-current={on ? "step" : undefined}
                  className={clsx("flex h-8 items-center gap-2 rounded-xl pl-1.5 pr-3 text-[13px] font-medium transition-colors", on ? "bg-surface text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg")}
                >
                  <span className={clsx("grid size-5 place-items-center rounded-full text-[11px] font-bold", on ? "bg-accent text-accent-fg" : past ? "bg-accent/20 text-accent" : "bg-surface-3 text-muted")}>
                    {past ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  {x.label}
                </button>
              </li>
            );
          })}
        </ol>

        <div className="flex flex-1 basis-0 items-center justify-end gap-1">
          <IconButton label="Undo (Ctrl+Z)" disabled={!history.canUndo} onClick={history.undo}>
            <Undo2 className="size-4" />
          </IconButton>
          <IconButton label="Redo (Ctrl+Shift+Z)" disabled={!history.canRedo} onClick={history.redo}>
            <Redo2 className="size-4" />
          </IconButton>
          <div className="mx-1 h-6 w-px bg-line" />
          <Button variant="ghost" onClick={saveDraft} disabled={saving || (!dirty && !!draftId)} title="Save as a draft without building (Ctrl+S)">
            {saving ? <Loader2 className="size-4 animate-spin" /> : !dirty && draftId ? <Check className="size-4" /> : <Save className="size-4" />} {!dirty && draftId ? "Saved" : "Save"}
          </Button>
          <Button
            data-tour="preview"
            onClick={() => {
              setPreview(true);
              tourSignal("preview-opened");
            }}
            disabled={locked}
            title={locked && focus ? `Focus mode: locked until ${clockTime(focus.endsAt)}` : "Test-run the desktop full screen"}
          >
            {locked ? <Lock className="size-4" /> : <Eye className="size-4" />} Preview
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <aside data-tour="library" className="flex w-80 shrink-0 flex-col border-r border-line bg-bg-2/40">
          <div className="border-b border-line px-4 pb-3 pt-4">
            <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-accent">Step {stepIndex + 1} of {STEPS.length}</div>
            <div className="mt-0.5 font-display text-[15px] font-semibold tracking-tight">{STEPS[stepIndex].hint}</div>
          </div>
          <div className={clsx("min-h-0 flex-1", step !== "apps" && "overflow-y-auto")}>
            {step === "apps" ? (
              <Catalog onAdd={addItem} />
            ) : step === "projects" ? (
              <ProjectsPanel value={advanced.projects ?? []} onChange={(ids) => setAdvanced({ ...advanced, projects: ids })} />
            ) : (
              <Customize
                name={name}
                setName={setName}
                description={description}
                setDescription={setDescription}
                visibility={visibility}
                setVisibility={setVisibility}
                layout={layout}
                commit={commitLayout}
                highlightWallpaper={highlight}
              />
            )}
          </div>

          {/* Step navigation; the last step builds. */}
          <div className="shrink-0 border-t border-line bg-bg-2/60 p-3">
            <div className="flex gap-2">
              {stepIndex > 0 && (
                <Button variant="ghost" onClick={() => setStep(STEPS[stepIndex - 1].value)}>
                  <ArrowLeft className="size-4" /> Back
                </Button>
              )}
              {step !== "customize" ? (
                <Button variant="secondary" className="flex-1" onClick={() => setStep(STEPS[stepIndex + 1].value)}>
                  Next: {STEPS[stepIndex + 1].label} <ArrowRight className="size-4" />
                </Button>
              ) : (
                <Button variant="primary" className="flex-1" disabled={!name.trim() || starting || building} onClick={build} title={building ? "This wadspace is already building" : undefined}>
                  {starting ? <Loader2 className="size-4 animate-spin" /> : <Hammer className="size-4" />} {building ? "Building…" : editingId ? "Rebuild" : "Build"}
                </Button>
              )}
            </div>
          </div>
        </aside>

        <div ref={pane} className="relative flex min-w-0 flex-1 flex-col items-center justify-center overflow-hidden bg-[radial-gradient(var(--line)_1px,transparent_1px)] [background-size:18px_18px]">
          {canvas.w > 0 && (
            <>
              <div className="mb-3 flex items-center gap-3 text-xs text-muted" style={{ width: view === "desktop" ? canvas.w : room.w }}>
                <Segmented
                  value={view}
                  onChange={setView}
                  options={[
                    { value: "desktop", label: <><LayoutDashboard className="size-3.5" /> Desktop</> },
                    { value: "dockerfile", label: <><FileCode2 className="size-3.5" /> Dockerfile</> },
                  ]}
                />
                {view === "desktop" ? (
                  <span className="flex items-center gap-2">
                    <span className="relative flex size-2">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
                      <span className="relative inline-flex size-2 rounded-full bg-accent" />
                    </span>
                    Live desktop · drag apps in, double-click to open
                  </span>
                ) : (
                  <span>{hasLocal ? "Edit the container definition directly" : "Generated from the desktop"}</span>
                )}
                {view === "desktop" && (
                  <span className="ml-auto font-mono text-faint">
                    {canvas.w}×{canvas.h}
                  </span>
                )}
              </div>
              {view === "desktop" ? (
                <div data-tour="canvas" className="rounded-[18px] p-1.5 shadow-deep ring-1 ring-line-strong" style={{ background: "linear-gradient(180deg, var(--surface-3), var(--surface))" }}>
                  <Desktop
                    layout={layout}
                    onChange={commitLayout}
                    editable
                    title={name}
                    onWallpaperRequest={flashWallpaper}
                    className="rounded-xl"
                    style={{ width: canvas.w, height: canvas.h }}
                  />
                </div>
              ) : (
                <DockerfileEditor
                  value={dockerfile ?? generated}
                  generated={generated}
                  custom={dockerfile !== null}
                  onSave={(text) => setDockerfile(text === generated ? null : text)}
                  onReset={() => setDockerfile(null)}
                  width={room.w}
                  height={room.h}
                  readOnly={!hasLocal}
                  actions={
                    <Button size="sm" variant="ghost" onClick={downloadFolder} title="The Dockerfile, root/ overlay, compose file and quadlet as a zip">
                      <Download className="size-3.5" /> Build folder
                    </Button>
                  }
                  notice={
                    plan.skipped.length > 0 && (
                      <>Not installed yet: {plan.skipped.map((x) => `${x.label} (${x.reason.toLowerCase()})`).join(" · ")}</>
                    )
                  }
                />
              )}
            </>
          )}
        </div>

        <aside className={clsx("flex shrink-0 flex-col border-l border-line bg-bg-2/40", rightTab === "advanced" ? "w-[340px]" : "w-72")}>
          <div className="px-3 pt-3">
            <Segmented
              value={rightTab}
              onChange={setRightTab}
              className="w-full"
              options={[
                { value: "desktop", label: <><Monitor className="size-3.5" /> Desktop</> },
                { value: "advanced", label: <><Settings2 className="size-3.5" /> Advanced</> },
                { value: "agent", label: <><Bot className="size-3.5" /> Agent</> },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1">
            {rightTab === "agent" ? (
              <AgentSoon />
            ) : rightTab === "advanced" ? (
              <AdvancedPanel value={advanced} onChange={setAdvanced} offline={hasLocal} />
            ) : (
              <DesktopSettings layout={layout} commit={commitLayout} onArrange={arrange} />
            )}
          </div>
        </aside>
      </div>


      <AnimatePresence>
        {preview && <PreviewOverlay layout={layout} title={name} onClose={() => setPreview(false)} />}
      </AnimatePresence>
    </div>
  );
}

function AgentSoon() {
  return (
    <div className="p-4">
      <div className="rounded-2xl border border-dashed border-line-strong p-5 text-center">
        <Bot className="mx-auto size-6 text-accent" />
        <div className="mt-2 text-sm font-semibold">AI agents are coming soon</div>
        <p className="mt-1 text-xs text-muted">
          Soon a wadspace can start Claude Code, Codex, Gemini CLI and others with a prompt and instructions, in their own sandbox. For now, add Claude Code from the
          catalog to have it on the desktop.
        </p>
      </div>
    </div>
  );
}

function PreviewOverlay({ layout, title, onClose }: { layout: Layout; title: string; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <motion.div initial={{ opacity: 0, scale: 0.98 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.98 }} data-tour="preview-overlay" className="fixed inset-0 z-[60] bg-[#0a0614]">
      <RunDesktop layout={layout} title={title} />
      <button
        type="button"
        onClick={onClose}
        className="fixed right-4 top-4 z-[10001] flex items-center gap-2 rounded-xl border border-white/10 bg-[#0a0614]/80 px-3 py-2 text-sm text-white backdrop-blur-xl hover:bg-[#0a0614]"
      >
        <X className="size-4" /> Exit preview <kbd className="rounded bg-white/10 px-1.5 text-[11px] text-white/60">Esc</kbd>
      </button>
    </motion.div>
  );
}

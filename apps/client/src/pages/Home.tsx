// Home: a greeting and the numbers (wadspaces, running, machines online),
// Jump back in (the last launch again, a focus session's too), what's running
// now (to show or stop), and your templates as the Builder stacks them, each
// opening its picker there.
import { Link, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, GraduationCap, Play, Radio, Square, Timer, Wand2 } from "lucide-react";
import clsx from "clsx";
import { stacks, type Wadspace } from "@core/layers";
import { Page } from "@/components/Page";
import { Thumb } from "@/components/Thumb";
import { Badge, Button } from "@/components/ui";
import { openStack, TemplateStack } from "@/components/wadbuilder/StepTemplate";
import { backend } from "@/data";
import { DEFAULT_BROWSER_APPS, DEFAULT_BROWSERS, type RunItem } from "@/data/layers";
import { timeAgo, uptime } from "@/lib/format";
import { openFocusWindow, openWadspace } from "@/lib/launch";
import { alive, isLocked, useApp } from "@/lib/store";
import { useTour } from "@/lib/tour";
import type { LastSession } from "@/lib/types";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export default function HomePage() {
  const user = useApp((s) => s.user);
  const wadspaces = useApp((s) => s.wadspaces);
  const machines = useApp((s) => s.machines);
  const focus = useApp((s) => s.focus);
  const loadMachines = useApp((s) => s.loadMachines);
  const loadLastSession = useApp((s) => s.loadLastSession);
  const startTour = useTour((s) => s.start);
  const touring = useTour((s) => !!s.step);
  const [hello, setHello] = useState("Welcome");
  useEffect(() => setHello(greeting()), []);

  // Coming back to the window: what ran meanwhile.
  useEffect(() => {
    const refresh = () => {
      loadLastSession().catch(() => {});
      loadMachines().catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadLastSession, loadMachines]);

  const live = alive(wadspaces);
  const running = machines.flatMap((m) => m.containers.filter((c) => c.status === "running").map((c) => ({ m, c, w: live.find((w) => w.id === c.wadspaceId) })));
  const stats = [
    { label: "Wadspaces", value: live.length, href: "/builder" },
    { label: "Running", value: running.length, href: "/machines" },
    { label: "Machines online", value: machines.filter((m) => m.status === "online").length, href: "/machines" },
  ];

  const toast = useApp((s) => s.toast);
  const stop = async (machineId: string, cid: string) => {
    try {
      await backend.container(machineId, cid, "stop");
    } catch (e) {
      toast({ title: "Couldn't stop", body: (e as Error).message, tone: "error" });
    }
    loadMachines();
  };

  return (
    <Page className="lg:py-6">
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-accent">{hello},</p>
          <h1 className="mt-0.5 font-display text-3xl font-bold tracking-tight">{user?.displayName ?? "…"}</h1>
          <button type="button" onClick={() => user && startTour(user.username)} disabled={touring} className="mt-2 flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-fg disabled:opacity-40">
            <GraduationCap className="size-4" /> New here? Take the tour
          </button>
        </div>
        <div className="grid w-full grid-cols-3 gap-2 lg:flex lg:w-auto lg:flex-wrap">
          {stats.map((s) => (
            <Link key={s.label} to={s.href} className="min-w-0 rounded-2xl border border-line bg-surface/70 px-4 py-2.5 transition-colors hover:border-line-strong hover:bg-surface-2 lg:min-w-28">
              <div className="font-display text-2xl font-bold tabular-nums leading-none">{s.value}</div>
              <div className="mt-1 text-[11px] font-medium uppercase leading-tight tracking-wider text-faint">{s.label}</div>
            </Link>
          ))}
        </div>
      </motion.div>

      <div className="flex flex-col gap-10">
        <section>
          <SectionHead title="Jump back in" href="/builder" cta="All in the Builder" />
          <JumpBackIn />
        </section>

        <section>
          <SectionHead title="Running now" href="/machines" cta="Machines" />
          {running.length ? (
            <div className="space-y-2">
              {running.map(({ m, c, w }) => (
                <div key={c.id} className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-2 pr-4">
                  {w ? <Thumb w={w} className="!w-24 rounded-xl" /> : <div className="aspect-video w-24 rounded-xl bg-surface-2" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-display font-semibold">{w?.name ?? c.wadspaceId}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                      <span className="size-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
                      {m.label} · {c.onScreen ? "on screen" : c.mode === "stream" ? "streamed display" : "in the background"} · up {uptime(c.startedAt)}
                    </div>
                  </div>
                  {w && !c.onScreen && (
                    <Button size="sm" disabled={isLocked(focus, w.id)} onClick={() => void openWadspace(w)}>
                      Show
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => stop(m.id, c.id)}>
                    <Square className="size-3 fill-current" /> Stop
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex items-center gap-3 rounded-2xl border border-dashed border-line-strong px-4 py-4 text-sm text-muted">
              <Radio className="size-4 shrink-0 text-faint" />
              Nothing running. Launch a wadspace and it&apos;ll show up here.
            </div>
          )}
        </section>

        <YourTemplates />
      </div>
    </Page>
  );
}

/** Your template stacks, as Step 1 shows them (four at most): each opens its picker in the Builder. */
function YourTemplates() {
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const wadspaces = useApp((s) => s.wadspaces);
  const navigate = useNavigate();
  const all = stacks({ templates, customizations, wadspaces });
  return (
    <section>
      <SectionHead title="Your templates" href="/builder" cta="All in the Builder" />
      <div className="grid gap-x-6 gap-y-8 md:grid-cols-2 xl:grid-cols-4">
        {all.slice(0, 4).map((s) => (
          <TemplateStack
            key={s.template.id}
            stack={s}
            onOpen={() => {
              openStack(s);
              navigate("/builder");
            }}
          />
        ))}
        {!all.length && (
          <Link to="/builder" className="flex aspect-[16/10] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-line-strong text-muted hover:border-accent/60 hover:text-fg">
            <Wand2 className="size-7" />
            <span className="text-sm font-semibold">Build your own template</span>
          </Link>
        )}
      </div>
    </section>
  );
}

const duration = (min: number) => (min >= 1 ? `${Math.round(min)} min` : `${Math.round(min * 60)} sec`);

/** What the last launch started, as the launcher starts it: wadspaces, then
 *  the machine's own apps (WadBrowsers, saved setups, the terminal). */
function lastItems(session: LastSession, wadspaces: Wadspace[]): { items: RunItem[]; spaces: Wadspace[] } {
  const { browsers } = useApp.getState();
  const apps = Object.fromEntries(Object.entries(DEFAULT_BROWSER_APPS).map(([id, app]) => [app, DEFAULT_BROWSERS.find((b) => b.id === id)!]));
  const items: RunItem[] = [];
  const spaces: Wadspace[] = [];
  for (const id of session.wadspaceIds) {
    const w = wadspaces.find((x) => x.id === id);
    if (w) {
      spaces.push(w);
      items.push({ kind: "wadspace", wadspaceId: w.id });
    } else if (id === "terminal") items.push({ kind: "terminal" });
    else if (apps[id]) items.push({ kind: "browser", config: apps[id] });
    else {
      const b = id.startsWith("browser-") && browsers.find((x) => x.id === id.slice(8) && !x.deletedAt);
      if (b) items.push({ kind: "browser", config: { id: b.id, name: b.name, mode: b.mode, webapps: b.webapps, secrets: b.secrets }, savedId: b.id });
    }
  }
  return { items, spaces };
}

/** The last launch, ready to go again exactly as it was. */
function JumpBackIn() {
  const session = useApp((s) => s.lastSession);
  const wadspaces = useApp((s) => s.wadspaces);
  const machines = useApp((s) => s.machines);
  const focus = useApp((s) => s.focus);
  const launch = useApp((s) => s.launch);
  const [busy, setBusy] = useState(false);
  const { items, spaces } = session ? lastItems(session, alive(wadspaces)) : { items: [], spaces: [] };

  if (!session || !items.length) {
    return (
      <div className="flex flex-wrap items-center gap-4 rounded-3xl border border-dashed border-line-strong p-5">
        <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
          <Wand2 className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">Nothing to jump back into yet</h3>
          <p className="mt-0.5 text-sm text-muted">Launch a wadspace and it&apos;ll be waiting here next time.</p>
        </div>
        <Link to="/builder">
          <Button variant="primary">
            Open the Builder <ArrowRight className="size-4" />
          </Button>
        </Link>
      </div>
    );
  }

  const isFocus = session.kind === "focus";
  const machine = machines.find((m) => m.id === session.machineId);
  const offline = !!machine && machine.status !== "online";
  const names = [...spaces.map((w) => w.name), ...items.filter((i) => i.kind !== "wadspace").map((i) => (i.kind === "browser" ? i.config.name : "Terminal"))];
  const title = names.length === 1 ? names[0] : `${names.length} together`;
  const sameFocus = !!focus && isFocus && focus.wadspaceIds.join() === session.wadspaceIds.join();
  const mins = session.minutes ?? 25;
  const again = async () => {
    setBusy(true);
    await launch(items, isFocus ? mins : null);
    setBusy(false);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-5 rounded-3xl border border-line bg-surface p-3 sm:flex-row sm:items-center sm:pr-6">
      <Preview list={spaces} />
      <div className="min-w-0 flex-1 sm:py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {isFocus && (
            <Badge tone="accent">
              <Timer className="size-3" /> {duration(mins)} focus
            </Badge>
          )}
          <Badge>{machine?.label ?? "This machine"}</Badge>
        </div>
        <h3 className="mt-2 truncate font-display text-2xl font-bold tracking-tight">{title}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-muted">{names.length > 1 ? names.join(" · ") : spaces[0]?.description || "On the machine"}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {sameFocus ? (
            <Button variant="primary" onClick={openFocusWindow}>
              <Timer className="size-4" /> Open focus window
            </Button>
          ) : (
            <Button variant="primary" disabled={busy || offline || (!!focus && isFocus) || spaces.some((w) => isLocked(focus, w.id))} title={offline ? "That machine is offline" : undefined} onClick={() => void again()}>
              <Play className="size-4 fill-current" /> {isFocus ? `Start ${duration(mins)} focus again` : "Jump back in"}
            </Button>
          )}
          <span className="text-xs text-faint">Last used {timeAgo(session.at)}</span>
        </div>
      </div>
    </motion.div>
  );
}

/** One big thumbnail, or tiles for several. */
function Preview({ list }: { list: Wadspace[] }) {
  if (!list.length) return <div className="grid aspect-video shrink-0 place-items-center rounded-2xl bg-surface-2 sm:w-64 xl:w-72"><img src="/brand/wadbrowser-icon-dark.svg" alt="" className="size-14" /></div>;
  if (list.length === 1) return <Thumb w={list[0]} className="shrink-0 rounded-2xl sm:!w-64 xl:!w-72" />;
  const shown = list.slice(0, 4);
  return (
    <div className={clsx("grid aspect-video shrink-0 gap-1 overflow-hidden rounded-2xl sm:w-64 xl:w-72", shown.length === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2")}>
      {shown.map((w, i) => (
        <div key={w.id} className={clsx("relative min-h-0 overflow-hidden", shown.length === 3 && i === 0 && "row-span-2")}>
          <Thumb w={w} className="!aspect-auto h-full" />
        </div>
      ))}
    </div>
  );
}

function SectionHead({ title, href, cta }: { title: string; href: string; cta: string }) {
  return (
    <div className="mb-3 flex shrink-0 items-center justify-between">
      <h2 className="font-display text-lg font-semibold tracking-tight">{title}</h2>
      <Link to={href} className="flex items-center gap-1 text-sm font-medium text-muted transition-colors hover:text-fg">
        {cta} <ArrowRight className="size-3.5" />
      </Link>
    </div>
  );
}

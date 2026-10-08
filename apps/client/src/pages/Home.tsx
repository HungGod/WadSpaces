import { Link } from "react-router";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Bot, GraduationCap, Play, Radio, Rocket, Server, Square, Timer, Wand2 } from "lucide-react";
import clsx from "clsx";
import { Page } from "@/components/Page";
import { Thumb } from "@/components/Thumb";
import { AppTile } from "@/components/AppTile";
import { QuickPicks } from "@/components/QuickPicks";
import { Badge, Button } from "@/components/ui";
import { runtimeLabel } from "@/lib/agent";
import { backend } from "@/data";
import { timeAgo, uptime } from "@/lib/format";
import { openFocusWindow, openWadspace, startFocus } from "@/lib/launch";
import { isLocked, useApp } from "@/lib/store";
import { useTour } from "@/lib/tour";
import type { App, LastSession, Wadspace } from "@/lib/types";

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

const USE_CASES = [
  { icon: Rocket, title: "Quick launch", body: "Spin up a pre-made wadspace in seconds, then throw it away.", href: "/launch", tone: "accent" },
  { icon: Wand2, title: "Build a wadspace", body: "Pick the apps, files and wallpaper for a desktop of your own.", href: "/builder", tone: "accent-2" },
  { icon: Server, title: "Run on other machines", body: "Start wadspaces on your other computers and watch their load.", href: "/manager", tone: "accent" },
] as const;

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

  // Launches happen in popups, so refresh when the user comes back to this tab.
  useEffect(() => {
    const refresh = () => {
      loadLastSession().catch(() => {});
      loadMachines().catch(() => {});
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadLastSession, loadMachines]);

  const running = machines.flatMap((m) => m.containers.filter((c) => c.status === "running").map((c) => ({ m, c, ws: wadspaces.find((w) => w.id === c.wadspaceId) })));
  const me = user?.username ?? "";
  const mine = wadspaces.filter((w) => w.owner === me || w.sharedWith.includes(me));
  const stats = [
    { label: "Wadspaces", value: mine.length, href: "/manager" },
    { label: "Running", value: running.length, href: "/manager" },
    { label: "Machines online", value: machines.filter((m) => m.status === "online").length, href: "/manager" },
    { label: "AI agents", value: mine.filter((w) => w.agent?.enabled).length, href: "/launch?category=ai" },
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
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-accent">{hello},</p>
          <h1 className="mt-0.5 font-display text-3xl font-bold tracking-tight">{user?.displayName ?? "…"}</h1>
        </div>
        <div className="grid w-full grid-cols-2 gap-2 sm:grid-cols-4 lg:flex lg:w-auto lg:flex-wrap">
          {stats.map((s) => (
            <Link key={s.label} to={s.href} className="min-w-0 rounded-2xl border border-line bg-surface/70 px-4 py-2.5 transition-colors hover:border-line-strong hover:bg-surface-2 lg:min-w-28">
              <div className="font-display text-2xl font-bold tabular-nums leading-none">{s.value}</div>
              <div className="mt-1 text-[11px] font-medium uppercase leading-tight tracking-wider text-faint">{s.label}</div>
            </Link>
          ))}
        </div>
      </motion.div>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }} className="mb-8 grid gap-3 md:grid-cols-2">
        <AiLaunchCard />
        <FocusLaunchCard />
      </motion.div>

      <section className="mb-8">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold tracking-tight">What do you want to do?</h2>
          <button type="button" onClick={() => user && startTour(user.username)} disabled={touring} className="flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-fg disabled:opacity-40">
            <GraduationCap className="size-4" /> New here? Take the tour
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {USE_CASES.map((u, i) => {
            const body = (
              <>
                <span className={clsx("grid size-10 shrink-0 place-items-center rounded-xl ring-1", u.tone === "accent" ? "bg-accent-soft text-accent ring-accent/25" : "bg-accent-2-soft text-fg ring-accent-2/40")}>
                  <u.icon className="size-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-display font-semibold">
                    {u.title}
                    <ArrowRight className="size-3.5 -translate-x-1 opacity-0 transition-all group-hover:translate-x-0 group-hover:opacity-100" />
                  </span>
                  <span className="mt-0.5 block text-[13px] leading-snug text-muted">{u.body}</span>
                </span>
              </>
            );
            const cls = "group flex w-full items-start gap-3.5 rounded-2xl border border-line bg-surface p-4 text-left transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-line-strong hover:shadow-glow disabled:pointer-events-none disabled:opacity-50";
            return (
              <motion.div key={u.title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                <Link to={u.href} className={cls}>
                  {body}
                </Link>
              </motion.div>
            );
          })}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="flex min-w-0 flex-col gap-8">
          <section>
            <SectionHead title="Jump back in" href="/manager" cta="All wadspaces" />
            <JumpBackIn />
          </section>

          <section>
            <SectionHead title="Running now" href="/manager" cta="Wadspaces Manager" />
            {running.length ? (
              <div className="space-y-2">
                {running.map(({ m, c, ws }) => (
                  <div key={c.id} className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-2 pr-4">
                    {ws ? <Thumb ws={ws} className="!w-24 rounded-xl" /> : <div className="aspect-video w-24 rounded-xl bg-surface-2" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-display font-semibold">{ws?.name ?? "Unknown wadspace"}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted">
                        <span className="size-1.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]" />
                        {m.label} · {c.onScreen ? "on screen" : c.mode === "stream" ? "streamed display" : "in the background"} · up {uptime(c.startedAt)}
                      </div>
                    </div>
                    {ws && !c.onScreen && (
                      <Button size="sm" disabled={isLocked(focus, ws.id)} onClick={() => openWadspace(ws, m.id)}>
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
                Nothing running. Open a wadspace and it&apos;ll show up here.
              </div>
            )}
          </section>
        </div>

        <aside className="flex flex-col gap-6">
          <QuickPicks />
        </aside>
      </div>
    </Page>
  );
}

const HARNESSES = ["claude", "codex", "deepseek", "gemini-cli"];

const FOCUS_APPS = ["obsidian", "notion", "spotify", "zotero"];

/** Under the stats: straight into the AI coding harnesses. */
function AiLaunchCard() {
  return (
    <PromoCard
      href="/launch?category=ai"
      appIds={HARNESSES}
      tone="accent"
      eyebrow={<><Bot className="size-3" /> AI agents</>}
      title="Quick launch an AI Agent"
      body="Create a secure sandbox environment for your most daring AI project. Keep your files, throw out the workspace when you're done."
      cta="Launch an agent now"
    />
  );
}

/** Beside the AI card: into the focus templates. */
function FocusLaunchCard() {
  return (
    <PromoCard
      href="/launch?category=focus"
      appIds={FOCUS_APPS}
      tone="accent-2"
      eyebrow={<><Timer className="size-3" /> Focus</>}
      title="Get started on some deep work"
      body="Choose from 100s of ready made templates to build your isolated space and get started on some much needed distraction free work today."
      cta="Find your focus space"
    />
  );
}

function PromoCard({ href, appIds, tone, eyebrow, title, body, cta }: { href: string; appIds: string[]; tone: "accent" | "accent-2"; eyebrow: React.ReactNode; title: string; body: string; cta: string }) {
  const apps = useApp((s) => s.apps);
  const icons = appIds.map((id) => apps.find((a) => a.id === id)).filter((a): a is App => !!a);
  const green = tone === "accent";
  return (
    <Link
      to={href}
      className={clsx(
        "group relative isolate flex flex-col gap-4 overflow-hidden rounded-3xl p-5 transition-[box-shadow,transform] duration-300 hover:-translate-y-0.5 sm:p-6",
        green ? "bg-accent text-accent-fg hover:shadow-glow" : "bg-accent-2 text-accent-2-fg hover:shadow-[0_14px_40px_-10px_rgb(255_61_129_/_0.55)]",
      )}
    >
      {/* Sheen, a soft orb and a dot grid give the flat brand color some depth. */}
      <span className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-br from-white/30 via-transparent to-black/20" />
      <span className="pointer-events-none absolute -right-12 -top-20 -z-10 size-56 rounded-full bg-white/25 blur-3xl transition-transform duration-500 group-hover:scale-125" />
      <span
        className="pointer-events-none absolute inset-y-0 right-0 -z-10 w-1/2 opacity-[0.14] [mask-image:linear-gradient(to_left,black,transparent)]"
        style={{ backgroundImage: "radial-gradient(currentColor 1px, transparent 1px)", backgroundSize: "12px 12px" }}
      />

      <div className="flex items-center gap-4 sm:gap-6">
      <div className="min-w-0 flex-1">
        <span className="inline-flex items-center gap-1 rounded-full bg-current/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.12em] ring-1 ring-current/15">{eyebrow}</span>
        <div className="mt-2.5 font-display text-lg font-bold leading-tight tracking-tight sm:text-xl">{title}</div>
        <p className="mt-1.5 max-w-md text-[13px] font-medium leading-snug opacity-75">{body}</p>
      </div>

      {/* The apps inside, stacked like a deck down the right edge. */}
      <div className="flex shrink-0 flex-col justify-center -space-y-3">
        {icons.map((a, i) => (
          <AppTile
            key={a.id}
            app={a}
            size={40}
            className={clsx("shadow-md ring-2 transition-transform duration-300 group-hover:-translate-x-1", green ? "!ring-accent" : "!ring-accent-2")}
            style={{ transitionDelay: `${i * 40}ms`, zIndex: icons.length - i }}
          />
        ))}
      </div>
      </div>

      <span className="mt-auto self-start text-[13px] font-bold underline decoration-current/35 decoration-2 underline-offset-[5px] transition-[text-decoration-color] group-hover:decoration-current">{cta}</span>
    </Link>
  );
}

const duration = (min: number) => (min >= 1 ? `${Math.round(min)} min` : `${Math.round(min * 60)} sec`);

/** The one configuration the user last launched, ready to relaunch exactly as it was. */
function JumpBackIn() {
  const session = useApp((s) => s.lastSession);
  const wadspaces = useApp((s) => s.wadspaces);
  const machines = useApp((s) => s.machines);
  const focus = useApp((s) => s.focus);

  const list = (session?.wadspaceIds ?? []).map((id) => wadspaces.find((w) => w.id === id)).filter((w): w is Wadspace => !!w);

  if (!session || !list.length) {
    return (
      <div className="flex flex-wrap items-center gap-4 rounded-3xl border border-dashed border-line-strong p-5">
        <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
          <Wand2 className="size-6" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">Nothing to jump back into yet</h3>
          <p className="mt-0.5 text-sm text-muted">Launch or build a wadspace and it&apos;ll be waiting here next time.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link to="/launch">
            <Button>
              <Rocket className="size-4" /> Quick launch
            </Button>
          </Link>
          <Link to="/builder">
            <Button variant="primary">
              Open the Builder <ArrowRight className="size-4" />
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  const isFocus = session.kind === "focus";
  const machine = machines.find((m) => m.id === session.machineId);
  const agents = list.filter((w) => w.agent?.enabled);
  const title = isFocus ? (list.length === 1 ? list[0].name : `${list.length} wadspaces`) : list[0].name;
  const sameFocus = !!focus && isFocus && focus.wadspaceIds.join() === session.wadspaceIds.join();

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-5 rounded-3xl border border-line bg-surface p-3 sm:flex-row sm:items-center sm:pr-6">
      <Preview list={list} />
      <div className="min-w-0 flex-1 sm:py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {isFocus && (
            <Badge tone="accent">
              <Timer className="size-3" /> {duration(session.minutes ?? 25)} focus
            </Badge>
          )}
          {agents.map((w) => (
            <Badge key={w.id} tone="accent-2">
              <Bot className="size-3" /> {runtimeLabel(w.agent!)}
            </Badge>
          ))}
          <Badge>{machine?.label ?? "This machine"}</Badge>
        </div>
        <h3 className="mt-2 truncate font-display text-2xl font-bold tracking-tight">{title}</h3>
        <p className="mt-1 line-clamp-2 text-sm text-muted">{isFocus && list.length > 1 ? list.map((w) => w.name).join(" · ") : list[0].agent?.enabled && list[0].agent.prompt ? `“${list[0].agent.prompt}”` : list[0].description || "No description"}</p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <ResumeButton session={session} list={list} sameFocus={sameFocus} offline={!!machine && machine.status !== "online"} />
          <span className="text-xs text-faint">Last used {timeAgo(session.at)}</span>
        </div>
      </div>
    </motion.div>
  );
}

function ResumeButton({ session, list, sameFocus, offline }: { session: LastSession; list: Wadspace[]; sameFocus: boolean; offline: boolean }) {
  const focus = useApp((s) => s.focus);
  const [busy, setBusy] = useState(false);

  if (sameFocus) {
    return (
      <Button variant="primary" onClick={openFocusWindow}>
        <Timer className="size-4" /> Open focus window
      </Button>
    );
  }
  if (session.kind === "focus") {
    const mins = session.minutes ?? 25;
    return (
      <Button
        variant="primary"
        disabled={!!focus || busy}
        title={focus ? "A focus session is already running" : undefined}
        onClick={async () => {
          setBusy(true);
          await startFocus(list.map((w) => w.id), mins);
          setBusy(false);
        }}
      >
        <Play className="size-4 fill-current" /> Start {duration(mins)} focus again
      </Button>
    );
  }
  const ws = list[0];
  return (
    <Button variant="primary" disabled={isLocked(focus, ws.id) || offline} title={offline ? "That machine is offline" : undefined} onClick={() => openWadspace(ws, session.machineId)}>
      <Play className="size-4 fill-current" /> Jump back in
    </Button>
  );
}

/** One big thumbnail, or a tiled stack for multi-wadspace focus sessions. */
function Preview({ list }: { list: Wadspace[] }) {
  if (list.length === 1) return <Thumb ws={list[0]} className="shrink-0 rounded-2xl sm:!w-64 xl:!w-72" />;
  const shown = list.slice(0, 4);
  return (
    <div className={clsx("grid aspect-video shrink-0 gap-1 overflow-hidden rounded-2xl sm:w-64 xl:w-72", shown.length === 2 ? "grid-cols-2" : "grid-cols-2 grid-rows-2")}>
      {shown.map((w, i) => (
        <div key={w.id} className={clsx("relative min-h-0 overflow-hidden", shown.length === 3 && i === 0 && "row-span-2")}>
          <Thumb ws={w} className="!aspect-auto h-full" />
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

import { Link, useLocation, useNavigate } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AppWindow, ChevronsLeft, ChevronsRight, FolderGit2, Home, KeyRound, LayoutGrid, Loader2, Lock, LogOut, Play, Rocket, Server, Square, Wand2 } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { wadd } from "@/lib/wadd";
import { countdown } from "@/lib/format";
import { openFocusWindow, openWadspace } from "@/lib/launch";
import { THIS_MACHINE, isLocked, useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";
import { useTour } from "@/lib/tour";
import type { PublicUser, Wadspace } from "@/lib/types";
import { APP_PRODUCTS, LogoMark, ProductMark } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { Toaster } from "./Toaster";
import { useFocusPolling, useFocusRemaining } from "./useFocusClock";
import { StartDialog } from "./StartDialog";
import { EditWadspaceDialog } from "./EditWadspaceDialog";
import { WadspaceDrawer } from "./WadspaceDrawer";
import { Tour } from "./Tour";
import { WaitSheet } from "./WaitSheet";
import { RunDialog } from "./RunDialog";
import { ActivityTray, BuildLog } from "./ActivityTray";
import { ProfileNotices } from "./ProfileNotices";

const NAV = [
  { href: "/", label: "Home", icon: Home },
  { href: "/manager", label: "Wadspaces Manager", icon: Server },
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  { href: "/secrets", label: "Secrets", icon: KeyRound },
  { href: "/launch", label: "Quick Launch", icon: Rocket },
  { href: "/builder", label: "Builder", icon: Wand2 },
];

export function Shell({ user, children }: { user: PublicUser; children: React.ReactNode }) {
  const pathname = useLocation().pathname;
  const navigate = useNavigate();
  const setUser = useApp((s) => s.setUser);
  const loadAll = useApp((s) => s.loadAll);
  const [collapsed, setCollapsed] = useState(false);
  const startTour = useTour((s) => s.start);

  // New accounts get the tutorial (resuming where they left off after a reload).
  useEffect(() => {
    if (user.onboarded === false) startTour(user.username, true);
  }, [user.username, user.onboarded, startTour]);

  useEffect(() => {
    setUser(user);
    loadAll().catch(() => {});
    try {
      setCollapsed(localStorage.getItem("ws-sidebar") === "collapsed");
    } catch {}
  }, [user, setUser, loadAll]);

  useFocusPolling();

  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem("ws-sidebar", c ? "open" : "collapsed");
      } catch {}
      return !c;
    });
  };

  const logout = async () => {
    await backend.signOut();
    setUser(null);
    navigate("/login", { replace: true });
  };
  const offline = backend.target === "offline";
  // The kiosk's own Home screen (Super+0 does the same).
  const kioskHome = () => wadd.launcher().catch((e) => useApp.getState().toast({ title: "Couldn't show Home", body: (e as Error).message, tone: "error" }));

  // The builder needs the room: auto-collapse there without changing the saved preference.
  const inBuilder = pathname.startsWith("/builder");
  const narrow = collapsed || inBuilder;

  const isActive = (href: string) => (href === "/" ? pathname === "/" : pathname.startsWith(href));

  return (
    <div className="ws-backdrop flex h-screen overflow-hidden">
      <motion.aside
        animate={{ width: narrow ? 76 : 248 }}
        transition={{ type: "spring", stiffness: 400, damping: 40 }}
        className="relative z-20 flex shrink-0 flex-col border-r border-line bg-bg-2/80 backdrop-blur-xl"
      >
        {/* Brand */}
        <Link to="/" className={clsx("flex h-[72px] items-center gap-2.5 overflow-hidden", narrow ? "justify-center" : "px-4")}>
          <LogoMark className="size-11 shrink-0" />
          {/* No exit animation: the lockup must leave at once so the mark can center in the narrow rail. */}
          {!narrow && (
            <motion.div initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col leading-none">
              <span className="font-display text-[22px] font-bold tracking-[0.08em] text-fg dark:text-accent">WAD</span>
              <span className="my-[3px] h-[3px] w-full bg-fg dark:bg-accent-2" />
              <span className="font-display text-[10.5px] font-bold tracking-[0.42em] text-fg">SPACES</span>
            </motion.div>
          )}
        </Link>

        {/* Nav */}
        <nav className="mt-2 flex flex-col gap-1 px-3">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                to={href}
                data-tour={href === "/builder" ? "nav-builder" : href === "/projects" ? "nav-projects" : undefined}
                title={narrow ? label : undefined}
                className={clsx(
                  "relative flex h-10 items-center gap-3 rounded-xl text-sm font-medium transition-colors",
                  narrow ? "justify-center" : "px-3",
                  active ? "text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                {active && (
                  <motion.span layoutId="nav-active" className="absolute inset-0 rounded-xl bg-surface-2 ring-1 ring-line-strong" transition={{ type: "spring", stiffness: 500, damping: 40 }}>
                    <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-x-[13px] -translate-y-1/2 rounded-r-full bg-accent" />
                  </motion.span>
                )}
                <Icon className={clsx("relative size-[18px] shrink-0", active && "text-accent")} />
                {!narrow && <span className="relative truncate">{label}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="mt-auto flex flex-col gap-3 p-3">
          <ActivityTray narrow={narrow} />
          {offline && (
            <button
              type="button"
              onClick={kioskHome}
              title="Back to this machine's Home screen (Super+0)"
              className={clsx("flex h-10 items-center gap-3 rounded-xl text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg", narrow ? "justify-center" : "px-3")}
            >
              <LayoutGrid className="size-[18px] shrink-0" />
              {!narrow && <span className="truncate">Home screen</span>}
            </button>
          )}
          {backend.target !== "online" && <MachineApps narrow={narrow} />}
          {backend.target !== "online" && <StartButton narrow={narrow} />}
          {narrow ? <div className="flex justify-center"><ThemeToggle compact /></div> : <ThemeToggle />}

          <div className={clsx("flex items-center gap-2.5 rounded-2xl p-1.5", narrow ? "justify-center" : "bg-surface/60 ring-1 ring-line")}>
            <ProfileNotices user={user} />
            {!narrow && (
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-sm font-semibold">{user.displayName}</div>
                <div className="truncate text-xs text-faint">{offline ? "This machine" : `@${user.username}`}</div>
              </div>
            )}
            {!narrow && !offline && (
              <button type="button" onClick={logout} className="grid size-8 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg" title="Sign out" aria-label="Sign out">
                <LogOut className="size-4" />
              </button>
            )}
          </div>
        </div>

        {!inBuilder && <button
          type="button"
          onClick={toggle}
          aria-label={narrow ? "Expand sidebar" : "Collapse sidebar"}
          className="absolute -right-3 top-[26px] grid size-6 place-items-center rounded-full border border-line-strong bg-surface text-muted shadow hover:text-fg"
        >
          {narrow ? <ChevronsRight className="size-3.5" /> : <ChevronsLeft className="size-3.5" />}
        </button>}
      </motion.aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <FocusBanner />
        <main className="relative min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain">{children}</main>
      </div>

      <WadspaceDrawer />
      <StartDialog />
      <EditWadspaceDialog />
      <WaitSheet />
      <RunDialog />
      <BuildLog />
      <Toaster />
      <Tour />
    </div>
  );
}

/** The machine's own apps (Terminal, WadBrowser): ▶ opens one (it starts if
 *  it isn't running) and ■ stops it while it runs. */
function MachineApps({ narrow }: { narrow: boolean }) {
  // The list itself from the store (a selector that made a new array each
  // time would re-render without end), the apps picked out here.
  const wadspaces = useApp((s) => s.wadspaces);
  const apps = useMemo(() => wadspaces.filter((w) => w.app), [wadspaces]);
  if (!apps.length) return null;
  return (
    <div className={clsx("flex flex-col gap-1", narrow && "items-center")}>
      {!narrow && <div className="px-3 text-[11px] font-semibold uppercase tracking-wider text-faint">Apps</div>}
      {apps.map((ws) => (
        <MachineApp key={ws.id} ws={ws} narrow={narrow} />
      ))}
    </div>
  );
}

function MachineApp({ ws, narrow }: { ws: Wadspace; narrow: boolean }) {
  const container = useApp((s) => s.machines.find((m) => m.id === THIS_MACHINE)?.containers.find((c) => c.wadspaceId === ws.id));
  const focus = useApp((s) => s.focus);
  const loadMachines = useApp((s) => s.loadMachines);
  const toast = useApp((s) => s.toast);
  const [stopping, setStopping] = useState(false);
  const running = container?.status === "running";
  const starting = !!container?.phase && ["starting", "waiting"].includes(container.phase);
  const locked = isLocked(focus, ws.id);
  const product = APP_PRODUCTS[ws.id];

  const stop = async () => {
    setStopping(true);
    try {
      await backend.container(THIS_MACHINE, ws.id, "stop");
      loadMachines();
    } catch (e) {
      toast({ title: `Couldn't stop ${ws.name}`, body: (e as Error).message, tone: "error" });
    } finally {
      setStopping(false);
    }
  };
  const button = "grid size-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40";

  return (
    <div className={clsx("flex items-center rounded-xl", narrow ? "flex-col gap-0.5" : "h-10 gap-2 pl-3 pr-1 hover:bg-surface-2/60")}>
      <span className="relative" title={narrow ? ws.name : undefined}>
        {product ? <ProductMark product={product} className="size-5 shrink-0" /> : <AppWindow className="size-[18px] shrink-0 text-muted" />}
        {running && <span className="absolute -right-1 -top-1 size-1.5 rounded-full bg-accent shadow-[0_0_6px_var(--accent)]" />}
      </span>
      {!narrow && <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted">{ws.name}</span>}
      <button
        type="button"
        className={button}
        disabled={locked}
        onClick={() => openWadspace(ws, THIS_MACHINE)}
        title={locked ? "Focus mode: not one of this session's picks" : running ? `Show ${ws.name}` : `Open ${ws.name}`}
        aria-label={`Open ${ws.name}`}
      >
        {starting ? <Loader2 className="size-4 animate-spin" /> : locked ? <Lock className="size-4" /> : <Play className="size-4 fill-current" />}
      </button>
      {running && (
        <button type="button" className={button} disabled={stopping} onClick={stop} title={`Stop ${ws.name}`} aria-label={`Stop ${ws.name}`}>
          {stopping ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-3.5 fill-current" />}
        </button>
      )}
    </div>
  );
}

/** Start: open wadspaces on this machine together (StartDialog). */
function StartButton({ narrow }: { narrow: boolean }) {
  const openStart = useUi((s) => s.openStart);
  const focus = useApp((s) => s.focus);
  return (
    <button
      type="button"
      onClick={() => openStart()}
      disabled={!!focus}
      title={focus ? "A focus session is on" : narrow ? "Start" : undefined}
      className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent font-display text-[15px] font-semibold text-accent-fg shadow-[0_8px_24px_-10px_var(--accent)] transition-all hover:brightness-110 active:scale-[0.98] disabled:opacity-40"
    >
      <Play className="size-4 shrink-0 fill-current" />
      {!narrow && "Start"}
    </button>
  );
}

function FocusBanner() {
  const focus = useApp((s) => s.focus);
  const wadspaces = useApp((s) => s.wadspaces);
  const remaining = useFocusRemaining();
  const active = focus && remaining > 0;
  const names = focus?.wadspaceIds.map((id) => ({ id, name: wadspaces.find((w) => w.id === id)?.name ?? "Unknown" })) ?? [];
  const pct = focus ? 1 - remaining / (focus.endsAt - focus.startedAt) : 0;

  return (
    <AnimatePresence>
      {active && (
        <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="relative shrink-0 overflow-hidden border-b border-line">
          <div className="relative flex flex-wrap items-center gap-x-4 gap-y-2 bg-accent-soft px-6 py-2.5">
            <div className="flex items-center gap-2 text-sm font-semibold text-accent">
              <Lock className="size-4" /> Focus mode
            </div>
            <div className="font-display text-lg font-bold tabular-nums">{countdown(remaining)}</div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted">
              Locked to
              {names.map((n) => (
                <span key={n.id} className="rounded-full bg-surface px-2 py-0.5 font-medium text-fg ring-1 ring-line">
                  {n.name}
                </span>
              ))}
            </div>
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-xs text-faint lg:inline">Restart WAD SPACES to exit early</span>
              <button type="button" onClick={openFocusWindow} className="rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg hover:brightness-110">
                Open focus window
              </button>
            </div>
            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-accent/20">
              <div className="h-full bg-accent transition-[width] duration-1000 ease-linear" style={{ width: `${pct * 100}%` }} />
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

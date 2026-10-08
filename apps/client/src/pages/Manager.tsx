import { useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  Activity,
  Check,
  CloudDownload,
  Cpu,
  History,
  Keyboard,
  Laptop,
  Layers,
  Link2,
  Loader2,
  MemoryStick,
  MonitorSmartphone,
  Play,
  Power,
  RotateCw,
  Server,
  ShieldCheck,
  Square,
  Stethoscope,
  Target,
} from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import type { ContainerAction } from "@/data/backend";
import { MachineDiagnostics } from "@/components/MachineDiagnostics";
import { DraftGrid } from "@/components/DraftGrid";
import { WadspaceActions } from "@/components/manager/WadspaceActions";
import { Page } from "@/components/Page";
import { RunHistory } from "@/components/RunHistory";
import { SearchBox } from "@/components/SearchBox";
import { TailnetBadge, TailnetCard } from "@/components/Tailnet";
import { Thumb } from "@/components/Thumb";
import { Badge, Button, EmptyState, IconButton, Input, Label, Meter, Modal, PageHeader, Progress, Segmented } from "@/components/ui";
import { timeAgo, uptime } from "@/lib/format";
import { openWadspace } from "@/lib/launch";
import { THIS_MACHINE, isLocked, useApp } from "@/lib/store";
import type { Container, Machine, Wadspace } from "@/lib/types";
import { hasAccount, isThisMachine } from "@/lib/machine";

const PHASE: Record<string, string> = {
  idle: "Stopped",
  pulling: "Downloading",
  starting: "Starting",
  waiting: "Waiting for its desktop",
  ready: "Running",
  stopping: "Stopping",
  error: "Error",
};

function phaseLabel(c: Container) {
  if (c.onScreen) return "On screen";
  if (c.phase === "idle" && c.status === "running") return "Running";
  return PHASE[c.phase ?? (c.status === "running" ? "ready" : "idle")] ?? c.phase ?? c.status;
}

/** "All": every wadspace, on every machine. */
const ALL = "all";
type Tab = "wadspaces" | "diagnostics";

/** The Wadspaces Manager: your machines (and All of them) and the wadspaces on them. */
export default function ManagerPage() {
  const machines = useApp((s) => s.machines);
  const [params, setParams] = useSearchParams();
  const picked = params.get("machine") ?? ALL;
  const m = picked === ALL ? null : (machines.find((x) => x.id === picked) ?? null);
  const selected = m ? m.id : ALL;
  const select = (id: string) => setParams(id === ALL ? {} : { machine: id }, { replace: true });

  // Keep the load meters moving (wadd's events only fire on changes).
  const loadMachines = useApp((s) => s.loadMachines);
  useEffect(() => {
    const t = setInterval(() => loadMachines().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [loadMachines]);

  return (
    <Page>
      <PageHeader title="Wadspaces Manager" subtitle="Your machines and the wadspaces on them." />

      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <MachineList machines={machines} selected={selected} onSelect={select} />
        {m ? <MachineDetail key={m.id} m={m} /> : <AllDetail />}
      </div>

    </Page>
  );
}

function MachineList({ machines, selected, onSelect }: { machines: Machine[]; selected: string; onSelect: (id: string) => void }) {
  const launchTarget = useApp((s) => s.launchTarget);
  const wadspaces = useApp((s) => s.wadspaces);
  const runningAll = machines.reduce((n, x) => n + x.containers.filter((c) => c.status === "running").length, 0);
  return (
    <div className="space-y-2">
      <ListItem
        on={selected === ALL}
        onClick={() => onSelect(ALL)}
        icon={<Layers className="size-5" />}
        live
        title="All"
        sub={`${wadspaces.length} wadspace${wadspaces.length === 1 ? "" : "s"} · ${runningAll} running`}
      />
      {machines.map((x) => {
        const running = x.containers.filter((c) => c.status === "running").length;
        return (
          <ListItem
            key={x.id}
            on={x.id === selected}
            onClick={() => onSelect(x.id)}
            icon={x.id === THIS_MACHINE ? <Laptop className="size-5" /> : <Server className="size-5" />}
            live={x.status === "online"}
            title={
              <>
                <span className="truncate">{x.label}</span>
                {hasAccount && x.id === launchTarget && <Badge>default</Badge>}
              </>
            }
            sub={
              <>
                <span className={clsx("size-1.5 rounded-full", x.status === "online" ? "bg-accent shadow-[0_0_8px_var(--accent)]" : "bg-faint")} />
                {x.status === "online" ? `${running} running` : x.lastSeen ? `seen ${timeAgo(x.lastSeen)}` : "offline"} · {x.name}
              </>
            }
          />
        );
      })}
    </div>
  );
}

function ListItem({ on, onClick, icon, live, title, sub }: { on: boolean; onClick: () => void; icon: React.ReactNode; live: boolean; title: React.ReactNode; sub: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "relative flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left transition-all",
        on ? "border-accent/50 bg-surface shadow-glow" : "border-line bg-surface/60 hover:border-line-strong",
      )}
    >
      <span className={clsx("grid size-10 shrink-0 place-items-center rounded-xl", live ? "bg-accent-soft text-accent" : "bg-surface-3 text-faint")}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm font-semibold">{title}</div>
        <div className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted">{sub}</div>
      </div>
    </button>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  return (
    <Segmented
      value={tab}
      onChange={setTab}
      options={[
        { value: "wadspaces" as Tab, label: <><Activity className="size-3.5" /> Wadspaces</> },
        { value: "diagnostics" as Tab, label: <><Stethoscope className="size-3.5" /> Diagnostics</> },
      ]}
    />
  );
}

/** A machine's CPU, memory and GPU. */
function Resources({ m }: { m: Machine }) {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      <Resource icon={<Cpu className="size-4" />} label="CPU" value={m.cpu} />
      <Resource icon={<MemoryStick className="size-4" />} label="Memory" value={m.ram} tone="accent-2" />
      <Resource icon={<MonitorSmartphone className="size-4" />} label="GPU" text={m.gpu || undefined} />
    </div>
  );
}

/** All: every wadspace, on a machine or not yet, and the drafts. */
function AllDetail() {
  const wadspaces = useApp((s) => s.wadspaces);
  const machines = useApp((s) => s.machines);
  const drafts = useApp((s) => s.drafts);
  const [q, setQ] = useState("");
  const needle = q.trim().toLowerCase();
  // By name: the list is reloaded every few seconds, and a wadspace without a
  // saved design gets a fresh "updated" time each time, so sorting by that
  // reshuffled the rows.
  const list = wadspaces
    .filter((w) => !needle || `${w.name} ${w.description}`.toLowerCase().includes(needle))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="min-w-0 space-y-5">
      <div className="overflow-hidden rounded-3xl border border-line bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <h3 className="font-display text-lg font-semibold">All wadspaces</h3>
          <SearchBox value={q} onChange={setQ} placeholder="Search wadspaces" />
        </div>
        {list.length ? (
          list.map((ws) => <AllRow key={ws.id} ws={ws} machines={machines} />)
        ) : (
          <div className="p-6">
            <EmptyState icon={<Layers className="size-6" />} title={q ? "No matches" : "No wadspaces yet"} body={q ? `Nothing matches "${q}".` : "Make one in the Builder."} />
          </div>
        )}
      </div>
      {drafts.length > 0 && (
        <div>
          <h3 className="mb-3 font-display text-lg font-semibold">Drafts</h3>
          <DraftGrid items={drafts} />
        </div>
      )}
    </motion.div>
  );
}

/** A wadspace in All: where it is, and what you can do with it. */
function AllRow({ ws, machines }: { ws: Wadspace; machines: Machine[] }) {
  const build = useApp((s) => s.builds.find((b) => b.wadspaceId === ws.id && b.status === "building"));
  const on = machines.flatMap((m) => m.containers.filter((c) => c.wadspaceId === ws.id).map((c) => ({ m, c })));
  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-line px-5 py-3 last:border-0">
      <Thumb ws={ws} className="!w-28 rounded-xl" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{ws.name}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
          {on.length ? (
            on.map(({ m, c }) => (
              <Badge key={m.id}>
                <span className={clsx("size-1.5 rounded-full", c.status === "running" ? "bg-accent shadow-[0_0_8px_var(--accent)]" : "bg-faint")} />
                {m.label} · {phaseLabel(c)}
              </Badge>
            ))
          ) : (
            <span>Not on a machine yet: build it in the Builder</span>
          )}
        </div>
        {build && (
          <div className="mt-2 max-w-md">
            <Progress value={build.progress} />
            <div className="mt-1 text-xs text-muted">Building</div>
          </div>
        )}
      </div>
      <WadspaceActions ws={ws} />
    </div>
  );
}

function MachineDetail({ m }: { m: Machine }) {
  const launchTarget = useApp((s) => s.launchTarget);
  const [tab, setTab] = useState<Tab>("wadspaces");
  const [deployOpen, setDeployOpen] = useState(false);
  const offline = !hasAccount;
  const here = isThisMachine(m.id);
  const up = m.status === "online";
  const Icon = m.id === THIS_MACHINE ? Laptop : Server;

  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="min-w-0 space-y-5">
      <div className="rounded-3xl border border-line bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <span className={clsx("grid size-11 place-items-center rounded-2xl", up ? "bg-accent-soft text-accent" : "bg-surface-3 text-faint")}>
              <Icon className="size-5" />
            </span>
            <div>
              <div className="flex items-center gap-2.5">
                <h2 className="font-display text-2xl font-bold tracking-tight">{m.label}</h2>
                <Badge tone={up ? "accent" : "default"}>{up ? "online" : "offline"}</Badge>
                {!offline && <TailnetBadge m={m} />}
              </div>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-muted">
                <span>{m.name}</span>
                <span>{m.os}</span>
                {!up && m.lastSeen && <span>last seen {timeAgo(m.lastSeen)}</span>}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!offline && m.id !== launchTarget && (
              <Button onClick={() => backend.setDefaultMachine?.(m.id)} title="Open wadspaces here by default">
                <Target className="size-4" /> Use by default
              </Button>
            )}
            <Button variant="primary" disabled={!up} onClick={() => setDeployOpen(true)}>
              <Play className="size-4 fill-current" /> Open a wadspace
            </Button>
          </div>
        </div>

        {offline ? <LinkThisMachine linked={m.linked} /> : null}
        {here && backend.caps.tailnet && <TailnetCard m={m} />}
      </div>

      <Tabs tab={tab} setTab={setTab} />

      {tab === "diagnostics" ? (
        <>
          <div className="rounded-3xl border border-line bg-surface p-6">
            <Resources m={m} />
          </div>
          {here && <MachineDiagnostics />}
        </>
      ) : (
        <>
          <Containers m={m} />
          {backend.caps.history && (
            <div className="overflow-hidden rounded-3xl border border-line bg-surface">
              <div className="border-b border-line px-5 py-4">
                <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
                  <History className="size-4 text-accent" /> History
                </h3>
                <p className="mt-0.5 text-xs text-muted">What ran on {m.label}, who started it, and for how long.</p>
              </div>
              <div className="max-h-[560px] overflow-y-auto px-3 pb-3">
                <RunHistory machineId={m.id} limit={15} />
              </div>
            </div>
          )}
        </>
      )}

      <DeployDialog machine={m} open={deployOpen} onClose={() => setDeployOpen(false)} />
    </motion.div>
  );
}

function Containers({ m }: { m: Machine }) {
  const wadspaces = useApp((s) => s.wadspaces);
  const focus = useApp((s) => s.focus);
  const toast = useApp((s) => s.toast);
  const loadMachines = useApp((s) => s.loadMachines);
  const [busy, setBusy] = useState<string | null>(null);
  const here = isThisMachine(m.id);
  const up = m.status === "online";

  const act = async (c: Container, action: ContainerAction) => {
    setBusy(`${c.id}:${action}`);
    try {
      await backend.container(m.id, c.id, action);
      if (!here) toast({ title: "Sent", body: `${action} → ${m.label}` });
      loadMachines();
    } catch (e) {
      toast({ title: "Couldn't do that", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h3 className="font-display text-lg font-semibold">On this machine</h3>
        <span className="text-xs text-muted">
          {m.containers.filter((c) => c.status === "running").length} running · {m.containers.length} installed
        </span>
      </div>
      {m.containers.length ? (
        m.containers.map((c) => {
          const ws = wadspaces.find((w) => w.id === c.wadspaceId);
          const on = c.status === "running";
          const locked = isLocked(focus, c.wadspaceId);
          const b = (a: string) => busy === `${c.id}:${a}`;
          return (
            <div key={c.id} className="flex flex-wrap items-center gap-4 border-b border-line px-5 py-3 last:border-0">
              {ws ? <Thumb ws={ws} className="!w-28 rounded-xl" /> : <div className="aspect-video w-28 rounded-xl bg-surface-2" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{ws?.name ?? c.wadspaceId}</span>
                  {c.hotkey ? (
                    <Badge>
                      <Keyboard className="size-3" /> Super+{c.hotkey}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className={clsx("size-1.5 rounded-full", c.phase === "error" ? "bg-danger" : on ? "bg-accent shadow-[0_0_8px_var(--accent)]" : c.phase && c.phase !== "idle" ? "bg-accent-2" : "bg-faint")} />
                    {phaseLabel(c)}
                    {on && c.phase !== "error" && ` · up ${uptime(c.startedAt)}`}
                  </span>
                  <Badge>{c.mode === "stream" ? "Streamed display" : "On screen"}</Badge>
                </div>
                {c.download && (
                  <div className="mt-2 max-w-md">
                    <Progress value={c.download.progress ?? 0} />
                    <div className="mt-1 text-xs text-muted">{c.download.label}</div>
                  </div>
                )}
                {c.phase === "error" && c.error && <div className="mt-1 break-words text-xs text-danger">{c.error}</div>}
              </div>
              <div className="flex items-center gap-0.5">
                {here && ws?.installed && !ws.local && !c.download && (
                  <IconButton label="Download" disabled={!up || b("download")} onClick={() => act(c, "download")}>
                    <CloudDownload className="size-4" />
                  </IconButton>
                )}
                {on ? (
                  <>
                    <IconButton label="Restart" disabled={!up || b("restart")} onClick={() => act(c, "restart")}>
                      {b("restart") ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />}
                    </IconButton>
                    <IconButton label="Stop" disabled={!up || b("stop")} onClick={() => act(c, "stop")}>
                      <Square className="size-3.5 fill-current" />
                    </IconButton>
                  </>
                ) : (
                  <IconButton label="Start in the background" disabled={!up || locked || b("start")} onClick={() => act(c, "start")}>
                    <Power className="size-4" />
                  </IconButton>
                )}
                {ws && <WadspaceActions ws={ws} machineId={m.id} download={false} />}
              </div>
            </div>
          );
        })
      ) : (
        <div className="p-6">
          <EmptyState icon={<Power className="size-6" />} title="Nothing installed" body={up ? "Build a wadspace in the Builder to put it here." : `${m.label} is offline.`} />
        </div>
      )}
    </div>
  );
}

function Resource({ icon, label, value, text, tone = "accent" }: { icon: React.ReactNode; label: string; value?: number | null; text?: string; tone?: "accent" | "accent-2" }) {
  const known = typeof value === "number";
  return (
    <div className="rounded-2xl bg-surface-2 p-4 ring-1 ring-line">
      <div className="mb-3 flex items-center justify-between text-xs text-muted">
        <span className="flex items-center gap-1.5">
          {icon} {label}
        </span>
        <span className="truncate pl-2 font-mono tabular-nums text-fg">{known ? `${Math.round(value)}%` : (text ?? "—")}</span>
      </div>
      {text === undefined && <Meter value={known ? value : 0} tone={tone} />}
      {!known && text === undefined && <div className="mt-2 text-[11px] text-faint">Reported by newer versions of wadd</div>}
    </div>
  );
}

/** Offline: link this machine to an account so the online app can reach it. */
function LinkThisMachine({ linked }: { linked: boolean }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);
  const loadMachines = useApp((s) => s.loadMachines);

  const link = async () => {
    setBusy(true);
    try {
      await backend.linkMachine!(code);
      toast({ title: "Linked", body: "This machine now shows up in your account.", tone: "success" });
      setCode("");
      loadMachines();
    } catch (e) {
      toast({ title: "Couldn't link", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6 flex flex-wrap items-center gap-4 rounded-2xl bg-surface-2 p-4 ring-1 ring-line">
      <span className={clsx("grid size-10 place-items-center rounded-xl", linked ? "bg-accent-soft text-accent" : "bg-surface-3 text-faint")}>
        {linked ? <ShieldCheck className="size-5" /> : <Link2 className="size-5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{linked ? "Linked to your account" : "Link to your account"}</div>
        <div className="text-xs text-muted">
          {linked
            ? "You can start, stop and show wadspaces on this machine from WadSpaces online."
            : "Enter a link code from your account here (needs internet)."}
        </div>
      </div>
      {!linked && backend.linkMachine && (
        <div className="flex items-center gap-2">
          <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="CODE" className="w-36 font-mono tracking-[0.2em]" aria-label="Link code" />
          <Button variant="primary" disabled={busy || code.trim().length < 6} onClick={link}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />} Link
          </Button>
        </div>
      )}
    </div>
  );
}

function DeployDialog({ machine, open, onClose }: { machine: Machine; open: boolean; onClose: () => void }) {
  const wadspaces = useApp((s) => s.wadspaces);
  const focus = useApp((s) => s.focus);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (open) setPicked(null);
  }, [open]);

  // What this machine can open: the ones installed there.
  const installed = new Set(machine.containers.map((c) => c.wadspaceId));
  const list = wadspaces.filter((w) => installed.has(w.id));

  const go = () => {
    const ws = wadspaces.find((w) => w.id === picked);
    if (ws) openWadspace(ws, machine.id);
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={`Open on ${machine.label}`} subtitle="Starts it if needed and puts it on the machine's screen." width={620}>
      {list.length ? (
        <>
          <Label>Wadspace</Label>
          <div className="grid max-h-[320px] grid-cols-2 gap-2 overflow-y-auto pr-1">
            {list.map((w) => (
              <button
                key={w.id}
                type="button"
                disabled={isLocked(focus, w.id)}
                onClick={() => setPicked(w.id)}
                className={clsx("flex items-center gap-2.5 rounded-2xl p-1.5 pr-3 text-left ring-1 transition-all disabled:opacity-40", picked === w.id ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}
              >
                <Thumb ws={w} className="!w-20 shrink-0 rounded-xl" />
                <span className="min-w-0 truncate text-[13px] font-medium">{w.name}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="text-sm text-muted">Nothing is installed on {machine.label} yet.</p>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!picked} onClick={go}>
          <Play className="size-4 fill-current" /> Open
        </Button>
      </div>
    </Modal>
  );
}

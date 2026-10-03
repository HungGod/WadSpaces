import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  Activity,
  Cast,
  Check,
  CloudDownload,
  Cpu,
  Eye,
  History,
  Keyboard,
  Laptop,
  Link2,
  Loader2,
  MemoryStick,
  MonitorSmartphone,
  Play,
  Plus,
  Power,
  RotateCw,
  Server,
  ShieldCheck,
  Square,
  Stethoscope,
  Target,
  Trash2,
} from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import type { ContainerAction } from "@/data/backend";
import { MachineDiagnostics } from "@/components/MachineDiagnostics";
import { Page } from "@/components/Page";
import { RunHistory } from "@/components/RunHistory";
import { StreamDetails, StreamPasswordForm } from "@/components/StreamPassword";
import { StreamLink, TailnetBadge, TailnetCard } from "@/components/Tailnet";
import { Thumb } from "@/components/Thumb";
import { Badge, Button, EmptyState, IconButton, Input, Label, Meter, Modal, PageHeader, Progress, Segmented } from "@/components/ui";
import { timeAgo, uptime } from "@/lib/format";
import { openWadspace } from "@/lib/launch";
import { ensureStream, viewHere } from "@/lib/streams";
import { THIS_MACHINE, isLocked, useApp } from "@/lib/store";
import type { Container, Machine } from "@/lib/types";
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

export default function ManagerPage() {
  const machines = useApp((s) => s.machines);
  const launchTarget = useApp((s) => s.launchTarget);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pairOpen, setPairOpen] = useState(false);
  const offline = !hasAccount;

  const m = machines.find((x) => x.id === selectedId) ?? machines.find((x) => x.id === launchTarget) ?? machines[0];

  // Keep the load meters moving (wadd's events only fire on changes).
  const loadMachines = useApp((s) => s.loadMachines);
  useEffect(() => {
    const t = setInterval(() => loadMachines().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [loadMachines]);

  return (
    <Page>
      <PageHeader title="Manager" subtitle={offline ? "This machine and the wadspaces on it." : "Your WadSpaces machines and what runs on them."}>
        {backend.createEnrollCode && (
          <Button onClick={() => setPairOpen(true)}>
            <Plus className="size-4" /> Add machine
          </Button>
        )}
      </PageHeader>

      {!m ? (
        <EmptyState
          icon={<Server className="size-6" />}
          title={offline ? "Can't reach wadd" : "No machines yet"}
          body={offline ? "Wad Creator talks to wadd on this machine. Is wadd running?" : "Link a WadSpaces machine to your account to manage it from here."}
          action={backend.createEnrollCode && <Button variant="primary" onClick={() => setPairOpen(true)}><Plus className="size-4" /> Add machine</Button>}
        />
      ) : (
        <div className={clsx("grid gap-6", !offline && "lg:grid-cols-[300px_1fr]")}>
          {!offline && <MachineList machines={machines} selected={m.id} onSelect={setSelectedId} />}
          <MachineDetail key={m.id} m={m} />
        </div>
      )}

      {backend.setStreamPassword && backend.target === "online" && (
        <div className="mt-6 rounded-3xl border border-line bg-surface p-6">
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold">
            <Cast className="size-4 text-accent" /> Viewing wadspaces on other devices
          </h3>
          <p className="mb-4 mt-1 text-sm text-muted">
            A machine that allows it (in its Wad Creator: Viewing) streams its wadspaces to your other machines and to phones on its network. They sign in with your username and this password.
          </p>
          <StreamPasswordForm />
        </div>
      )}

      {backend.createEnrollCode && <PairDialog open={pairOpen} onClose={() => setPairOpen(false)} />}
    </Page>
  );
}

function MachineList({ machines, selected, onSelect }: { machines: Machine[]; selected: string; onSelect: (id: string) => void }) {
  const launchTarget = useApp((s) => s.launchTarget);
  return (
    <div className="space-y-2">
      {machines.map((x) => {
        const running = x.containers.filter((c) => c.status === "running").length;
        return (
          <button
            key={x.id}
            type="button"
            onClick={() => onSelect(x.id)}
            className={clsx(
              "relative flex w-full items-center gap-3 rounded-2xl border p-3.5 text-left transition-all",
              x.id === selected ? "border-accent/50 bg-surface shadow-glow" : "border-line bg-surface/60 hover:border-line-strong",
            )}
          >
            <span className={clsx("grid size-10 place-items-center rounded-xl", x.status === "online" ? "bg-accent-soft text-accent" : "bg-surface-3 text-faint")}>
              <Server className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm font-semibold">
                <span className="truncate">{x.label}</span>
                {x.id === launchTarget && <Badge>default</Badge>}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
                <span className={clsx("size-1.5 rounded-full", x.status === "online" ? "bg-accent shadow-[0_0_8px_var(--accent)]" : "bg-faint")} />
                {x.status === "online" ? `${running} running` : x.lastSeen ? `seen ${timeAgo(x.lastSeen)}` : "offline"} · {x.name}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function MachineDetail({ m }: { m: Machine }) {
  const launchTarget = useApp((s) => s.launchTarget);
  const [tab, setTab] = useState<"wadspaces" | "diagnostics">("wadspaces");
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

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <Resource icon={<Cpu className="size-4" />} label="CPU" value={m.cpu} />
          <Resource icon={<MemoryStick className="size-4" />} label="Memory" value={m.ram} tone="accent-2" />
          <Resource icon={<MonitorSmartphone className="size-4" />} label="GPU" text={m.gpu || undefined} />
        </div>

        {offline ? <LinkThisMachine linked={m.allowRemote} /> : null}
        {here && backend.caps.tailnet && <TailnetCard m={m} />}
      </div>

      {here && (
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "wadspaces", label: <><Activity className="size-3.5" /> Wadspaces</> },
            { value: "diagnostics", label: <><Stethoscope className="size-3.5" /> Diagnostics</> },
          ]}
        />
      )}

      {tab === "diagnostics" ? (
        <MachineDiagnostics />
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

  // Another machine's wadspace on this device: in the machine app, a window
  // here (wadd's view of its stream); online, its links (a phone's browser).
  const view = async (c: Container, name: string) => {
    setBusy(`${c.id}:view`);
    try {
      const projects = wadspaces.find((w) => w.id === c.wadspaceId)?.mountedProjects ?? [];
      if (backend.target === "machine") await viewHere(m, { id: c.wadspaceId, name }, projects);
      else {
        await ensureStream(m, { id: c.wadspaceId, name }, projects);
        toast({ title: `${m.label} is streaming ${name}`, body: "Open its link below on this device", tone: "success" });
      }
      loadMachines();
    } catch (e) {
      toast({ title: "Couldn't view it", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const act = async (c: Container, action: ContainerAction) => {
    if (action === "remove" && !confirm(`Remove ${wadspaces.find((w) => w.id === c.wadspaceId)?.name ?? c.id} from ${m.label}? Its settings folder stays.`)) return;
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
                {on && c.streamUrl && <StreamLink url={c.streamUrl} className="mt-2" />}
                {!here && c.stream && backend.target === "online" && <StreamDetails stream={c.stream} className="mt-2" />}
              </div>
              <div className="flex items-center gap-0.5">
                {!here && c.native && hasAccount && (
                  <IconButton
                    label={
                      m.allowRemote
                        ? backend.target === "machine"
                          ? "View here"
                          : "View on this device"
                        : `Viewing from other devices is off on ${m.label} (its Wad Creator: Viewing)`
                    }
                    disabled={!up || !m.allowRemote || b("view")}
                    onClick={() => view(c, ws?.name ?? c.wadspaceId)}
                  >
                    {b("view") ? <Loader2 className="size-4 animate-spin" /> : <Cast className="size-4" />}
                  </IconButton>
                )}
                {!c.onScreen && (
                  <IconButton label="Show on screen" disabled={!up || locked} onClick={() => ws && openWadspace(ws, m.id)}>
                    <Eye className="size-4" />
                  </IconButton>
                )}
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
                    <Play className="size-4 fill-current" />
                  </IconButton>
                )}
                {here && (
                  <IconButton label="Remove from this machine" disabled={!up || on} onClick={() => act(c, "remove")}>
                    <Trash2 className="size-4" />
                  </IconButton>
                )}
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
            ? "You can start, stop and show wadspaces on this machine from the online Wad Creator."
            : "In the online Wad Creator, Manager → Add machine gives you a code. Enter it here (needs internet)."}
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

/** Online: a one-time code the machine's offline app (or `wadd enroll`) redeems. */
function PairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    if (open) {
      setName("");
      setCode(null);
    }
  }, [open]);

  const make = async () => {
    setBusy(true);
    try {
      setCode(await backend.createEnrollCode!(name));
    } catch (e) {
      toast({ title: "Couldn't make a code", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a machine" subtitle="Link a WadSpaces machine to your account." width={460}>
      {!code ? (
        <>
          <Label>Machine name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Surface at home" autoFocus />
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={make}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null} Get a code
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="rounded-2xl bg-surface-2 p-6 text-center ring-1 ring-line">
            <div className="text-xs font-medium uppercase tracking-[0.2em] text-faint">Link code</div>
            <div className="mt-2 font-display text-4xl font-bold tracking-[0.15em] text-accent">{code}</div>
            <div className="mt-2 text-xs text-muted">Valid for 15 minutes, once.</div>
          </div>
          <ol className="mt-5 list-decimal space-y-1.5 pl-5 text-sm text-muted">
            <li>On the machine, open Wad Creator and go to <b className="text-fg">Manager</b>.</li>
            <li>
              Under <b className="text-fg">Link to your account</b>, enter the code.
            </li>
            <li>It shows up here within a minute.</li>
          </ol>
          <Button variant="primary" className="mt-6 w-full" onClick={onClose}>
            Done
          </Button>
        </>
      )}
    </Modal>
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

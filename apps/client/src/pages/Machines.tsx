// Machines: your WadSpaces machines (this one offline; your account's online),
// each with its wadspaces (what's installed and running there, and on this
// machine the ones not built here yet), what they take on its disk (the
// storage tree), its run history and diagnostics, the tailnet, and linking
// this machine to an account.
import { useNavigate, useSearchParams } from "react-router";
import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  Activity,
  Check,
  Cpu,
  Hammer,
  History,
  Keyboard,
  Laptop,
  Link2,
  Loader2,
  MemoryStick,
  MonitorSmartphone,
  Play,
  Power,
  Server,
  ShieldCheck,
  Stethoscope,
  Target,
} from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { wadspaceName } from "@/data/layers";
import { MachineDiagnostics } from "@/components/MachineDiagnostics";
import { MachineStorage } from "@/components/MachineStorage";
import { ContainerControls, ContainerStatus } from "@/components/manager/ContainerControls";
import { WadspaceActions } from "@/components/manager/WadspaceActions";
import { Page } from "@/components/Page";
import { RunHistory } from "@/components/RunHistory";
import { TailnetBadge, TailnetCard } from "@/components/Tailnet";
import { Thumb } from "@/components/Thumb";
import { Badge, Button, EmptyState, Input, Meter, PageHeader, Segmented } from "@/components/ui";
import { timeAgo } from "@/lib/format";
import { THIS_MACHINE, alive, useApp } from "@/lib/store";
import type { Machine } from "@/lib/types";
import { useUi } from "@/lib/ui";
import { hasAccount, isThisMachine } from "@/lib/machine";

type Tab = "wadspaces" | "diagnostics";

/** Machines: the list, and the picked one's detail (the launch machine to start with). */
export default function MachinesPage() {
  const machines = useApp((s) => s.machines);
  const launchTarget = useApp((s) => s.launchTarget);
  const [params, setParams] = useSearchParams();
  const picked = params.get("machine") ?? launchTarget;
  const m = machines.find((x) => x.id === picked) ?? machines.find((x) => x.id === launchTarget) ?? machines[0] ?? null;
  const select = (id: string) => setParams({ machine: id }, { replace: true });

  // Keep the load meters moving (wadd's events only fire on changes).
  const loadMachines = useApp((s) => s.loadMachines);
  useEffect(() => {
    const t = setInterval(() => loadMachines().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [loadMachines]);

  return (
    <Page>
      <PageHeader title="Machines" subtitle="Your WadSpaces machines and what runs on them." />

      {m ? (
        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <MachineList machines={machines} selected={m.id} onSelect={select} />
          <MachineDetail key={m.id} m={m} />
        </div>
      ) : (
        <EmptyState icon={<Server className="size-6" />} title="No machines yet" body={hasAccount ? "Link a WadSpaces machine to your account from its own WadSpaces app." : "wadd on this machine isn't answering."} />
      )}

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

function MachineDetail({ m }: { m: Machine }) {
  const launchTarget = useApp((s) => s.launchTarget);
  const openLauncher = useUi((s) => s.openLauncher);
  const [tab, setTab] = useState<Tab>("wadspaces");
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
            <Button
              variant="primary"
              disabled={!up}
              onClick={() => {
                // The launcher launches on the default machine: this one.
                if (!offline && m.id !== launchTarget) {
                  backend.setDefaultMachine?.(m.id);
                  useApp.getState().setLaunchTarget(m.id);
                }
                openLauncher();
              }}
            >
              <Play className="size-4 fill-current" /> Launch here
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
          {here && backend.storage && up && <MachineStorage m={m} />}
          <Containers m={m} here={here} />
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

    </motion.div>
  );
}

function Containers({ m, here }: { m: Machine; here: boolean }) {
  const wadspaces = useApp((s) => s.wadspaces);
  const buildStack = useApp((s) => s.buildStack);
  const navigate = useNavigate();
  const up = m.status === "online";
  // Your wadspaces this machine doesn't have yet (they're installed when they're built or launched here).
  const notHere = here ? alive(wadspaces).filter((w) => w.template && w.customization && !m.containers.some((c) => c.wadspaceId === w.id)) : [];

  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <h3 className="font-display text-lg font-semibold">On this machine</h3>
        <span className="text-xs text-muted">
          {m.containers.filter((c) => c.status === "running").length} running · {m.containers.length} installed
          {notHere.length ? ` · ${notHere.length} not built here` : ""}
        </span>
      </div>
      {m.containers.length || notHere.length ? (
        <>
        {m.containers.map((c) => {
          const ws = wadspaces.find((w) => w.id === c.wadspaceId && !w.deletedAt);
          return (
            <div key={c.id} className="flex flex-wrap items-center gap-4 border-b border-line px-5 py-3 last:border-0">
              {ws ? <Thumb w={ws} className="!w-28 rounded-xl" /> : <div className="aspect-video w-28 rounded-xl bg-surface-2" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{ws ? wadspaceName(ws) : c.wadspaceId}</span>
                  {c.hotkey ? (
                    <Badge>
                      <Keyboard className="size-3" /> Super+{c.hotkey}
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <ContainerStatus c={c} />
                  <Badge>{!ws ? "On this machine" : c.mode === "stream" ? "Streamed display" : "On screen"}</Badge>
                </div>
                {c.phase === "error" && c.error && <div className="mt-1 break-words text-xs text-danger">{c.error}</div>}
              </div>
              <div className="flex items-center gap-0.5">
                <ContainerControls m={m} c={c} />
                {ws && <WadspaceActions w={ws} />}
              </div>
            </div>
          );
        })}
        {notHere.map((w) => (
          <div key={w.id} className="flex flex-wrap items-center gap-4 border-b border-line px-5 py-3 last:border-0">
            <Thumb w={w} className="!w-28 rounded-xl opacity-70" />
            <div className="min-w-0 flex-1">
              <span className="block truncate font-medium">{wadspaceName(w)}</span>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                <Badge>Not built here</Badge>
                <span>Saved in your library; installed here when you build or launch it.</span>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="secondary" disabled={!up} onClick={() => void buildStack(w.id)}>
                <Hammer className="size-3.5" /> Build here
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate(`/builder?stack=${encodeURIComponent(w.id)}`)}>
                Open in Builder
              </Button>
            </div>
          </div>
        ))}
        </>
      ) : (
        <div className="p-6">
          <EmptyState icon={<Power className="size-6" />} title="No wadspaces yet" body={up ? "Make a wadspace in the Builder: build or launch it and it's installed here." : `${m.label} is offline.`} />
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

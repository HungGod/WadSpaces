import { useNavigate } from "react-router";
import { motion } from "motion/react";
import { CloudDownload, Copy, Hammer, HardDrive, Info, Lock, MoreHorizontal, Pencil, Play, Rocket, Timer, Trash2, Users } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { clockTime, size, timeAgo } from "@/lib/format";
import { openWadspace, transfer } from "@/lib/launch";
import { isLocked, useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";
import type { Wadspace } from "@/lib/types";
import { Thumb } from "./Thumb";
import { Avatar, Badge, Button, Dropdown, IconButton } from "./ui";
import { hasAccount, hasLocal } from "@/lib/machine";

const RING = 2 * Math.PI * 15.5;

export function WadspaceCard({ ws, index = 0 }: { ws: Wadspace; index?: number }) {
  const navigate = useNavigate();
  const user = useApp((s) => s.user);
  const users = useApp((s) => s.users);
  const focus = useApp((s) => s.focus);
  const machines = useApp((s) => s.machines);
  const loadWadspaces = useApp((s) => s.loadWadspaces);
  const toast = useApp((s) => s.toast);
  const download = useApp((s) => s.downloads.find((d) => d.wadspaceId === ws.id));
  const build = useApp((s) => s.builds.find((b) => b.wadspaceId === ws.id && b.status === "building"));
  const setWaitingFor = useApp((s) => s.setWaitingFor);
  const pending = build
    ? { label: "Building & downloading", progress: build.progress, stage: build.lines.at(-1)?.replace(/^[»\s+]+/, ""), icon: <Hammer className="size-3.5" /> }
    : download
      ? { label: "Downloading", progress: download.progress, stage: undefined, icon: <CloudDownload className="size-3.5" /> }
      : null;
  const { openDetails, openFocus } = useUi();

  const mine = ws.owner === user?.username;
  const owner = users.find((u) => u.username === ws.owner);
  const locked = isLocked(focus, ws.id);
  const lockTitle = focus ? `Focus mode: locked until ${clockTime(focus.endsAt)}` : undefined;
  const runningOn = machines.filter((m) => m.containers.some((c) => c.wadspaceId === ws.id && c.status === "running"));

  const remove = async () => {
    const where = hasAccount ? "This removes it from your account." : "This removes it from this machine.";
    if (!confirm(`Delete "${ws.name}"? ${where}`)) return;
    try {
      await backend.deleteWadspace(ws.id);
      toast({ title: "Wadspace deleted", body: ws.name });
    } catch (e) {
      toast({ title: "Couldn't delete", body: (e as Error).message, tone: "error" });
    }
    loadWadspaces();
  };

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 8) * 0.035, type: "spring", stiffness: 300, damping: 30 }}
      className="group relative flex flex-col overflow-hidden rounded-3xl border border-line bg-surface transition-[box-shadow,border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-glow"
    >
      {/* Preview */}
      <div className="relative cursor-pointer overflow-hidden" onClick={() => openDetails(ws.id)}>
        <Thumb ws={ws} className="transition-transform duration-500 group-hover:scale-[1.03]" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-black/20" />
        {pending && (
          // The container is on its way: dim the preview and show it arriving. Click for the wait sheet.
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setWaitingFor(ws.id);
            }}
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/55 text-white backdrop-blur-[2px]"
            aria-label={`${pending.label} ${ws.name}: show progress`}
          >
            <span className="relative grid size-14 place-items-center">
              <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
                <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="2.5" className="stroke-white/15" />
                <circle cx="18" cy="18" r="15.5" fill="none" strokeWidth="2.5" strokeLinecap="round" className="stroke-accent transition-[stroke-dashoffset] duration-300" strokeDasharray={RING} strokeDashoffset={RING * (1 - pending.progress)} />
              </svg>
              <span className="text-[13px] font-semibold tabular-nums">{Math.floor(pending.progress * 100)}%</span>
            </span>
            <span className="flex items-center gap-1.5 text-xs font-medium">
              {pending.icon} {pending.label}
            </span>
            {pending.stage && <span className="max-w-[80%] truncate font-mono text-[10.5px] text-white/60">{pending.stage}</span>}
            <span className="absolute inset-x-0 bottom-0 h-1 bg-white/10">
              <span className="block h-full bg-accent transition-[width] duration-300" style={{ width: `${pending.progress * 100}%` }} />
            </span>
          </button>
        )}

        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          {ws.local && <Badge tone="glass"><HardDrive className="size-3" /> {hasLocal ? "On this machine" : "On machine"}</Badge>}
          {ws.installed && !ws.local && <Badge tone="glass"><CloudDownload className="size-3" /> Not downloaded</Badge>}
          {ws.visibility === "shared" && <Badge tone="glass"><Users className="size-3" /> Shared</Badge>}
          {ws.templateId && <Badge tone="glass"><Rocket className="size-3" /> Quick launch</Badge>}
        </div>
        {!mine && owner && (
          <div className="absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-black/45 py-0.5 pl-0.5 pr-2 text-[11px] text-white ring-1 ring-white/15 backdrop-blur-md">
            <Avatar user={owner} size={20} className="ring-0" /> {owner.displayName}
          </div>
        )}
        {runningOn.length > 0 && (
          <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] text-white ring-1 ring-white/15 backdrop-blur-md">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-accent" />
            </span>
            Running on {runningOn.map((m) => m.label).join(", ")}
          </div>
        )}

        <button
          type="button"
          disabled={locked}
          onClick={(e) => {
            e.stopPropagation();
            openWadspace(ws);
          }}
          aria-label={`Open ${ws.name}`}
          className="absolute left-1/2 top-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 scale-75 place-items-center rounded-full bg-accent text-accent-fg opacity-0 shadow-[0_10px_40px_-6px_var(--accent)] transition-all duration-300 group-hover:scale-100 group-hover:opacity-100 disabled:hidden"
        >
          <Play className="ml-0.5 size-6 fill-current" />
        </button>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate font-display text-[17px] font-semibold tracking-tight">{ws.name}</h3>
            <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{ws.description || "No description"}</p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2 text-[11.5px] text-faint">
          <span>{size(ws.sizeMB)}</span>
          <span className="size-0.5 rounded-full bg-faint" />
          <span>Updated {timeAgo(ws.updatedAt)}</span>
          <span className="size-0.5 rounded-full bg-faint" />
          <span>
            {ws.layout.icons.length} app{ws.layout.icons.length === 1 ? "" : "s"}
          </span>
        </div>

        <div className="mt-auto flex items-center gap-1.5 pt-4">
          <Button variant="primary" size="sm" disabled={locked} title={locked ? lockTitle : undefined} onClick={() => openWadspace(ws)} className="flex-1">
            {locked ? <Lock className="size-3.5" /> : <Play className="size-3.5 fill-current" />} Open
          </Button>
          <IconButton
            label={mine ? "Edit in Builder" : "Duplicate in Builder"}
            onClick={() => navigate(mine ? `/builder/${ws.id}` : `/builder/${ws.id}?duplicate=1`)}
          >
            {mine ? <Pencil className="size-4" /> : <Copy className="size-4" />}
          </IconButton>
          <IconButton label="Focus" title={focus ? "A focus session is already running" : "Start focus session"} disabled={!!focus} onClick={() => openFocus([ws.id])}>
            <Timer className="size-4" />
          </IconButton>
          <Dropdown
            trigger={(open) => (
              <IconButton label="More" active={open}>
                <MoreHorizontal className="size-4" />
              </IconButton>
            )}
            items={[
              { label: "Details & sharing", icon: <Info />, onClick: () => openDetails(ws.id) },
              { label: "Edit in Builder", icon: <Pencil />, hidden: !mine, onClick: () => navigate(`/builder/${ws.id}`) },
              { label: "Duplicate in Builder", icon: <Copy />, onClick: () => navigate(`/builder/${ws.id}?duplicate=1`) },
              "divider",
              { label: "Download to this machine", icon: <CloudDownload />, hidden: !hasLocal || !ws.installed || ws.local || !!download, onClick: () => transfer(ws, "pull") },
              { label: "Remove from this machine", icon: <HardDrive />, hidden: !hasLocal || !ws.installed, onClick: () => transfer(ws, "remove-local") },
              { label: "Delete wadspace", icon: <Trash2 />, danger: true, hidden: !mine, onClick: remove },
            ]}
          />
        </div>
      </div>
      <span className={clsx("pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-accent to-transparent opacity-0 transition-opacity group-hover:opacity-60")} />
    </motion.article>
  );
}

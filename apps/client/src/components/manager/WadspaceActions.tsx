import { useNavigate } from "react-router";
import { CloudDownload, Copy, Info, Lock, MoreHorizontal, Pencil, Play, Timer, Trash2, Wand2 } from "lucide-react";
import { Dropdown, IconButton } from "@/components/ui";
import { clockTime } from "@/lib/format";
import { openWadspace, startDownload } from "@/lib/launch";
import { hasLocal } from "@/lib/machine";
import { isLocked, useApp } from "@/lib/store";
import type { Wadspace } from "@/lib/types";
import { useUi } from "@/lib/ui";
import { cloneWadspace, trashWadspace } from "@/lib/wadspaces";

/**
 * What you can do with a wadspace from a Wadspaces Manager row: open it (on
 * `machineId`, or the default machine), edit it, and the rest in its menu.
 * `download`: offer to download it to this machine (a machine's row has its
 * own button for that).
 */
export function WadspaceActions({ ws, machineId, download = true }: { ws: Wadspace; machineId?: string; download?: boolean }) {
  const navigate = useNavigate();
  const user = useApp((s) => s.user);
  const focus = useApp((s) => s.focus);
  const downloading = useApp((s) => s.downloads.some((d) => d.wadspaceId === ws.id));
  const { openDetails, openEdit, openStart } = useUi();
  const locked = isLocked(focus, ws.id);
  // Online, one only a machine has (not in the account) can't be changed from here.
  const editable = ws.owner === user?.username && !ws.machineOnly;

  return (
    <div className="flex items-center gap-0.5">
      <IconButton
        label="Open"
        title={locked && focus ? `Focus mode: locked until ${clockTime(focus.endsAt)}` : "Open"}
        disabled={locked}
        onClick={() => openWadspace(ws, machineId)}
      >
        {locked ? <Lock className="size-4" /> : <Play className="size-4 fill-current" />}
      </IconButton>
      {editable && (
        <IconButton label="Edit" title="Edit its name, description and background" onClick={() => openEdit(ws.id)}>
          <Pencil className="size-4" />
        </IconButton>
      )}
      <Dropdown
        trigger={(open) => (
          <IconButton label="More" active={open}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        )}
        items={[
          { label: "Details & sharing", icon: <Info />, onClick: () => openDetails(ws.id) },
          { label: "Edit", icon: <Pencil />, hidden: !editable, onClick: () => openEdit(ws.id) },
          { label: "Edit in Builder", icon: <Wand2 />, hidden: !editable, onClick: () => navigate(`/builder/${ws.id}`) },
          { label: "Duplicate in Builder", icon: <Wand2 />, hidden: editable, onClick: () => navigate(`/builder/${ws.id}?duplicate=1`) },
          { label: "Clone", icon: <Copy />, onClick: () => cloneWadspace(ws) },
          { label: "Start a focus session", icon: <Timer />, hidden: !hasLocal || !ws.installed, disabled: !!focus, onClick: () => openStart([ws.id], { focus: true }) },
          { label: "Download to this machine", icon: <CloudDownload />, hidden: !download || !hasLocal || !ws.installed || ws.local || downloading, onClick: () => startDownload(ws) },
          "divider",
          { label: "Delete", icon: <Trash2 />, danger: true, hidden: !editable, onClick: () => trashWadspace(ws) },
        ]}
      />
    </div>
  );
}

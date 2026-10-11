// What can be done with a wadspace, wherever it's listed (the Machines page's
// rows, its details drawer): open it, customize it for a run, edit it in the
// Builder or start a new one from it, look at its details, delete it.
import { useNavigate } from "react-router";
import { Copy, Info, Lock, MoreHorizontal, Pencil, Play, SlidersHorizontal, Trash2 } from "lucide-react";
import type { WadspaceV2 } from "@core/layers";
import { useDraft } from "@/components/wadbuilder/draft";
import { Dropdown, IconButton } from "@/components/ui";
import { clockTime } from "@/lib/format";
import { openWadspace } from "@/lib/launch";
import { isLocked, useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";

/** The actions, for menus and buttons alike. */
export function useWadspaceActions(w: WadspaceV2) {
  const navigate = useNavigate();
  const { openDetails, openLauncher } = useUi();
  const lib = () => {
    const { templates, customizations } = useApp.getState();
    return { templates, customizations };
  };
  return {
    open: () => void openWadspace(w),
    customize: () => openLauncher({ customize: w.id }),
    edit: () => {
      useDraft.getState().edit(w, lib());
      navigate("/builder");
    },
    copy: () => {
      useDraft.getState().copy(w, lib());
      navigate("/builder");
    },
    details: () => openDetails(w.id),
    remove: () => {
      if (!confirm(`Delete ${w.name}?`)) return;
      useApp
        .getState()
        .remove("wadspace", w.id)
        .then(() => openDetails(null))
        .catch((e) => useApp.getState().toast({ title: "Can't delete it", body: (e as Error).message, tone: "error" }));
    },
  };
}

/** Open, and the rest in a menu. */
export function WadspaceActions({ w }: { w: WadspaceV2 }) {
  const focus = useApp((s) => s.focus);
  const a = useWadspaceActions(w);
  const locked = isLocked(focus, w.id);
  return (
    <div className="flex items-center gap-0.5">
      <IconButton label="Open" title={locked && focus ? `Focus mode: locked until ${clockTime(focus.endsAt)}` : "Open"} disabled={locked} onClick={a.open}>
        {locked ? <Lock className="size-4" /> : <Play className="size-4 fill-current" />}
      </IconButton>
      <Dropdown
        trigger={(open) => (
          <IconButton label="More" active={open}>
            <MoreHorizontal className="size-4" />
          </IconButton>
        )}
        items={[
          { label: "Details", icon: <Info />, onClick: a.details },
          { label: "Customize for a run", icon: <SlidersHorizontal />, disabled: locked, onClick: a.customize },
          { label: "Edit in Builder", icon: <Pencil />, onClick: a.edit },
          { label: "New from it", icon: <Copy />, onClick: a.copy },
          "divider" as const,
          { label: "Delete", icon: <Trash2 />, danger: true, onClick: a.remove },
        ]}
      />
    </div>
  );
}

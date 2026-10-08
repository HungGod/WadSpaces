import { Link } from "react-router";
import { ArrowRight, Trash2 } from "lucide-react";
import { backend } from "@/data";
import { timeAgo } from "@/lib/format";
import { useApp } from "@/lib/store";
import type { Draft } from "@/lib/types";
import { DesktopThumb } from "./desktop/DesktopThumb";
import { Button, IconButton } from "./ui";

const STEP_LABEL: Record<Draft["step"], string> = { apps: "Step 1 · Apps", projects: "Step 2 · Projects", customize: "Step 3 · Customize" };

/** Saved-but-unbuilt Builder work, ready to pick back up. */
export function DraftGrid({ items }: { items: Draft[] }) {
  const wadspaces = useApp((s) => s.wadspaces);
  const loadDrafts = useApp((s) => s.loadDrafts);
  const toast = useApp((s) => s.toast);

  const remove = async (d: Draft) => {
    if (!confirm(`Delete the draft "${d.name}"? Unbuilt changes will be lost.`)) return;
    await backend.deleteDraft(d.id);
    await loadDrafts();
    toast({ title: "Draft deleted", body: d.name });
  };

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {items.map((d) => {
          const base = d.wadspaceId && wadspaces.find((w) => w.id === d.wadspaceId);
          const apps = d.layout.icons.length;
          return (
            <div key={d.id} className="group flex flex-col overflow-hidden rounded-2xl border border-dashed border-line-strong bg-surface/60 transition-colors hover:border-accent/50 hover:bg-surface">
              <Link to={`/builder?draft=${d.id}`} className="relative block">
                <DesktopThumb layout={d.layout} className="aspect-[16/7] w-full" />
                <span className="absolute left-2.5 top-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[10.5px] font-medium text-white ring-1 ring-white/15 backdrop-blur-md">{STEP_LABEL[d.step]}</span>
              </Link>
              <div className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{d.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    {base ? `Unbuilt changes to ${base.name}` : `${apps} app${apps === 1 ? "" : "s"}`} · saved {timeAgo(d.updatedAt)}
                  </div>
                </div>
                <IconButton label="Delete draft" onClick={() => remove(d)}>
                  <Trash2 className="size-4" />
                </IconButton>
                <Link to={`/builder?draft=${d.id}`}>
                  <Button size="sm" variant="primary">
                    Continue <ArrowRight className="size-3.5" />
                  </Button>
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

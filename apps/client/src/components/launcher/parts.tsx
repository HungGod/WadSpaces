// Small pieces the launcher and the wadspace drawer share: section headings,
// a layer image's state and its Build button, and choice cards.
import { Hammer, Loader2 } from "lucide-react";
import clsx from "clsx";
import { imageRef, type LayerKey } from "@core/layers";
import type { ImageState } from "@/data/layers";
import { timeAgo } from "@/lib/format";
import { useApp } from "@/lib/store";
import { Badge, Button } from "../ui";

export function Heading({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h3>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

const LABEL: Record<ImageState, string> = { never: "Not built", built: "Built", changed: "Changed since built", building: "Building" };

/** Where a layer's image stands on the launch machine (re-rendered as builds and images change). */
export function useImageState(key: LayerKey | null): ImageState {
  useApp((s) => s.builds);
  useApp((s) => s.images);
  useApp((s) => s.templates);
  useApp((s) => s.extensions);
  return key ? useApp.getState().imageState(key) : "never";
}

/** The running build of a layer, if there is one. */
export const useLayerBuild = (key: LayerKey | null) => useApp((s) => (key ? [...s.builds].reverse().find((b) => b.layer === key) : undefined));

export function ImageBadge({ image, glass }: { image: LayerKey; glass?: boolean }) {
  const state = useImageState(image);
  const at = useApp((s) => s.images[image]?.builtAt);
  const job = useLayerBuild(image);
  return (
    <Badge tone={glass ? "glass" : state === "changed" || state === "never" ? "accent-2" : "default"}>
      {state === "building" && <Loader2 className="size-3 animate-spin" />}
      {state === "built" && at ? `Built ${timeAgo(at * 1000)}` : state === "building" && job?.status === "building" ? `Building ${Math.round(job.progress * 100)}%` : LABEL[state]}
    </Badge>
  );
}

/** A layer's build button, when it needs one; the build's log is in the sidebar. */
export function BuildButton({ image, size = "sm" }: { image: LayerKey; size?: "sm" | "md" }) {
  const state = useImageState(image);
  const build = useApp((s) => s.build);
  const job = useLayerBuild(image);
  const setBuildLog = useApp((s) => s.setBuildLog);
  if (state === "building" && job) {
    return (
      <Button size={size} variant="ghost" onClick={() => setBuildLog(job.id)}>
        <Loader2 className="size-3.5 animate-spin" /> Build log
      </Button>
    );
  }
  if (state === "built") return null;
  return (
    <Button size={size} variant="secondary" disabled={state === "building"} onClick={() => void build(image)} title={imageRef(image)}>
      {state === "building" ? <Loader2 className="size-3.5 animate-spin" /> : <Hammer className="size-3.5" />} {state === "building" ? "Building…" : state === "changed" ? "Rebuild" : "Build image"}
    </Button>
  );
}

/** A choice between two or three options, as cards. */
export function Choice({ on, onClick, icon, title, body }: { on: boolean; onClick: () => void; icon?: React.ReactNode; title: string; body: string }) {
  return (
    <button type="button" onClick={onClick} className={clsx("flex gap-3 rounded-2xl p-3 text-left ring-1 transition-all", on ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}>
      {icon && <span className={clsx("grid size-8 shrink-0 place-items-center rounded-xl", on ? "bg-accent text-accent-fg" : "bg-surface-3 text-muted")}>{icon}</span>}
      <span className="min-w-0">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs text-muted">{body}</span>
      </span>
    </button>
  );
}

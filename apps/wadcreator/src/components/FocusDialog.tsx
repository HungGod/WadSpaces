import { useEffect, useState } from "react";
import { Check, Loader2, Lock, Timer } from "lucide-react";
import clsx from "clsx";
import { startFocus } from "@/lib/launch";
import { useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";
import { Thumb } from "./Thumb";
import { Button, Input, Label, Modal } from "./ui";

const PRESETS = [1, 25, 50, 90];

export function FocusDialog() {
  const { focusOpen, focusPreselect, closeFocus } = useUi();
  const wadspaces = useApp((s) => s.wadspaces);
  const [selected, setSelected] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(25);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (focusOpen) {
      setSelected(focusPreselect);
      setMinutes(25);
    }
  }, [focusOpen, focusPreselect]);

  const start = async () => {
    setBusy(true);
    if (await startFocus(selected, minutes)) closeFocus();
    setBusy(false);
  };

  return (
    <Modal open={focusOpen} onClose={closeFocus} title="Start a focus session" subtitle="Open one or more wadspaces behind a timer. Nothing else can be opened until it ends." width={600}>
      <Label hint={`${selected.length} selected`}>Wadspaces</Label>
      <div className="grid max-h-[300px] grid-cols-2 gap-2 overflow-y-auto pr-1">
        {wadspaces.map((w) => {
          const on = selected.includes(w.id);
          return (
            <button
              key={w.id}
              type="button"
              onClick={() => setSelected(on ? selected.filter((x) => x !== w.id) : [...selected, w.id])}
              className={clsx("flex items-center gap-2.5 rounded-2xl p-1.5 pr-3 text-left ring-1 transition-all", on ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}
            >
              <Thumb ws={w} className="!w-20 shrink-0 rounded-xl" />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{w.name}</span>
              <span className={clsx("grid size-5 shrink-0 place-items-center rounded-full", on ? "bg-accent text-accent-fg" : "ring-1 ring-line-strong")}>{on && <Check className="size-3" />}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-5">
        <Label>Duration</Label>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((m) => (
            <button key={m} type="button" onClick={() => setMinutes(m)} className={clsx("h-10 rounded-xl px-4 text-sm font-medium ring-1 transition-colors", minutes === m ? "bg-accent text-accent-fg ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}>
              {m} min{m === 1 && <span className="ml-1 text-xs opacity-60">(test)</span>}
            </button>
          ))}
          <div className="flex items-center gap-2">
            <Input type="number" min={1} max={600} value={minutes} onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))} className="!w-24" />
            <span className="text-sm text-muted">minutes</span>
          </div>
        </div>
      </div>

      <div className="mt-5 flex gap-3 rounded-2xl bg-accent-soft p-3.5 text-sm ring-1 ring-accent/20">
        <Lock className="mt-0.5 size-4 shrink-0 text-accent" />
        <p className="text-muted">
          <b className="text-fg">There&apos;s no cancel button.</b> Until the timer runs out you can&apos;t open, stream or switch to any other wadspace. Restart WAD SPACES (restart <code className="font-mono text-xs">npm run dev</code>) to exit early.
        </p>
      </div>

      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={closeFocus}>Cancel</Button>
        <Button variant="primary" onClick={start} disabled={busy || !selected.length}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Timer className="size-4" />} Lock in for {minutes} min
        </Button>
      </div>
    </Modal>
  );
}

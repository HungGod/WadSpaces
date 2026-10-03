// What the machine app draws for wadd, now that it's the shell (the window on
// sway's "shell" workspace): the Wi-Fi menu the HUD asks for, the sidebar's
// menus, wadd's notices, which wadspace is starting, and (after a restart
// mid-focus) whether to go back to the focus session. The Super+Tab switcher
// and the power menu are drawn by the HUD itself (host/.../hud), above
// whatever is on screen.
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cast, Loader2, Power, Timer, Wifi } from "lucide-react";
import { useApp } from "@/lib/store";
import { wadd, type Session } from "@/lib/wadd";
import { Button, Modal } from "../ui";
import { GithubSignInDialog } from "./GithubSignIn";
import { onMachinePanel, type Panel } from "./panels";
import { PowerPanel } from "./PowerPanel";
import { StreamsPanel } from "./StreamsPanel";
import { useWaddEvent, useWaddState } from "./useWadd";
import { WifiPanel } from "./WifiPanel";


const focusLeft = (s: Session) => {
  if (s.ends_at == null) return `${s.minutes ?? 25} minutes, from when you open it`;
  const m = Math.max(1, Math.ceil(((s.remaining_s ?? 0) as number) / 60));
  return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min left` : `${m} min left`;
};

/** The machine started (or the app restarted) in the middle of a focus
 *  session: go back to it, or end it early. Asked once per start. */
function FocusResume() {
  const snap = useWaddState();
  const [asked, setAsked] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useApp((s) => s.toast);

  useEffect(() => {
    if (!snap || asked) return;
    setAsked(true);
    const s = snap.session;
    if (s && s.mode === "focus" && !s.expired) setOpen(true);
  }, [snap, asked]);

  const s = snap?.session;
  if (!s) return null;
  const names = s.workspaces.map((id) => snap!.workspaces.find((w) => w.id === id)?.name ?? id);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      setOpen(false);
    } catch (e) {
      toast({ title: "Couldn't do that", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={() => {}}
      dismissable={false}
      width={460}
      title={
        <span className="flex items-center gap-2">
          <Timer className="size-5 text-accent" /> You're in a focus session
        </span>
      }
      subtitle={`${names.join(", ")} · ${focusLeft(s)}`}
    >
      <p className="text-sm text-muted">The machine restarted while it was running. Pick up where you were, or end it now.</p>
      <div className="mt-6 flex gap-2">
        <Button variant="primary" className="flex-1" disabled={busy} onClick={() => act(() => wadd.action(s.workspaces[0], "switch"))}>
          Back to focus
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => act(() => wadd.endSession(true))}>
          End it early
        </Button>
      </div>
    </Modal>
  );
}

export function MachineChrome() {
  const snap = useWaddState();
  const toast = useApp((s) => s.toast);
  const [panel, setPanel] = useState<{ which: Panel; fromHud: boolean } | null>(null);

  useEffect(() => onMachinePanel((which) => setPanel({ which, fromHud: false })), []);

  useWaddEvent(
    useCallback(
      (event: string, data: unknown) => {
        if (event === "panel") setPanel({ which: (data as { panel: Panel }).panel, fromHud: true });
        else if (event === "notice") toast({ title: (data as { text: string }).text });
      },
      [toast],
    ),
  );

  const close = () => {
    // Opened from the HUD over a wadspace: wadd puts that back.
    if (panel?.fromHud) wadd.hudClosed().catch(() => {});
    setPanel(null);
  };

  const pending = snap?.pending ? snap.workspaces.find((w) => w.id === snap.pending) : undefined;

  return (
    <>
      <Modal
        open={panel?.which === "wifi"}
        onClose={close}
        title={
          <span className="flex items-center gap-2">
            <Wifi className="size-5" /> Wi-Fi
          </span>
        }
      >
        <WifiPanel />
      </Modal>
      <Modal
        open={panel?.which === "power"}
        onClose={close}
        width={380}
        title={
          <span className="flex items-center gap-2">
            <Power className="size-5" /> Power
          </span>
        }
      >
        <PowerPanel />
      </Modal>
      <Modal
        open={panel?.which === "streams"}
        onClose={close}
        width={600}
        title={
          <span className="flex items-center gap-2">
            <Cast className="size-5" /> Viewing from other devices
          </span>
        }
      >
        <StreamsPanel />
      </Modal>
      <GithubSignInDialog open={panel?.which === "github"} onClose={close} />
      <FocusResume />


      <AnimatePresence>
        {pending && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed bottom-6 left-1/2 z-[90] flex -translate-x-1/2 items-center gap-3 rounded-full bg-bg-2/95 px-5 py-2.5 text-sm shadow-deep ring-1 ring-line-strong"
          >
            <Loader2 className="size-4 animate-spin text-accent" />
            <span className="font-medium">Starting {pending.name}</span>
            {pending.state.message && <span className="max-w-[40ch] truncate text-muted">{pending.state.message}</span>}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

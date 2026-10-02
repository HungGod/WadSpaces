// What the machine app draws for wadd, now that it's the shell (the window on
// sway's "shell" workspace): the HUD's Wi-Fi and power menus, the Super+Tab
// switcher, wadd's notices, and which wadspace is starting.
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Loader2, Power, Wifi } from "lucide-react";
import clsx from "clsx";
import { useApp } from "@/lib/store";
import { wadd } from "@/lib/wadd";
import { Modal } from "../ui";
import { GithubSignInDialog } from "./GithubSignIn";
import { onMachinePanel, type Panel } from "./panels";
import { PowerPanel } from "./PowerPanel";
import { useWaddEvent, useWaddState } from "./useWadd";
import { WifiPanel } from "./WifiPanel";

interface CarouselItem {
  view: string;
  name: string;
  running: boolean;
}
interface Carousel {
  open: boolean;
  items?: CarouselItem[];
  index?: number;
}

export function MachineChrome() {
  const snap = useWaddState();
  const toast = useApp((s) => s.toast);
  const [panel, setPanel] = useState<{ which: Panel; fromHud: boolean } | null>(null);
  const [carousel, setCarousel] = useState<Carousel>({ open: false });

  useEffect(() => onMachinePanel((which) => setPanel({ which, fromHud: false })), []);

  useWaddEvent(
    useCallback(
      (event: string, data: unknown) => {
        if (event === "panel") setPanel({ which: (data as { panel: Panel }).panel, fromHud: true });
        else if (event === "carousel") setCarousel(data as Carousel);
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
      <GithubSignInDialog open={panel?.which === "github"} onClose={close} />

      <AnimatePresence>
        {carousel.open && carousel.items && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] grid place-items-center bg-black/60 backdrop-blur-md"
          >
            <div className="flex max-w-[90vw] gap-4 overflow-hidden rounded-3xl bg-bg-2/90 p-6 ring-1 ring-line-strong">
              {carousel.items.map((it, i) => (
                <div
                  key={it.view}
                  className={clsx(
                    "flex w-36 flex-col items-center gap-3 rounded-2xl p-4 transition",
                    i === carousel.index ? "bg-accent-soft ring-2 ring-accent" : "opacity-70",
                  )}
                >
                  <span className="grid size-16 place-items-center rounded-2xl bg-surface-3 font-display text-2xl font-bold">{it.name.slice(0, 1).toUpperCase()}</span>
                  <span className="w-full truncate text-center text-sm font-medium">{it.name}</span>
                  {!it.running && <span className="text-[11px] text-faint">not running</span>}
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

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

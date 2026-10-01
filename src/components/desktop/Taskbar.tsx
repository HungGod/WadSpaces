import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { BatteryFull, Search, Volume2, Wifi } from "lucide-react";
import clsx from "clsx";
import type { LayoutIcon } from "@/lib/types";
import { TASKBAR_H } from "./geometry";
import type { Win } from "./useWindows";
import { localIcon } from "@core/catalog/icons";

interface Props {
  wins: Win[];
  activeId: string | null;
  icons: LayoutIcon[];
  title: string;
  onWindowClick: (id: string) => void;
  onLaunch: (icon: LayoutIcon) => void;
}

export function Taskbar({ wins, activeId, icons, title, onWindowClick, onLaunch }: Props) {
  const [now, setNow] = useState<Date | null>(null);
  const [menu, setMenu] = useState(false);
  const [q, setQ] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => !menuRef.current?.contains(e.target as Node) && setMenu(false);
    window.addEventListener("pointerdown", close, true);
    return () => window.removeEventListener("pointerdown", close, true);
  }, [menu]);

  const filtered = icons.filter((i) => i.label.toLowerCase().includes(q.toLowerCase()));

  return (
    <div
      ref={menuRef}
      className="absolute inset-x-0 bottom-0 z-[9000] flex items-center gap-1 border-t border-white/10 bg-[#0a0614]/70 px-2 text-white backdrop-blur-xl"
      style={{ height: TASKBAR_H }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <button
        type="button"
        aria-label="Start"
        onClick={() => setMenu((m) => !m)}
        className={clsx("grid size-9 place-items-center rounded-lg transition-colors hover:bg-white/10", menu && "bg-white/15")}
      >
        <img src="/brand/wadspaces-icon-dark-transparent.svg" alt="" className="size-7" draggable={false} />
      </button>

      <div className="mx-1 h-5 w-px bg-white/10" />

      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {wins.map((w) => (
          <button
            key={w.id}
            type="button"
            onClick={() => onWindowClick(w.id)}
            className={clsx(
              "relative flex h-9 max-w-[180px] shrink-0 items-center gap-2 rounded-lg px-2.5 text-[12.5px] transition-colors",
              w.id === activeId ? "bg-white/15" : "hover:bg-white/10",
              w.minimized && "opacity-60",
            )}
          >
            <img src={localIcon(w.iconUrl)} alt="" className="size-4 rounded-sm" draggable={false} />
            <span className="truncate">{w.title}</span>
            <span
              className={clsx(
                "absolute bottom-0.5 left-1/2 h-[3px] -translate-x-1/2 rounded-full transition-all",
                w.id === activeId ? "w-5 bg-[#c6ff1f]" : "w-1.5 bg-white/50",
              )}
            />
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2.5 px-2 text-white/80">
        <Wifi className="size-4" />
        <Volume2 className="size-4" />
        <BatteryFull className="size-4" />
        <div className="text-right text-[11px] leading-tight tabular-nums" suppressHydrationWarning>
          {now && (
            <>
              <div>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
              <div className="text-white/50">{now.toLocaleDateString([], { month: "short", day: "numeric" })}</div>
            </>
          )}
        </div>
      </div>

      <AnimatePresence>
        {menu && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.1 } }}
            className="absolute bottom-[calc(100%+8px)] left-2 w-[340px] rounded-2xl border border-white/10 bg-[#140d22]/90 p-3 shadow-2xl backdrop-blur-2xl"
          >
            <div className="mb-3 flex items-center gap-2 rounded-lg bg-white/5 px-2.5 py-2 ring-1 ring-white/10">
              <Search className="size-4 text-white/50" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search apps"
                className="w-full bg-transparent text-sm outline-none placeholder:text-white/40"
              />
            </div>
            <div className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wider text-white/40">{title}</div>
            {filtered.length ? (
              <div className="grid grid-cols-4 gap-1">
                {filtered.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => {
                      onLaunch(i);
                      setMenu(false);
                    }}
                    className="flex flex-col items-center gap-1.5 rounded-lg p-2 text-[11px] hover:bg-white/10"
                  >
                    <img src={localIcon(i.iconUrl)} alt="" className="size-8 rounded-md" draggable={false} />
                    <span className="line-clamp-1">{i.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-1 py-6 text-center text-sm text-white/50">No apps on this desktop yet.</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

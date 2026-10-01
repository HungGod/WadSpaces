import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Maximize2, Minimize2 } from "lucide-react";
import { LogoMark } from "./Logo";

/** Auto-hiding strip across the top of a wadspace viewer. Reveals when the pointer nears the top edge. */
export function ViewerBar({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  const [shown, setShown] = useState(true);
  const [full, setFull] = useState(false);
  const hover = useRef(false);

  useEffect(() => {
    let t = setTimeout(() => !hover.current && setShown(false), 2800);
    const move = (e: PointerEvent) => {
      if (e.clientY < 10) {
        setShown(true);
        clearTimeout(t);
      } else if (e.clientY > 90 && !hover.current) {
        clearTimeout(t);
        t = setTimeout(() => setShown(false), 600);
      }
    };
    const fs = () => setFull(!!document.fullscreenElement);
    window.addEventListener("pointermove", move);
    document.addEventListener("fullscreenchange", fs);
    return () => {
      clearTimeout(t);
      window.removeEventListener("pointermove", move);
      document.removeEventListener("fullscreenchange", fs);
    };
  }, []);

  return (
    <>
      <div className="fixed inset-x-0 top-0 z-[10000] h-2" onPointerEnter={() => setShown(true)} />
      <AnimatePresence>
        {shown && (
          <motion.div
            initial={{ y: -60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -60, opacity: 0 }}
            transition={{ type: "spring", stiffness: 500, damping: 40 }}
            onPointerEnter={() => (hover.current = true)}
            onPointerLeave={() => (hover.current = false)}
            className="fixed left-1/2 top-2 z-[10001] flex -translate-x-1/2 items-center gap-3 rounded-2xl border border-white/10 bg-[#0a0614]/80 py-1.5 pl-2 pr-1.5 text-white shadow-2xl backdrop-blur-xl"
          >
            <LogoMark className="size-7" />
            <div className="flex items-center gap-3 text-[13px]">{children}</div>
            <div className="ml-1 flex items-center gap-1">
              {right}
              <button
                type="button"
                onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}
                className="grid size-8 place-items-center rounded-lg text-white/70 hover:bg-white/10 hover:text-white"
                title={full ? "Exit fullscreen" : "Fullscreen"}
                aria-label="Toggle fullscreen"
              >
                {full ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

import { AnimatePresence, motion } from "motion/react";
import { Check, Loader2 } from "lucide-react";
import { LogoMark } from "./Logo";

export interface BootStep {
  label: string;
  done: boolean;
}

/** Full-window boot/connect sequence shown before a wadspace appears. */
export function BootScreen({ title, subtitle, steps, progress, children }: { title: string; subtitle?: string; steps: BootStep[]; progress?: number; children?: React.ReactNode }) {
  return (
    <div className="ws-backdrop grid h-screen place-items-center overflow-hidden p-6">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <div className="mb-6 flex justify-center">
          <motion.div animate={{ scale: [1, 1.06, 1] }} transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}>
            <LogoMark className="size-20 drop-shadow-[0_10px_40px_rgba(255,61,129,0.35)]" />
          </motion.div>
        </div>
        <h1 className="text-center font-display text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1 text-center text-sm text-muted">{subtitle}</p>}

        <div className="mt-7 rounded-2xl border border-line bg-surface/70 p-4 font-mono text-[12.5px] backdrop-blur">
          <AnimatePresence initial={false}>
            {steps.map((s, i) => (
              <motion.div key={`${i}-${s.label}`} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} className="flex items-center gap-2.5 py-1">
                {s.done ? <Check className="size-3.5 text-fg dark:text-accent" /> : <Loader2 className="size-3.5 animate-spin text-accent" />}
                <span className={s.done ? "text-muted" : "text-fg"}>{s.label}</span>
              </motion.div>
            ))}
          </AnimatePresence>
          {progress !== undefined && (
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full rounded-full bg-accent transition-[width] duration-150" style={{ width: `${progress * 100}%` }} />
            </div>
          )}
        </div>
        {children}
      </motion.div>
    </div>
  );
}

export function MessageScreen({ icon, title, body, children }: { icon: React.ReactNode; title: string; body?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="ws-backdrop grid h-screen place-items-center p-6">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md rounded-3xl border border-line bg-surface p-8 text-center shadow-deep">
        <div className="mx-auto mb-5 grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">{icon}</div>
        <h1 className="font-display text-xl font-bold tracking-tight">{title}</h1>
        {body && <div className="mt-2 text-sm text-muted">{body}</div>}
        {children && <div className="mt-6">{children}</div>}
      </motion.div>
    </div>
  );
}

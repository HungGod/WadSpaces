import { AnimatePresence, motion } from "motion/react";
import { CheckCircle2, CircleAlert, Info, X } from "lucide-react";
import clsx from "clsx";
import { useApp } from "@/lib/store";
import { Progress } from "./ui";

export function Toaster() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[340px] flex-col gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, transition: { duration: 0.15 } }}
            className="pointer-events-auto rounded-2xl border border-line bg-surface/95 p-3.5 shadow-deep backdrop-blur-xl"
          >
            <div className="flex items-start gap-3">
              <span className={clsx("mt-0.5", t.tone === "success" ? "text-fg dark:text-accent" : t.tone === "error" ? "text-accent" : "text-muted")}>
                {t.tone === "success" ? <CheckCircle2 className="size-4 text-fg dark:text-accent" /> : t.tone === "error" ? <CircleAlert className="size-4" /> : <Info className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t.title}</div>
                {t.body && <div className="mt-0.5 line-clamp-2 text-[13px] text-muted">{t.body}</div>}
                {t.progress !== undefined && <Progress value={t.progress} className="mt-2.5" />}
                {t.action && (
                  <button
                    type="button"
                    onClick={() => {
                      t.action!.onClick();
                      dismiss(t.id);
                    }}
                    className="mt-2.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg hover:brightness-110"
                  >
                    {t.action.label}
                  </button>
                )}
              </div>
              <button type="button" onClick={() => dismiss(t.id)} className="text-faint hover:text-fg" aria-label="Dismiss">
                <X className="size-3.5" />
              </button>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

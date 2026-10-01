import { forwardRef, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import clsx from "clsx";
import type { PublicUser } from "@/lib/types";

type Variant = "primary" | "secondary" | "ghost" | "maroon" | "danger";

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:brightness-110 shadow-[0_8px_24px_-10px_var(--accent)]",
  maroon: "bg-accent-2 text-accent-2-fg hover:brightness-110",
  secondary: "bg-surface-2 text-fg ring-1 ring-line hover:bg-surface-3 hover:ring-line-strong",
  ghost: "text-muted hover:bg-surface-2 hover:text-fg",
  danger: "text-danger ring-1 ring-danger/30 hover:bg-danger/10",
};

export const Button = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }>(
  function Button({ variant = "secondary", size = "md", className, ...props }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...props}
        className={clsx(
          "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition-all active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40",
          size === "sm" && "h-8 px-3 text-[13px]",
          size === "md" && "h-10 px-4 text-sm",
          size === "lg" && "h-12 px-6 text-[15px]",
          VARIANTS[variant],
          className,
        )}
      />
    );
  },
);

export function IconButton({ label, className, active, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      title={props.title ?? label}
      aria-label={label}
      {...props}
      className={clsx(
        "grid size-9 shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-35",
        active && "bg-surface-2 text-fg",
        className,
      )}
    />
  );
}

export function Badge({ children, tone = "default", className }: { children: React.ReactNode; tone?: "default" | "accent" | "accent-2" | "glass"; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "default" && "bg-surface-2 text-muted ring-1 ring-line",
        tone === "accent" && "bg-accent-soft text-accent ring-1 ring-accent/25",
        tone === "accent-2" && "bg-accent-2-soft text-fg ring-1 ring-accent-2/45",
        tone === "glass" && "bg-black/45 text-white ring-1 ring-white/15 backdrop-blur-md",
        className,
      )}
    >
      {children}
    </span>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      {...props}
      className={clsx(
        "h-10 w-full rounded-xl bg-surface-2 px-3 text-sm text-fg outline-none ring-1 ring-line transition placeholder:text-faint focus:ring-2 focus:ring-accent",
        className,
      )}
    />
  );
});

export function Textarea({ className, ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={clsx(
        "w-full resize-none rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-fg outline-none ring-1 ring-line transition placeholder:text-faint focus:ring-2 focus:ring-accent",
        className,
      )}
    />
  );
}

export function Label({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
  return (
    <div className="mb-1.5 flex items-center justify-between text-xs font-medium text-muted">
      <span>{children}</span>
      {hint && <span className="font-normal text-faint">{hint}</span>}
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, className }: { value: T; options: { value: T; label: React.ReactNode }[]; onChange: (v: T) => void; className?: string }) {
  return (
    <div className={clsx("inline-flex rounded-xl bg-surface-2 p-1 ring-1 ring-line", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={clsx(
            "relative flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors",
            value === o.value ? "text-fg" : "text-muted hover:text-fg",
          )}
        >
          {value === o.value && <motion.span layoutId={`seg-${options.map((x) => x.value).join()}`} className="absolute inset-0 rounded-lg bg-surface shadow-sm ring-1 ring-line-strong" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
          <span className="relative flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx("relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40", checked ? "bg-accent" : "bg-surface-3 ring-1 ring-line-strong")}
    >
      <span className={clsx("absolute top-1 size-4 rounded-full shadow transition-all", checked ? "left-6 bg-accent-fg" : "left-1 bg-fg/70")} />
    </button>
  );
}

export function Avatar({ user, size = 28, className }: { user?: Pick<PublicUser, "displayName" | "color"> | null; size?: number; className?: string }) {
  const name = user?.displayName ?? "?";
  return (
    <span
      className={clsx("ws-avatar inline-grid shrink-0 place-items-center rounded-full font-display font-bold text-[#0a0614] ring-2 ring-bg", className)}
      style={{ width: size, height: size, fontSize: size * 0.42, background: user?.color ?? "#999" }}
      title={name}
    >
      {name[0]?.toUpperCase()}
    </span>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={clsx("h-1.5 overflow-hidden rounded-full bg-surface-3", className)}>
      <div className="ws-progress-stripes h-full rounded-full bg-accent transition-[width] duration-200" style={{ width: `${Math.round(value * 100)}%`, backgroundColor: "var(--accent)" }} />
    </div>
  );
}

export function Meter({ value, tone = "accent" }: { value: number; tone?: "accent" | "accent-2" }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
      <div className={clsx("h-full rounded-full transition-[width] duration-700", tone === "accent" ? "bg-accent" : "bg-accent-2")} style={{ width: `${value}%` }} />
    </div>
  );
}

export function Modal({ open, onClose, title, subtitle, children, width = 520, dismissable = true }: { open: boolean; onClose: () => void; title?: React.ReactNode; subtitle?: React.ReactNode; children: React.ReactNode; width?: number; dismissable?: boolean }) {
  useEffect(() => {
    if (!open || !dismissable) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose, dismissable]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 grid place-items-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-[#05030b]/60 backdrop-blur-sm" onClick={() => dismissable && onClose()} />
          <motion.div
            role="dialog"
            aria-modal
            initial={{ opacity: 0, y: 16, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className="relative max-h-[90vh] w-full overflow-y-auto rounded-3xl border border-line bg-surface p-6 shadow-deep"
            style={{ maxWidth: width }}
          >
            {(title || dismissable) && (
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  {title && <h2 className="font-display text-xl font-semibold tracking-tight">{title}</h2>}
                  {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
                </div>
                {dismissable && (
                  <IconButton label="Close" onClick={onClose} className="-mr-2 -mt-1">
                    <X className="size-4" />
                  </IconButton>
                )}
              </div>
            )}
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function Drawer({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-[#05030b]/50 backdrop-blur-[2px]" onClick={onClose} />
          <motion.aside
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 380, damping: 40 }}
            className="absolute inset-y-0 right-0 flex w-full max-w-[520px] flex-col border-l border-line bg-surface shadow-deep"
          >
            {children}
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: React.ReactNode; title: string; body?: string; action?: React.ReactNode }) {
  return (
    <div className="grid place-items-center rounded-3xl border border-dashed border-line-strong px-6 py-16 text-center">
      <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">{icon}</div>
      <h3 className="font-display text-lg font-semibold">{title}</h3>
      {body && <p className="mt-1 max-w-sm text-sm text-muted">{body}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="font-display text-3xl font-bold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export interface MenuEntry {
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
}

/** A small click-to-open menu anchored to its trigger. */
export function Dropdown({ trigger, items, align = "right" }: { trigger: (open: boolean) => React.ReactNode; items: (MenuEntry | "divider")[]; align?: "left" | "right" }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", esc);
    };
  }, [open, setOpen, ref]);
  const visible = items.filter((i) => i === "divider" || !i.hidden);
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen(!open)}>{trigger(open)}</div>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98, transition: { duration: 0.1 } }}
            className={clsx("absolute top-[calc(100%+6px)] z-30 min-w-[210px] rounded-2xl border border-line bg-surface p-1.5 shadow-deep", align === "right" ? "right-0 origin-top-right" : "left-0 origin-top-left")}
          >
            {visible.map((item, i) =>
              item === "divider" ? (
                <div key={`d${i}`} className="my-1 h-px bg-line" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onClick();
                  }}
                  className={clsx(
                    "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[13px] transition-colors disabled:opacity-40",
                    item.danger ? "text-danger hover:bg-danger/10" : "text-fg hover:bg-surface-2",
                  )}
                >
                  <span className="text-muted [&>svg]:size-4">{item.icon}</span>
                  {item.label}
                </button>
              ),
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

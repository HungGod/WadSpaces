import { motion } from "motion/react";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

/** Shared frame for the sign-in and create-account screens. */
export function AuthCard({ children }: { children: React.ReactNode }) {
  return (
    <main className="ws-backdrop relative grid min-h-screen place-items-center overflow-hidden p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden dark:block">
        <motion.div
          className="absolute -left-40 top-1/4 size-[520px] rounded-full bg-[#ff3d81]/20 blur-[120px]"
          animate={{ x: [0, 60, 0], y: [0, -40, 0] }}
          transition={{ duration: 18, repeat: Infinity, ease: "easeInOut" }}
        />
        <motion.div
          className="absolute -right-32 bottom-0 size-[460px] rounded-full bg-[#c6ff1f]/10 blur-[120px]"
          animate={{ x: [0, -50, 0], y: [0, 30, 0] }}
          transition={{ duration: 22, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
      <div className="absolute right-5 top-5 w-44">
        <ThemeToggle />
      </div>
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 200, damping: 26 }} className="relative w-full max-w-[420px]">
        <div className="mb-6 flex justify-center">
          <Logo className="h-36" />
        </div>
        {children}
        <p className="mt-6 text-center text-xs text-faint">WAD SPACES · your workspaces, on your machines</p>
      </motion.div>
    </main>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="mt-4 rounded-xl bg-accent-soft px-3 py-2 text-sm text-accent ring-1 ring-accent/20">
      {message}
    </motion.p>
  );
}

/** Google's "G", drawn inline so the button works offline and without the favicon service. */
function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" className="size-4" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2c-2 1.5-4.5 2.4-7.2 2.4-5.3 0-9.7-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

export function GoogleButton({ onClick, disabled, label = "Continue with Google", className }: { onClick: () => void; disabled?: boolean; label?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-11 w-full items-center justify-center gap-2.5 rounded-xl bg-surface-2 text-sm font-semibold ring-1 ring-line transition hover:ring-line-strong disabled:opacity-50 ${className ?? ""}`}
    >
      <GoogleG /> {label}
    </button>
  );
}

export function OrDivider() {
  return (
    <div className="my-5 flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.14em] text-faint">
      <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
    </div>
  );
}

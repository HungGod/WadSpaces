import { motion } from "motion/react";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";

/** Shared frame for the sign-in and setup screens. */
export function AuthCard({ children, wide }: { children: React.ReactNode; wide?: boolean }) {
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
      <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ type: "spring", stiffness: 200, damping: 26 }} className={wide ? "relative w-full max-w-[640px]" : "relative w-full max-w-[420px]"}>
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

/** GitHub's mark, drawn inline so the button works offline. */
function GithubMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function GithubButton({ onClick, disabled, label = "Sign in with GitHub", className }: { onClick: () => void; disabled?: boolean; label?: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-11 w-full items-center justify-center gap-2.5 rounded-xl bg-surface-2 text-sm font-semibold ring-1 ring-line transition hover:ring-line-strong disabled:opacity-50 ${className ?? ""}`}
    >
      <GithubMark /> {label}
    </button>
  );
}

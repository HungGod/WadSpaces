import { useState, type ReactNode } from "react";

export function Section({ title, hint, children, actions }: { title: string; hint?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card p-5">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          {hint && <p className="mt-0.5 text-sm text-muted">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function PageTitle({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "ok"; children: ReactNode }) {
  const color = kind === "error" ? "border-danger/40 text-danger" : kind === "ok" ? "border-accent/40 text-accent" : "border-line text-muted";
  return <div className={`rounded-lg border px-3.5 py-2.5 text-sm ${color}`}>{children}</div>;
}

export function Dot({ phase, container }: { phase: string; container: string }) {
  const busy = ["pulling", "starting", "waiting", "stopping"].includes(phase);
  const cls =
    phase === "error" ? "bg-danger" : busy ? "bg-busy animate-pulse" : phase === "ready" || container === "running" ? "bg-accent shadow-[0_0_8px] shadow-accent" : "bg-faint";
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${cls}`} />;
}

/** Editable list of rows with an Add button. */
export function RowList<T>({
  items,
  onChange,
  blank,
  render,
  addLabel,
}: {
  items: T[];
  onChange: (items: T[]) => void;
  blank: () => T;
  render: (item: T, set: (v: T) => void) => ReactNode;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-start gap-2">
          <div className="grid flex-1 gap-2 sm:grid-flow-col sm:auto-cols-fr">
            {render(item, (v) => onChange(items.map((x, j) => (j === i ? v : x))))}
          </div>
          <button type="button" className="btn btn-sm mt-0.5" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => onChange([...items, blank()])}>
        + {addLabel}
      </button>
    </div>
  );
}

export function useBusy() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, setError, run };
}

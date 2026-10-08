import clsx from "clsx";

/** A search field with the magnifier inside. */
export function SearchBox({ value, onChange, placeholder, autoFocus, className }: { value: string; onChange: (v: string) => void; placeholder: string; autoFocus?: boolean; className?: string }) {
  return (
    <label className={clsx("relative flex h-10 w-full max-w-xs items-center", className)}>
      <svg className="pointer-events-none absolute left-3 size-4 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-full w-full rounded-xl bg-surface px-3 pl-9 text-sm outline-none ring-1 ring-line transition placeholder:text-faint focus:ring-2 focus:ring-accent"
      />
    </label>
  );
}

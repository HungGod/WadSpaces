import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import clsx from "clsx";

export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as "dark" | "light") ?? "dark");
  }, []);
  const set = (t: "dark" | "light") => {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem("ws-theme", t);
    } catch {}
    setTheme(t);
  };
  return [theme, set] as const;
}

export function ThemeToggle({ compact }: { compact?: boolean }) {
  const [theme, setTheme] = useTheme();
  if (compact) {
    return (
      <button
        type="button"
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        className="grid size-9 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-fg"
        aria-label="Toggle theme"
        title="Toggle theme"
      >
        {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
      </button>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1 ring-1 ring-line">
      {(["dark", "light"] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => setTheme(t)}
          className={clsx("flex items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-medium transition-colors", theme === t ? "bg-surface text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg")}
        >
          {t === "dark" ? <Moon className="size-3.5" /> : <Sun className="size-3.5" />}
          {t === "dark" ? "Dark" : "Light"}
        </button>
      ))}
    </div>
  );
}

import clsx from "clsx";

/** The full lockup swaps between the dark (neon) and light (grayscale) SVGs with the theme. */
export function Logo({ className }: { className?: string }) {
  return (
    <span className={clsx("relative inline-block", className)}>
      <img src="/brand/wadspaces-logo-dark.svg" alt="WAD SPACES" className="hidden h-full w-auto dark:block" draggable={false} />
      <img src="/brand/wadspaces-logo-light.svg" alt="WAD SPACES" className="block h-full w-auto dark:hidden" draggable={false} />
    </span>
  );
}

export function LogoMark({ className }: { className?: string }) {
  return (
    <span className={clsx("relative inline-block", className)}>
      <img src="/brand/wadspaces-icon-dark-transparent.svg" alt="WAD SPACES" className="hidden size-full dark:block" draggable={false} />
      <img src="/brand/wadspaces-icon-light-transparent.svg" alt="WAD SPACES" className="block size-full dark:hidden" draggable={false} />
    </span>
  );
}

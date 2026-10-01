import clsx from "clsx";

export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx("mx-auto w-full max-w-[1440px] px-6 py-8 lg:px-10", className)}>{children}</div>;
}

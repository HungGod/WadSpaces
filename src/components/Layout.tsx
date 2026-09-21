import { NavLink, Outlet } from "react-router";
import { useAuth } from "../lib/auth";
import { firebaseEnabled } from "../lib/firebase";
import { WADD_URL } from "../lib/wadd";

const tabs = [
  { to: "/", label: "This machine", end: true },
  { to: "/library", label: "Workspaces" },
  { to: "/secrets", label: "Secrets" },
];

function Logo() {
  return (
    <svg viewBox="0 0 64 64" className="h-7 w-7" aria-hidden>
      <rect width="64" height="64" rx="14" fill="#141422" />
      <path d="M12 20l7 24 7-18 6 18 7-24" fill="none" stroke="#8fd18a" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="48" cy="40" r="5" fill="#8fd18a" />
    </svg>
  );
}

export default function Layout() {
  const { user, signIn, signOut, error } = useAuth();
  const backToLauncher = () =>
    fetch(`${WADD_URL}/api/launcher`, { method: "POST" }).catch(() => (location.href = `${WADD_URL}/`));

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2.5">
            <Logo />
            <span className="font-semibold tracking-tight">Wad Creator</span>
          </div>
          <nav className="order-3 flex w-full gap-1 overflow-x-auto sm:order-none sm:w-auto">
            {tabs.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm whitespace-nowrap transition ${
                    isActive ? "bg-hover text-ink" : "text-muted hover:text-ink"
                  }`
                }
              >
                {t.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            {firebaseEnabled &&
              (user ? (
                <button className="btn btn-sm" onClick={signOut} title={user.email ?? ""}>
                  Sign out
                </button>
              ) : (
                <button className="btn btn-sm" onClick={signIn}>
                  Sign in with Google
                </button>
              ))}
            <button className="btn btn-sm" onClick={backToLauncher} title="Super+0">
              Launcher
            </button>
          </div>
        </div>
      </header>
      {error && <div className="mx-auto max-w-6xl px-6 pt-4 text-sm text-danger">{error}</div>}
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}

import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Outlet, Route, Routes, useLocation, useParams, useSearchParams } from "react-router";
import { Loader2 } from "lucide-react";
import { backend } from "@/data";
import { Builder } from "@/components/builder/Builder";
import { Shell } from "@/components/Shell";
import { shell } from "@/lib/shell";
import type { PublicUser } from "@/lib/types";
import Home from "@/pages/Home";
import Launch from "@/pages/Launch";
import Manager from "@/pages/Manager";
import Projects from "@/pages/Projects";
import Wadspaces from "@/pages/Wadspaces";

// Online-only pages load Firebase Auth; the offline build never includes them.
// The target check is inline so the bundler can drop these chunks offline.
const online = import.meta.env.VITE_TARGET === "online";
const Login = online ? lazy(() => import("@/pages/Login")) : null;
const Signup = online ? lazy(() => import("@/pages/Signup")) : null;
const Welcome = online ? lazy(() => import("@/pages/Welcome")) : null;

function Spinner() {
  return (
    <div className="ws-backdrop grid h-screen place-items-center text-muted">
      <Loader2 className="size-6 animate-spin" />
    </div>
  );
}

type Auth = { kind: "loading" } | { kind: "in"; user: PublicUser } | { kind: "out" } | { kind: "welcome" } | { kind: "error"; message: string };

/** The signed-in app. Offline there's no sign-in: "you" are this machine. */
function AppLayout() {
  const [auth, setAuth] = useState<Auth>({ kind: "loading" });
  const location = useLocation();

  useEffect(() => {
    const check = () =>
      backend
        .me()
        .then((user) => setAuth(user ? { kind: "in", user } : { kind: "out" }))
        .catch((e: Error) => setAuth(e.name === "NeedsUsername" ? { kind: "welcome" } : { kind: "error", message: e.message }));
    check();
    return backend.subscribe((t) => t === "user" && check());
  }, []);

  if (auth.kind === "loading") return <Spinner />;
  if (auth.kind === "out") return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  if (auth.kind === "welcome") return <Navigate to="/welcome" replace />;
  if (auth.kind === "error") {
    return (
      <div className="ws-backdrop grid h-screen place-items-center p-6 text-center">
        <div>
          <p className="font-display text-lg font-semibold">Couldn't start Wad Creator</p>
          <p className="mt-1 text-sm text-muted">{auth.message}</p>
        </div>
      </div>
    );
  }
  return (
    <Shell user={auth.user}>
      <Outlet />
    </Shell>
  );
}

function NewBuilder() {
  const [params] = useSearchParams();
  const agent = params.get("agent");
  const template = params.get("template") ?? undefined;
  const draft = params.get("draft") ?? undefined;
  // `key` remounts the builder when switching between a blank, agent, template or draft start.
  const key = draft ? `draft-${draft}` : template ? `template-${template}` : agent === "1" ? "agent" : "blank";
  return <Builder key={key} agent={agent === "1"} template={template} draft={draft} />;
}

function EditBuilder() {
  const { id } = useParams();
  const [params] = useSearchParams();
  return <Builder key={id} id={id} duplicate={params.get("duplicate") === "1"} />;
}

export default function App() {
  // Tell the offline shell the UI started.
  useEffect(() => shell?.ready(), []);
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        {Login && Signup && Welcome && (
          <>
            <Route path="login" element={<Login />} />
            <Route path="signup" element={<Signup />} />
            <Route path="welcome" element={<Welcome />} />
          </>
        )}
        <Route element={<AppLayout />}>
          <Route index element={<Home />} />
          <Route path="wadspaces" element={<Wadspaces />} />
          <Route path="projects" element={<Projects />} />
          <Route path="launch" element={<Launch />} />
          <Route path="manager" element={<Manager />} />
          <Route path="builder" element={<NewBuilder />} />
          <Route path="builder/:id" element={<EditBuilder />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

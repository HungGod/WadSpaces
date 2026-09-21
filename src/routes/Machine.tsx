import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Dot, Notice, PageTitle, useBusy } from "../components/ui";
import type { WaddSpec } from "../lib/spec";
import { type MachineWorkspace, WADD_URL, useMachine, wadd } from "../lib/wadd";

const PHASE_LABEL: Record<string, string> = {
  idle: "Stopped",
  pulling: "Downloading…",
  starting: "Starting…",
  waiting: "Waiting for desktop…",
  ready: "Running",
  stopping: "Stopping…",
  error: "Error",
};

function label(ws: MachineWorkspace) {
  if (ws.state.phase === "idle" && ws.state.container === "running") return "Running";
  return PHASE_LABEL[ws.state.phase] ?? ws.state.phase;
}

export default function Machine() {
  const { snap, error } = useMachine();
  const { busy, error: actionError, run } = useBusy();
  const [disabled, setDisabled] = useState<WaddSpec[]>([]);

  // Disabled workspaces are not in the live snapshot; fetch them from the specs.
  useEffect(() => {
    if (!snap) return;
    const live = new Set(snap.workspaces.map((w) => w.id));
    wadd.specs().then((all) => setDisabled(all.filter((s) => !live.has(s.id)))).catch(() => {});
  }, [snap?.workspaces.length]);

  const act = (id: string, a: "switch" | "start" | "stop" | "restart") => run(`${id}:${a}`, () => wadd.action(id, a));
  const remove = (ws: { id: string; name: string }) => {
    if (!confirm(`Remove ${ws.name} from this machine? Its container is stopped; named volumes are kept.`)) return;
    run(`${ws.id}:remove`, () => wadd.remove(ws.id));
  };

  if (!snap) {
    return (
      <>
        <PageTitle title="This machine" />
        <Notice kind={error ? "error" : "info"}>{error ?? "Connecting to wadd…"}</Notice>
      </>
    );
  }

  return (
    <>
      <PageTitle
        title={snap.machine}
        sub={
          <>
            wadd {snap.version} · {snap.backend} backend {snap.backend_connected ? "connected" : "unreachable"} · kiosk{" "}
            {snap.kiosk_connected ? "connected" : "not connected"} · {snap.hotkey_devices} keyboard
            {snap.hotkey_devices === 1 ? "" : "s"} for hotkeys
          </>
        }
        actions={
          <Link className="btn btn-primary" to="/new">
            New workspace
          </Link>
        }
      />
      {error && <div className="mb-4"><Notice kind="error">{error}</Notice></div>}
      {actionError && <div className="mb-4"><Notice kind="error">{actionError}</Notice></div>}

      <div className="card divide-y divide-line">
        {snap.workspaces.length === 0 && <div className="p-6 text-sm text-muted">No workspaces on this machine yet.</div>}
        {snap.workspaces.map((ws) => {
          const running = ws.state.container === "running";
          const b = (a: string) => busy === `${ws.id}:${a}`;
          return (
            <div key={ws.id} className="flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
              <div className="h-12 w-20 shrink-0 overflow-hidden rounded-md border border-line bg-bg">
                {ws.icon && <img src={`${WADD_URL}${ws.icon}`} alt="" className="h-full w-full object-contain" />}
              </div>
              <div className="min-w-[12rem] flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{ws.name}</span>
                  {ws.hotkey && <span className="kbd">Super {ws.hotkey}</span>}
                  {snap.view === `workspace:${ws.id}` && <span className="text-xs text-accent">on screen</span>}
                </div>
                <div className="mt-1 flex items-center gap-2 text-sm text-muted">
                  <Dot phase={ws.state.phase} container={ws.state.container} />
                  <span>{label(ws)}</span>
                  <span className="text-faint">· 127.0.0.1:{ws.port}</span>
                </div>
                {ws.state.phase === "error" && ws.state.error && (
                  <div className="mt-1 text-sm break-words text-danger">{ws.state.error}</div>
                )}
                {ws.state.message && ws.state.phase !== "ready" && ws.state.phase !== "error" && (
                  <div className="mt-1 truncate font-mono text-xs text-faint">{ws.state.message}</div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn btn-sm btn-primary" disabled={b("switch")} onClick={() => act(ws.id, "switch")}>
                  Open
                </button>
                {running ? (
                  <>
                    <button className="btn btn-sm" disabled={b("restart")} onClick={() => act(ws.id, "restart")}>
                      Restart
                    </button>
                    <button className="btn btn-sm" disabled={b("stop")} onClick={() => act(ws.id, "stop")}>
                      Stop
                    </button>
                  </>
                ) : (
                  <button className="btn btn-sm" disabled={b("start")} onClick={() => act(ws.id, "start")}>
                    Start
                  </button>
                )}
                <Link className="btn btn-sm" to={`/edit/${ws.id}`}>
                  Edit
                </Link>
                <button className="btn btn-sm btn-danger" disabled={b("remove")} onClick={() => remove(ws)}>
                  Remove
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {disabled.length > 0 && (
        <div className="mt-6">
          <h2 className="mb-2 text-sm font-medium text-muted">Disabled</h2>
          <div className="card divide-y divide-line">
            {disabled.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 p-4 text-sm">
                <span>{s.name}</span>
                <div className="flex gap-2">
                  <Link className="btn btn-sm" to={`/edit/${s.id}`}>Edit</Link>
                  <button className="btn btn-sm btn-danger" onClick={() => remove(s)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

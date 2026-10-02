import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ClipboardCopy, RefreshCw } from "lucide-react";
import clsx from "clsx";
import {
  type ApiFailure,
  type Diagnostics as DiagnosticsData,
  type LogLine,
  apiFailures,
  downloadLabel,
  formatBytes,
  formatDuration,
  onApiFailure,
  wadd,
} from "@/lib/wadd";
import { useApp } from "@/lib/store";
import { Button, Progress } from "./ui";
import { copyText } from "@/lib/clipboard";

// When a download stalls or a workspace won't start, this shows where it is
// and what broke, without SSH. Everything wadd returns here is redacted.

type Source = { kind: "daemon" } | { kind: "unit"; unit: string } | { kind: "workspace"; id: string };

const sourceKey = (s: Source) => (s.kind === "daemon" ? "daemon" : s.kind === "unit" ? `unit:${s.unit}` : `workspace:${s.id}`);
const fmtTime = (t: number) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const daemonText = (lines: LogLine[]) => lines.map((l) => `${fmtTime(l.time)} ${l.level.padEnd(7)} ${l.logger}: ${l.message}`).join("\n");

function useApiFailures(): ApiFailure[] {
  const [, force] = useState(0);
  useEffect(() => onApiFailure(() => force((n) => n + 1)), []);
  return apiFailures();
}

function Health({ title, ok, warn, children }: { title: string; ok: boolean; warn?: boolean; children: React.ReactNode }) {
  return (
    <div className={clsx("rounded-2xl bg-surface-2 p-4 ring-1", !ok ? "ring-danger/50" : warn ? "ring-accent-2/50" : "ring-line")}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span className={clsx("size-2 rounded-full", !ok ? "bg-danger" : warn ? "bg-accent-2" : "bg-accent")} />
        {title}
      </div>
      <div className="mt-1.5 text-xs text-muted">{children}</div>
    </div>
  );
}

function Section({ title, hint, actions, children }: { title: string; hint?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-3xl border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
        <div>
          <h3 className="font-display text-lg font-semibold">{title}</h3>
          {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
        </div>
        {actions}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

const selectCls = "h-9 rounded-xl bg-surface-2 px-2.5 text-sm outline-none ring-1 ring-line focus:ring-2 focus:ring-accent";

export function MachineDiagnostics() {
  const machine = useApp((s) => s.machines[0]);
  const toast = useApp((s) => s.toast);
  const [diag, setDiag] = useState<DiagnosticsData | null>(null);
  const [diagError, setDiagError] = useState<string | null>(null);
  const [source, setSource] = useState<Source>({ kind: "daemon" });
  const [lines, setLines] = useState(200);
  const [log, setLog] = useState("");
  const [logError, setLogError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const failures = useApiFailures();
  const logRef = useRef<HTMLPreElement>(null);

  const loadDiag = useCallback(() => {
    wadd
      .diagnostics()
      .then((d) => {
        setDiag(d);
        setDiagError(null);
      })
      .catch((e) => setDiagError(e.message));
  }, []);

  const loadLog = useCallback(async () => {
    try {
      const text =
        source.kind === "daemon"
          ? daemonText((await wadd.daemonLog(lines)).lines)
          : source.kind === "unit"
            ? (await wadd.unitLog(source.unit, lines)).text
            : (await wadd.workspaceLog(source.id, lines)).text;
      setLog(text || "(empty)");
      setLogError(null);
    } catch (e) {
      setLogError((e as Error).message);
    }
  }, [source, lines]);

  useEffect(() => {
    loadDiag();
    const t = setInterval(loadDiag, 5000);
    return () => clearInterval(t);
  }, [loadDiag]);

  useEffect(() => {
    loadLog();
    if (!follow) return;
    const t = setInterval(loadLog, 3000);
    return () => clearInterval(t);
  }, [loadLog, follow]);

  // Keep the newest lines in view while following.
  useEffect(() => {
    if (follow && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log, follow]);

  const copyReport = async () => {
    // Started during the click, finished when the report is ready (see copyText).
    const report = (async () => ({
      generated: new Date().toISOString(),
      diagnostics: diag ?? (await wadd.diagnostics().catch((e) => ({ error: e.message }))),
      daemon_log: await wadd
        .daemonLog(200)
        .then((r) => daemonText(r.lines))
        .catch((e) => e.message),
      api_failures: failures,
    }))();
    try {
      await copyText(report.then((r) => JSON.stringify(r, null, 2)));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      toast({ title: "Couldn't copy", body: (e as Error).message, tone: "error" });
    }
  };

  const act = async (id: string, a: "download" | "start" | "stop" | "restart") => {
    try {
      await wadd.action(id, a);
    } catch (e) {
      toast({ title: `Couldn't ${a}`, body: (e as Error).message, tone: "error" });
    }
  };

  // Live phases come from the machine's event stream; diagnostics adds the rest.
  const live = new Map((machine?.containers ?? []).map((c) => [c.id, c]));
  const lowDisk = diag ? diag.disk.free_bytes < 5e9 : false;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">Downloads, errors and logs from wadd on this machine. Tokens and passwords are redacted.</p>
        <Button onClick={copyReport}>
          {copied ? <Check className="size-4" /> : <ClipboardCopy className="size-4" />} {copied ? "Copied" : "Copy report"}
        </Button>
      </div>
      {diagError && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{diagError}</p>}

      {diag && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Health title="wadd" ok>
            {diag.wadd.version} · up {formatDuration(diag.wadd.uptime_s)} · {diag.wadd.backend} backend
          </Health>
          <Health title="Podman" ok={diag.podman.connected && !diag.podman.error}>
            {diag.podman.error ?? `${diag.podman.version ?? "?"} · ${diag.podman.images ?? "?"} images`}
          </Health>
          <Health title="Network" ok={diag.network.available === false || diag.network.connectivity === "full"} warn={diag.network.available === false}>
            {diag.network.available === false ? "NetworkManager not available" : `${diag.network.ssid ?? "no Wi-Fi"} · ${diag.network.connectivity ?? "unknown"}`}
          </Health>
          <Health title="Disk" ok={diag.disk.free_bytes > 1e9} warn={lowDisk}>
            {formatBytes(diag.disk.free_bytes)} free of {formatBytes(diag.disk.total_bytes)}
            {lowDisk && " — images may not fit"}
          </Health>
        </div>
      )}

      <Section title="Workspaces" hint="Phase, download progress and the last error for each workspace.">
        <div className="divide-y divide-line">
          {(diag?.workspaces ?? []).map((d) => {
            const c = live.get(d.id);
            const phase = c?.phase ?? d.phase;
            const running = c ? c.status === "running" : d.container === "running";
            return (
              <div key={d.id} className="flex flex-wrap items-start gap-x-5 gap-y-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-[14rem] flex-1">
                  <div className="flex items-center gap-2">
                    <span className={clsx("size-2 rounded-full", phase === "error" ? "bg-danger" : running ? "bg-accent" : phase === "idle" ? "bg-faint" : "bg-accent-2")} />
                    <span className="font-medium">{d.name}</span>
                    <span className="text-xs text-faint">{d.enabled ? phase : "disabled"}</span>
                  </div>
                  <div className="mt-0.5 truncate font-mono text-xs text-faint">{d.image}</div>
                  <div className="mt-1 text-xs text-muted">
                    container {d.container} · image {d.image_present == null ? "unknown" : d.image_present ? "downloaded" : "not downloaded"}
                  </div>
                  {phase === "pulling" && (
                    <div className="mt-2 max-w-md">
                      <Progress value={c?.download?.progress ?? d.progress ?? 0} />
                      <div className="mt-1 text-xs text-muted">{c?.download?.label || downloadLabel(d.download) || d.message}</div>
                    </div>
                  )}
                  {phase !== "pulling" && d.message && <div className="mt-1 text-xs text-muted">{d.message}</div>}
                  {(c?.error ?? d.error) && <div className="mt-1 break-words text-sm text-danger">{c?.error ?? d.error}</div>}
                </div>
                {d.enabled && (
                  <div className="flex flex-wrap gap-1.5">
                    {d.image_present === false && phase !== "pulling" && (
                      <Button size="sm" onClick={() => act(d.id, "download")}>
                        Download
                      </Button>
                    )}
                    {running ? (
                      <>
                        <Button size="sm" onClick={() => act(d.id, "restart")}>
                          Restart
                        </Button>
                        <Button size="sm" onClick={() => act(d.id, "stop")}>
                          Stop
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" onClick={() => act(d.id, "start")}>
                        Start
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setSource({ kind: "workspace", id: d.id })}>
                      Logs
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
          {!diag && !diagError && <div className="text-sm text-muted">Loading…</div>}
        </div>
      </Section>

      <Section
        title="Logs"
        hint="wadd's own log, a systemd unit's journal, or a workspace container's output."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              className={selectCls}
              value={sourceKey(source)}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "daemon") setSource({ kind: "daemon" });
                else if (v.startsWith("unit:")) setSource({ kind: "unit", unit: v.slice(5) });
                else setSource({ kind: "workspace", id: v.slice(10) });
              }}
            >
              <option value="daemon">wadd (live)</option>
              {(diag?.log_units ?? []).map((u) => (
                <option key={u} value={`unit:${u}`}>
                  journal: {u}
                </option>
              ))}
              {(diag?.workspaces ?? []).map((w) => (
                <option key={w.id} value={`workspace:${w.id}`}>
                  container: {w.name}
                </option>
              ))}
            </select>
            <select className={selectCls} value={lines} onChange={(e) => setLines(Number(e.target.value))}>
              {[100, 200, 500, 1000].map((n) => (
                <option key={n} value={n}>
                  last {n}
                </option>
              ))}
            </select>
            <label className="flex items-center gap-1.5 text-sm text-muted">
              <input type="checkbox" className="accent-[var(--accent)]" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
              Follow
            </label>
            <Button size="sm" variant="ghost" onClick={loadLog}>
              <RefreshCw className="size-3.5" /> Refresh
            </Button>
          </div>
        }
      >
        {logError && <p className="mb-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{logError}</p>}
        <pre ref={logRef} className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-2xl bg-[#07040f] p-4 font-mono text-xs leading-relaxed text-[#e9e3ff] ring-1 ring-white/10">
          {log}
        </pre>
      </Section>

      <Section title="Recent problems" hint="Warnings and errors wadd logged, and calls from this app that failed.">
        {(diag?.recent_problems.length ?? 0) === 0 && failures.length === 0 ? (
          <div className="text-sm text-muted">Nothing recent.</div>
        ) : (
          <ul className="space-y-1.5 font-mono text-xs">
            {failures.map((f, i) => (
              <li key={`f${i}`} className="text-danger">
                {new Date(f.time).toLocaleTimeString()} {f.method} {f.path} → {f.status || "no response"}: {f.message}
              </li>
            ))}
            {[...(diag?.recent_problems ?? [])].reverse().map((p, i) => (
              <li key={`p${i}`} className={p.level === "WARNING" ? "text-accent-2" : "text-danger"}>
                {fmtTime(p.time)} {p.level} {p.logger}: {p.message}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

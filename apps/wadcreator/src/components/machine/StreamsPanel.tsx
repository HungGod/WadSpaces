import { useCallback, useEffect, useState } from "react";
import { Loader2, Radio, Square } from "lucide-react";
import { THIS_MACHINE, useApp } from "@/lib/store";
import { formatFingerprint } from "@/lib/streams";
import { wadd, type StreamsStatus } from "@/lib/wadd";
import { StreamDetails, StreamPasswordForm } from "../StreamPassword";
import { Button, Toggle } from "../ui";
import { useWaddEvent } from "./useWadd";

/**
 * Viewing this machine's wadspaces from other devices: allowed here or not
 * (only ever here: the account can't turn it on), the stream password, and
 * what's being streamed now. Also starts a stream for a phone.
 */
export function StreamsPanel() {
  const [st, setSt] = useState<StreamsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const containers = useApp((s) => s.machines.find((m) => m.id === THIS_MACHINE)?.containers ?? []);
  const wadspaces = useApp((s) => s.wadspaces);

  const load = useCallback(() => {
    wadd.streams().then(setSt, (e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);
  useWaddEvent(useCallback((event: string, data: unknown) => event === "streams" && setSt(data as StreamsStatus), []));

  const run = async (key: string, f: () => Promise<StreamsStatus>) => {
    setBusy(key);
    setError(null);
    try {
      setSt(await f());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const stream = (id: string, name: string) => {
    const onScreen = containers.some((c) => c.wadspaceId === id && c.status === "running");
    if (onScreen && !confirm(`${name} is open on this screen. Take it off to stream it?`)) return;
    run(id, () => wadd.startStream(id, onScreen));
  };

  if (!st) return <div className="grid h-24 place-items-center text-muted">{error ?? <Loader2 className="size-5 animate-spin" />}</div>;
  const streamed = new Set(st.streams.map((s) => s.wsId));
  const native = containers.filter((c) => c.native !== false && !streamed.has(c.wadspaceId));

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="font-medium">Let other devices view wadspaces here</div>
          <p className="mt-0.5 text-xs text-muted">
            Your other machines, and phones on this network, can view this machine&apos;s wadspaces, signing in as <span className="font-mono">{st.user}</span> with your stream password. Off ends every stream.
          </p>
        </div>
        <Toggle checked={st.allowRemote} disabled={busy === "allow"} label="Let other devices view wadspaces here" onChange={(on) => run("allow", () => wadd.setAllowRemote(on))} />
      </div>

      {st.passwordSet && !changing ? (
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="text-muted">A stream password is set.</span>
          <Button size="sm" onClick={() => setChanging(true)}>
            Change it
          </Button>
        </div>
      ) : (
        <StreamPasswordForm onDone={() => setChanging(false)} />
      )}

      {st.problem && st.allowRemote && <p className="text-sm text-muted">{st.problem}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}

      {st.streams.length > 0 && (
        <div className="space-y-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">Streaming now</div>
          {st.streams.map((s) => (
            <div key={s.wsId} className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 font-medium">
                  <Radio className="size-4 text-accent" /> {s.name}
                  {!s.ready && <Loader2 className="size-3.5 animate-spin text-muted" />}
                </span>
                <Button size="sm" disabled={busy === s.wsId} onClick={() => run(s.wsId, () => wadd.stopStream(s.wsId))}>
                  <Square className="size-3 fill-current" /> Stop
                </Button>
              </div>
              <StreamDetails stream={s} />
            </div>
          ))}
        </div>
      )}

      {st.allowRemote && st.passwordSet && native.length > 0 && (
        <div className="space-y-2">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">Show one on a phone</div>
          <div className="flex flex-wrap gap-2">
            {native.map((c) => {
              const name = wadspaces.find((w) => w.id === c.wadspaceId)?.name ?? c.wadspaceId;
              return (
                <Button key={c.id} size="sm" disabled={!!busy || !!st.problem} onClick={() => stream(c.wadspaceId, name)}>
                  {busy === c.wadspaceId ? <Loader2 className="size-3.5 animate-spin" /> : <Radio className="size-3.5" />} {name}
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {st.sha256 && (
        <div className="text-[11px] text-faint">
          This machine&apos;s stream certificate: <span className="break-all font-mono">{formatFingerprint(st.sha256)}</span>
        </div>
      )}
    </div>
  );
}

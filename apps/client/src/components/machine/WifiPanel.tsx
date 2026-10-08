// Wi-Fi on this machine (wadd/network.py over NetworkManager): the networks in
// range, joining one (with its password), leaving and forgetting.
import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, Lock, RefreshCw, Wifi, WifiOff } from "lucide-react";
import clsx from "clsx";
import { wadd, type WifiNetwork } from "@/lib/wadd";
import { Button, Input } from "../ui";
import { isOnline, useWaddState } from "./useWadd";

function Bars({ signal }: { signal: number }) {
  return (
    <span className="flex h-3.5 items-end gap-[2px]" aria-label={`signal ${signal}%`}>
      {[25, 50, 75].map((t, i) => (
        <span key={t} className={clsx("w-[3px] rounded-sm", signal >= t ? "bg-fg" : "bg-line-strong")} style={{ height: `${(i + 2) * 3}px` }} />
      ))}
    </span>
  );
}

export function WifiPanel() {
  const snap = useWaddState();
  const net = snap?.network;
  const [list, setList] = useState<WifiNetwork[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [joining, setJoining] = useState<WifiNetwork | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      setList(await wadd.wifiScan());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    scan();
  }, [scan]);

  const join = async (n: WifiNetwork, pw?: string) => {
    setBusy(true);
    setError(null);
    try {
      await wadd.wifiConnect(n.ssid, pw);
      setJoining(null);
      setPassword("");
      await scan();
    } catch (e) {
      const msg = (e as Error).message;
      // A saved network whose password changed: ask for it.
      if (/password required/i.test(msg)) setJoining(n);
      else setError(/secrets were required|802-1x|psk/i.test(msg) ? "Wrong password, or the network refused it." : msg);
    } finally {
      setBusy(false);
    }
  };

  const pick = (n: WifiNetwork) => {
    if (n.active || busy) return;
    if (!n.supported) return setError(`${n.ssid} uses ${n.security}, which this machine can't join yet.`);
    if (n.secure && !n.known) {
      setJoining(n);
      setPassword("");
      return;
    }
    join(n);
  };

  if (net && net.available === false) {
    return <p className="text-sm text-muted">This machine has no Wi-Fi manager (NetworkManager), so networks can't be set here.</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-2xl bg-surface-2/60 px-4 py-3 ring-1 ring-line">
        {isOnline(snap) ? <Wifi className="size-5 text-accent" /> : <WifiOff className="size-5 text-faint" />}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{net?.ssid ?? (isOnline(snap) ? "Connected" : "Not connected")}</div>
          <div className="text-xs text-muted">{isOnline(snap) ? "Online" : net?.connectivity === "portal" ? "Sign in to the network in a browser first" : net?.ssid ? "No internet yet" : "Pick a network"}</div>
        </div>
        {net?.ssid && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => wadd.wifiDisconnect().catch((e) => setError((e as Error).message))}>
            Disconnect
          </Button>
        )}
      </div>

      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-faint">Networks</span>
        <Button size="sm" variant="ghost" onClick={scan} disabled={scanning}>
          {scanning ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Scan
        </Button>
      </div>

      <ul className="max-h-72 space-y-1 overflow-y-auto">
        {list === null && scanning && <li className="px-3 py-6 text-center text-sm text-muted">Looking for networks…</li>}
        {list?.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">No networks in range.</li>}
        {list?.map((n) => (
          <li key={n.ssid}>
            <button
              type="button"
              onClick={() => pick(n)}
              className={clsx(
                "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm",
                n.active ? "bg-accent-soft ring-1 ring-accent/30" : "hover:bg-surface-2",
                !n.supported && "opacity-50",
              )}
            >
              <Bars signal={n.signal} />
              <span className="min-w-0 flex-1 truncate font-medium">{n.ssid}</span>
              {n.known && !n.active && <span className="text-xs text-faint">saved</span>}
              {n.secure && <Lock className="size-3.5 text-faint" />}
              {n.active && <Check className="size-4 text-accent" />}
            </button>
            {joining?.ssid === n.ssid && (
              <form
                className="mt-2 flex gap-2 px-3 pb-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  join(n, password);
                }}
              >
                <Input type="password" autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <Button type="submit" variant="primary" disabled={busy || password.length < 8}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : "Join"}
                </Button>
              </form>
            )}
          </li>
        ))}
      </ul>
      {error && <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger ring-1 ring-danger/30">{error}</p>}
    </div>
  );
}

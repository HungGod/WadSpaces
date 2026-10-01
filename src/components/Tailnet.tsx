import { useCallback, useEffect, useState } from "react";
import { Check, ClipboardCopy, ExternalLink, Loader2, LogOut, Network, Radio } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import type { Machine, TailnetStatus } from "@/lib/types";
import { useApp } from "@/lib/store";
import { Badge, Button } from "./ui";

const TAILNET_NOTE = "Works on your devices signed in to your tailnet.";

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      size="sm"
      onClick={async () => {
        await navigator.clipboard.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      }}
    >
      {copied ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />} {copied ? "Copied" : label}
    </Button>
  );
}

/**
 * A streamed wadspace's tailnet link. In a browser (online) it opens; the
 * machine's own app opens no links, so there it's the address to copy.
 */
export function StreamLink({ url, className }: { url: string; className?: string }) {
  return (
    <div className={clsx("flex flex-wrap items-center gap-2", className)}>
      {backend.target === "online" ? (
        <a href={url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-surface-2 px-3 text-[13px] font-medium ring-1 ring-line hover:bg-surface-3 hover:ring-line-strong">
          <Radio className="size-3.5 text-accent" /> Open stream <ExternalLink className="size-3 text-faint" />
        </a>
      ) : (
        <>
          <span className="inline-flex items-center gap-1.5 truncate font-mono text-xs text-muted">
            <Radio className="size-3.5 shrink-0 text-accent" /> {url}
          </span>
          <CopyButton text={url} label="Copy link" />
        </>
      )}
      <span className="text-[11px] text-faint">{TAILNET_NOTE}</span>
    </div>
  );
}

/** Online: a machine's place on the tailnet, from its heartbeat. */
export function TailnetBadge({ m }: { m: Machine }) {
  if (!m.tailnet) return null;
  return (
    <Badge tone={m.tailnet.online ? "accent" : "default"}>
      <Network className="size-3" /> {m.tailnet.dnsName ?? m.tailnet.ip ?? "tailnet"}
      {!m.tailnet.online && " · offline"}
    </Badge>
  );
}

/**
 * Offline: this machine on your tailnet (Tailscale). Join gets a login URL
 * from tailscaled to open on another device; wadd's `tailnet` event says when
 * it's done. Once on, streamed wadspaces get tailnet links.
 */
export function TailnetCard({ m }: { m: Machine }) {
  const toast = useApp((s) => s.toast);
  const [st, setSt] = useState<TailnetStatus | null>(null);
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"join" | "leave" | null>(null);

  const refresh = useCallback(async () => {
    const s = await backend.tailnetStatus?.().catch(() => null);
    if (s) setSt(s);
    if (s?.online) setLoginUrl(null);
  }, []);

  // Again whenever the machine changes: wadd's `tailnet` event reloads it.
  useEffect(() => {
    refresh();
  }, [refresh, m.tailnet?.online, m.tailnet?.dnsName]);

  const join = async () => {
    setBusy("join");
    try {
      const r = await backend.tailnetLogin!();
      setLoginUrl(r.url);
      if (!r.url) await refresh();
    } catch (e) {
      toast({ title: "Couldn't start joining", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const leave = async () => {
    if (!confirm("Take this machine off your tailnet? Its stream links stop working until it joins again.")) return;
    setBusy("leave");
    try {
      await backend.tailnetLogout!();
      await refresh();
    } catch (e) {
      toast({ title: "Couldn't leave", body: (e as Error).message, tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  if (!st?.installed) return null;
  const on = !!st.online;

  return (
    <div className="mt-3 space-y-3 rounded-2xl bg-surface-2 p-4 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-4">
        <span className={clsx("grid size-10 place-items-center rounded-xl", on ? "bg-accent-soft text-accent" : "bg-surface-3 text-faint")}>
          <Network className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            {on ? "On your tailnet" : st.loggedIn ? "Signed in to your tailnet, not connected" : "Join your tailnet"}
            {on && st.loginName && <Badge>{st.loginName}</Badge>}
          </div>
          <div className="truncate text-xs text-muted">
            {on ? (
              <span className="font-mono">
                {st.dnsName}
                {st.ip && ` · ${st.ip}`}
              </span>
            ) : st.loggedIn ? (
              `Tailscale says ${st.backendState ?? "it's not running"}.`
            ) : (
              "Tailscale links your devices privately. On it, streamed wadspaces open on your phone or laptop, and nowhere else."
            )}
          </div>
        </div>
        {on || st.loggedIn ? (
          <Button variant="ghost" onClick={leave} disabled={!!busy}>
            {busy === "leave" ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />} Leave
          </Button>
        ) : (
          <Button variant="primary" onClick={join} disabled={!!busy}>
            {busy === "join" ? <Loader2 className="size-4 animate-spin" /> : <Network className="size-4" />} Join your tailnet
          </Button>
        )}
      </div>
      {loginUrl && !on && (
        <div className="space-y-2 rounded-xl bg-surface p-3 ring-1 ring-line">
          <div className="text-xs text-muted">Open this on your phone or computer and sign in to Tailscale. This updates by itself when it's done.</div>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate font-mono text-sm text-accent" title={loginUrl}>
              {backend.target === "online" ? (
                <a href={loginUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                  {loginUrl}
                </a>
              ) : (
                loginUrl
              )}
            </span>
            <CopyButton text={loginUrl} />
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-faint">
            <Loader2 className="size-3 animate-spin" /> Waiting for you to sign in
          </div>
        </div>
      )}
    </div>
  );
}

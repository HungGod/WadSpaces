import { useEffect, useState } from "react";
import { Check, ExternalLink, KeyRound, Loader2, Radio, RefreshCw, ShieldCheck } from "lucide-react";
import clsx from "clsx";
import { backend } from "@/data";
import { useApp } from "@/lib/store";
import { formatFingerprint, generateStreamPassword, MIN_STREAM_PASSWORD } from "@/lib/streams";
import { inTauri } from "@/lib/shell";
import type { RemoteStream } from "@/lib/types";
import { Button, Input, Label } from "./ui";

/**
 * The account's stream password: what other devices sign in to your
 * machines' streams with (with your username). It can be set or replaced,
 * never read back, so it's shown once here to keep.
 */
export function StreamPasswordForm({ onDone }: { onDone?: () => void }) {
  const toast = useApp((s) => s.toast);
  const [pw, setPw] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const short = pw.trim().length < MIN_STREAM_PASSWORD;
  const save = async () => {
    if (!backend.setStreamPassword || short) return;
    setSaving(true);
    try {
      const n = await backend.setStreamPassword(pw.trim());
      setSaved(true);
      toast({ title: "Stream password saved", body: n ? `${n} machine${n === 1 ? "" : "s"} fetching it now` : "Your machines fetch it when they're next on", tone: "success" });
      onDone?.();
    } catch (e) {
      toast({ title: "Couldn't save it", body: (e as Error).message, tone: "error" });
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="space-y-2">
      <Label hint={`${MIN_STREAM_PASSWORD}+ characters`}>Stream password</Label>
      <div className="flex gap-2">
        <Input
          value={pw}
          onChange={(e) => {
            setPw(e.target.value);
            setSaved(false);
          }}
          placeholder="a new stream password"
          autoComplete="new-password"
          spellCheck={false}
          className="font-mono"
        />
        <Button onClick={() => setPw(generateStreamPassword())} title="Make one up">
          <RefreshCw className="size-4" /> Make one
        </Button>
        <Button variant="primary" disabled={short || saving || saved} onClick={save}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : saved ? <Check className="size-4" /> : <KeyRound className="size-4" />} {saved ? "Saved" : "Save"}
        </Button>
      </div>
      <p className="text-xs text-muted">
        It can&apos;t be shown again once saved: keep it in your password manager. A phone asks for it (with your username) when it opens a stream. Changing it ends streams that are on.
      </p>
    </div>
  );
}

/** A QR code of a link, drawn by the app (the machine app opens no links: a phone's camera can). */
function Qr({ text }: { text: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    import("@/gen/bindings").then(({ commands }) => commands.qrSvg(text)).then((s) => live && setSvg(s), () => {});
    return () => {
      live = false;
    };
  }, [text]);
  return svg ? <img src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`} alt={`QR code of ${text}`} className="size-32 shrink-0 rounded-xl bg-white p-1.5" /> : null;
}

/**
 * Where to open a stream on another device (a phone, a laptop's browser) on
 * the same network: its links, who to sign in as, and the certificate's
 * fingerprint to check the browser's warning against.
 */
export function StreamDetails({ stream, className }: { stream: RemoteStream; className?: string }) {
  const first = stream.urls[0];
  return (
    <div className={clsx("space-y-2 rounded-2xl bg-surface-2 p-3 text-xs ring-1 ring-line", className)}>
      <div className="flex flex-wrap items-start gap-3">
        {inTauri && first && <Qr text={first} />}
        <div className="min-w-0 flex-1 space-y-1.5">
          {stream.urls.map((u) =>
            inTauri ? (
              <div key={u} className="flex items-center gap-1.5 font-mono text-[13px]">
                <Radio className="size-3.5 shrink-0 text-accent" /> {u}
              </div>
            ) : (
              <a key={u} href={u} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 font-mono text-[13px] text-accent hover:underline">
                <Radio className="size-3.5 shrink-0" /> {u} <ExternalLink className="size-3 text-faint" />
              </a>
            ),
          )}
          <div className="text-muted">
            Sign in as <span className="font-mono text-fg">{stream.user}</span> with your stream password.
          </div>
          <div className="flex items-start gap-1.5 text-muted">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-accent" />
            <span>
              The browser warns that the connection isn&apos;t private: the machine made its own certificate. Go on only if its SHA-256 fingerprint is
              <span className="mt-0.5 block break-all font-mono text-[11px] text-fg">{formatFingerprint(stream.sha256)}</span>
            </span>
          </div>
          <div className="text-faint">Only on the same network as the machine.</div>
        </div>
      </div>
    </div>
  );
}

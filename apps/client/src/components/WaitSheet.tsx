import { Link } from "react-router";
import { ArrowRight, CheckCircle2, CloudDownload, Loader2, Gamepad2, Globe, Play, Rocket, Wand2, Zap } from "lucide-react";
import { AppTile } from "@/components/AppTile";
import { Button, Modal } from "@/components/ui";
import { openWadspace, quickLaunch } from "@/lib/launch";
import { useApp } from "@/lib/store";
import { templateById, type Template } from "@/lib/templates";
import type { App, Wadspace } from "@/lib/types";

/** Pre-cached picks offered while a container downloads. */
const WHILE_YOU_WAIT = [
  { templateId: "ev-browser", icon: Globe, title: "Open a browser", blurb: "A clean Firefox" },
  { templateId: "ga-pocket", icon: Gamepad2, title: "Play a game", blurb: "Luanti & ScummVM" },
];

/**
 * Shown while a wadspace's container is on its way: its image downloading, or freshly built in
 * the Builder. The work keeps going in the background whether or not this is open; it just
 * gives the user something to do meanwhile.
 */
export function WaitSheet() {
  const waitingFor = useApp((s) => s.waitingFor);
  const setWaitingFor = useApp((s) => s.setWaitingFor);
  const ws = useApp((s) => s.wadspaces.find((w) => w.id === s.waitingFor));
  const build = useApp((s) => s.builds.find((b) => b.wadspaceId === s.waitingFor));
  const apps = useApp((s) => s.apps);
  const close = () => setWaitingFor(null);

  const ready = build ? build.status === "done" : !!ws?.local;
  const hero = ws && heroApp(ws, apps);

  return (
    <Modal
      open={!!waitingFor && !!ws}
      onClose={close}
      width={560}
      title={
        ws && (
          <span className="flex items-center gap-4">
            {hero ? <AppTile app={hero} size={52} /> : <span className="grid size-[52px] shrink-0 place-items-center rounded-[28%] bg-surface-2 ring-1 ring-line"><CloudDownload className="size-5 text-muted" /></span>}
            <span className="min-w-0">
              <span className="block truncate font-bold">{ws.name}</span>
              <span className="mt-0.5 block font-sans text-sm font-normal tracking-normal text-muted">{ready ? "Ready on this machine" : "Getting ready"}</span>
            </span>
          </span>
        )
      }
    >
      {ws && (
        <div className="space-y-6">
          <div className="rounded-2xl bg-surface-2 p-4 ring-1 ring-line">
            {ready ? (
              <div className="flex items-center gap-3">
                <CheckCircle2 className="size-5 shrink-0 text-fg dark:text-accent" />
                <div className="min-w-0 flex-1 text-sm font-medium">Ready to open</div>
                <Button variant="primary" size="sm" onClick={() => { close(); openWadspace(ws); }}>
                  <Play className="size-3.5 fill-current" /> Open
                </Button>
              </div>
            ) : (
              // No numbers here on purpose: just reassurance. The card and sidebar show progress.
              <div className="flex items-start gap-3">
                <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-accent" />
                <div>
                  <div className="text-sm font-semibold">Your wadspace is getting ready to deploy</div>
                  <p className="mt-1 text-[12.5px] text-muted">
                    This happens in the background. Close this and keep going; your profile icon will let you know when it&apos;s ready.
                  </p>
                </div>
              </div>
            )}
          </div>

          {!ready && (
            <section>
              <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">While you wait</h3>
              <div className="grid grid-cols-2 gap-2">
                {WHILE_YOU_WAIT.map(({ templateId, icon: Icon, title, blurb }) => {
                  const t = templateById(templateId);
                  return t ? <InstantTile key={templateId} t={t} icon={<Icon className="size-5" />} title={title} blurb={blurb} /> : null;
                })}
                <Link to="/builder" onClick={close} className="group flex flex-col gap-3 rounded-2xl p-3.5 ring-1 ring-line transition-colors hover:bg-surface-2 hover:ring-line-strong">
                  <span className="grid size-9 place-items-center rounded-xl bg-accent-2-soft text-fg ring-1 ring-accent-2/40">
                    <Wand2 className="size-5" />
                  </span>
                  <span>
                    <span className="flex items-center gap-1 text-sm font-semibold">
                      Build one <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">Start another in the Builder</span>
                  </span>
                </Link>
                <Link to="/launch" onClick={close} className="group flex flex-col gap-3 rounded-2xl p-3.5 ring-1 ring-line transition-colors hover:bg-surface-2 hover:ring-line-strong">
                  <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent">
                    <Rocket className="size-5" />
                  </span>
                  <span>
                    <span className="flex items-center gap-1 text-sm font-semibold">
                      Quick launch <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">Browse ready-made wadspaces</span>
                  </span>
                </Link>
              </div>
            </section>
          )}

          <div className="flex justify-end">
            <Button variant="ghost" onClick={close}>
              {ready ? "Later" : "Continue in the background"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function InstantTile({ t, icon, title, blurb }: { t: Template; icon: React.ReactNode; title: string; blurb: string }) {
  const user = useApp((s) => s.user);
  const existing = useApp((s) => s.wadspaces.find((w) => w.templateId === t.id && w.owner === user?.username && w.local));
  // Reuse the copy the user already has rather than stacking up duplicates.
  const launch = () => (existing ? openWadspace(existing) : quickLaunch(t));
  return (
    <button type="button" onClick={launch} className="group flex flex-col gap-3 rounded-2xl p-3.5 text-left ring-1 ring-line transition-colors hover:bg-surface-2 hover:ring-line-strong">
      <span className="flex items-center justify-between">
        <span className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent">{icon}</span>
        <span className="flex items-center gap-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-faint">
          <Zap className="size-3 fill-current" /> Instant
        </span>
      </span>
      <span>
        <span className="block text-sm font-semibold">{title}</span>
        <span className="mt-0.5 block text-xs text-muted">{blurb}</span>
      </span>
    </button>
  );
}

function heroApp(ws: Wadspace, apps: App[]) {
  const id = (ws.templateId && templateById(ws.templateId)?.apps[0]) || ws.layout.icons[0]?.appId;
  return apps.find((a) => a.id === id);
}

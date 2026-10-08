import { Link } from "react-router";
import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Bot, Check, ChevronDown, CloudDownload, HardDrive, Play, Rocket, Wand2, Zap } from "lucide-react";
import { AppTile } from "@/components/AppTile";
import { LaunchDialog } from "@/components/LaunchDialog";
import { Badge, Button, Modal, Progress } from "@/components/ui";
import { runtimeLabel } from "@/lib/agent";
import { size } from "@/lib/format";
import { downloadTemplate, openWadspace } from "@/lib/launch";
import { isLocked, useApp } from "@/lib/store";
import { CATEGORIES, TEMPLATES, appIcon, templateApps, type Template } from "@/lib/templates";
import type { App } from "@/lib/types";

/** Shown first; "Show more" adds the rest of the catalog a page at a time. */
const PICKS = ["ai-claude-code", "dev-web", "fo-deep-work", "ev-browser", "ga-retro", "cr-design"];
const ORDER = [...PICKS.map((id) => TEMPLATES.find((t) => t.id === id)!), ...TEMPLATES.filter((t) => !PICKS.includes(t.id))];
const PAGE = 6;

/** Quick Launch on Home: an icon grid of templates, expanded a page at a time. */
export function QuickPicks() {
  const [count, setCount] = useState(PAGE);
  const [details, setDetails] = useState<Template | null>(null);
  const [launching, setLaunching] = useState<Template | null>(null);
  const done = count >= ORDER.length;

  return (
    <section>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-display text-lg font-semibold tracking-tight">Quick launch</h2>
        <Link to="/launch" className="flex items-center gap-1 text-sm font-medium text-muted transition-colors hover:text-fg">
          Browse all <ArrowRight className="size-3.5" />
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-1 rounded-3xl border border-line bg-surface/60 p-2 sm:grid-cols-6 lg:grid-cols-3">
        {ORDER.slice(0, count).map((t, i) => (
          <motion.div key={t.id} initial={i < PAGE ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: (i % PAGE) * 0.03 }}>
            <PickTile t={t} onOpen={() => setDetails(t)} />
          </motion.div>
        ))}
      </div>

      {done ? (
        <Link to="/launch" className="mt-2 flex h-10 w-full items-center justify-center gap-1.5 rounded-xl text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg">
          Browse all in Quick Launch <ArrowRight className="size-4" />
        </Link>
      ) : (
        <Button variant="ghost" className="mt-2 w-full" onClick={() => setCount((c) => Math.min(c + PAGE, ORDER.length))}>
          Show more <span className="tabular-nums text-faint">{ORDER.length - count}</span> <ChevronDown className="size-4" />
        </Button>
      )}

      <Details
        t={details}
        onClose={() => setDetails(null)}
        onLaunch={(t) => {
          setDetails(null);
          setLaunching(t);
        }}
      />
      <LaunchDialog template={launching} onClose={() => setLaunching(null)} />
    </section>
  );
}

/** Just the icon and the name, like a home screen. */
function PickTile({ t, onOpen }: { t: Template; onOpen: () => void }) {
  const apps = useApp((s) => s.apps);
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex h-[112px] w-full flex-col items-center gap-2 rounded-2xl px-1.5 pt-3 text-center transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
    >
      <span className="transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:scale-105">
        <AppGrid apps={templateApps(t, apps)} px={56} />
      </span>
      <span className="line-clamp-2 text-[12.5px] font-medium leading-tight">{t.name}</span>
    </button>
  );
}

/** A folder-style icon: always a 2×2 grid, so one or two apps keep the same size as the rest; a fifth app onward shows as "+N". */
function AppGrid({ apps, px }: { apps: App[]; px: number }) {
  const shown = apps.length > 4 ? apps.slice(0, 3) : apps;
  const extra = apps.length - shown.length;
  const empty = 4 - shown.length - (extra > 0 ? 1 : 0);
  return (
    // Fixed rows and columns: a lone app keeps a quarter cell instead of growing into the empty ones.
    <span className="grid shrink-0 grid-cols-2 grid-rows-2 gap-[4px] overflow-hidden rounded-[28%] bg-surface-2 p-[6px] shadow-sm ring-1 ring-line" style={{ width: px, height: px }}>
      {shown.map((a) => (
        <span key={a.id} className="grid min-h-0 min-w-0 place-items-center overflow-hidden rounded-[30%] bg-surface">
          <img src={appIcon(a)} alt={a.name} title={a.name} className="size-[70%] object-contain" draggable={false} />
        </span>
      ))}
      {extra > 0 && <span className="grid place-items-center rounded-[30%] bg-surface text-[10px] font-bold text-muted">+{extra}</span>}
      {Array.from({ length: empty }, (_, i) => (
        <span key={i} className="min-h-0 rounded-[30%] bg-surface/40" />
      ))}
    </span>
  );
}

/** Everything in the template, with launch, download and open-in-builder. */
function Details({ t, onClose, onLaunch }: { t: Template | null; onClose: () => void; onLaunch: (t: Template) => void }) {
  const apps = useApp((s) => s.apps);
  const user = useApp((s) => s.user);
  const focus = useApp((s) => s.focus);
  const copy = useApp((s) => (t ? s.wadspaces.find((w) => w.templateId === t.id && w.owner === user?.username) : undefined));
  const download = useApp((s) => (copy ? s.downloads.find((d) => d.wadspaceId === copy.id) : undefined));
  const [busy, setBusy] = useState(false);
  const list = t ? templateApps(t, apps) : [];
  const category = t && CATEGORIES.find((c) => c.value === t.category)?.label;

  const downloadLocal = async () => {
    if (!t) return;
    setBusy(true);
    try {
      await downloadTemplate(t);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!t}
      onClose={onClose}
      width={560}
      title={
        t && (
          <span className="flex items-center gap-4">
            <AppGrid apps={list} px={60} />
            <span className="min-w-0">
              <span className="block truncate font-bold">{t.name}</span>
              <span className="mt-1.5 flex flex-wrap gap-1.5 font-sans text-xs font-normal tracking-normal">
                {category && <Badge>{category}</Badge>}
                <Badge>{t.instant ? <><Zap className="size-3 fill-current" /> Instant</> : size(t.sizeMB)}</Badge>
                {t.agent && <Badge tone="accent"><Bot className="size-3" /> AI agent</Badge>}
              </span>
            </span>
          </span>
        )
      }
    >
      {t && (
        <div className="space-y-5">
          <div className="relative h-36 overflow-hidden rounded-2xl">
            <img src={t.image} alt="" className="size-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent" />
          </div>

          <p className="text-sm leading-relaxed text-muted">{t.description}</p>

          {t.agent && (
            <div className="flex items-start gap-3 rounded-2xl bg-accent-soft p-3 text-[13px]">
              <Bot className="mt-0.5 size-4 shrink-0 text-accent" />
              <div className="min-w-0">
                <div>
                  <b className="font-semibold">{runtimeLabel(t.agent)}</b> · {t.agent.model} · {t.agent.autonomy === "auto" ? "works on its own" : "asks before acting"}
                </div>
                <div className="mt-0.5 line-clamp-2 text-muted">Starts on: &ldquo;{t.agent.prompt}&rdquo;</div>
              </div>
            </div>
          )}

          <div>
            <div className="mb-2.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em] text-faint">
              <span>
                {list.length} app{list.length === 1 ? "" : "s"} inside
              </span>
              {t.startup?.length ? (
                <span className="flex items-center gap-1 normal-case tracking-normal">
                  <span className="size-1.5 rounded-full bg-accent" /> opens on boot
                </span>
              ) : null}
            </div>
            <div className="grid grid-cols-4 gap-x-2 gap-y-3 sm:grid-cols-6">
              {list.map((a) => (
                <div key={a.id} className="flex min-w-0 flex-col items-center gap-1">
                  <span className="relative">
                    <AppTile app={a} size={44} />
                    {t.startup?.includes(a.id) && <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-accent ring-2 ring-surface" />}
                  </span>
                  <span className="w-full truncate text-center text-[11px] text-muted">{a.name}</span>
                </div>
              ))}
            </div>
          </div>

          {download && (
            <div className="rounded-2xl bg-surface-2 p-3 ring-1 ring-line">
              <div className="mb-2 flex justify-between text-xs">
                <span className="text-muted">Downloading to this machine</span>
                <span className="font-semibold tabular-nums">{Math.floor(download.progress * 100)}%</span>
              </div>
              <Progress value={download.progress} />
            </div>
          )}

          <div className="grid gap-2 border-t border-line pt-5 sm:grid-cols-3 [&_svg]:shrink-0">
            {copy ? (
              <Button
                variant="primary"
                disabled={isLocked(focus, copy.id)}
                onClick={() => {
                  onClose();
                  openWadspace(copy);
                }}
              >
                <Play className="size-4 fill-current" /> Open
              </Button>
            ) : (
              <Button variant="primary" disabled={!!focus} title={focus ? "A focus session is running" : undefined} onClick={() => onLaunch(t)}>
                {t.agent ? <Zap className="size-4 fill-current" /> : <Rocket className="size-4" />} Launch
              </Button>
            )}
            <Button variant="secondary" disabled={busy || !!copy} onClick={downloadLocal} className="min-w-0 px-3 [&_svg]:shrink-0">
              {copy?.local ? (
                <><Check className="size-4" /> On this machine</>
              ) : download ? (
                <><CloudDownload className="size-4" /> Downloading…</>
              ) : copy ? (
                <><HardDrive className="size-4" /> In your account</>
              ) : (
                <><CloudDownload className="size-4" /> Download locally</>
              )}
            </Button>
            <Link to={`/builder?template=${t.id}`} onClick={onClose} className="flex h-10 items-center justify-center gap-1.5 rounded-xl px-3 text-sm font-medium text-muted ring-1 ring-line transition-colors hover:bg-surface-2 hover:text-fg">
              <Wand2 className="size-4" /> Open in Builder
            </Link>
          </div>
        </div>
      )}
    </Modal>
  );
}

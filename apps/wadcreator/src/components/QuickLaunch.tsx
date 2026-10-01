import { Link, useNavigate } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Bot, ChevronLeft, ChevronRight, CloudDownload, HardDrive, Play, Rocket, Trash2, Wand2, Zap } from "lucide-react";
import clsx from "clsx";
import { Page } from "@/components/Page";
import { SearchBox } from "@/components/WadspaceGrid";
import { AppTile } from "@/components/AppTile";
import { LaunchDialog } from "@/components/LaunchDialog";
import { Badge, Button, EmptyState, IconButton, PageHeader } from "@/components/ui";
import { size } from "@/lib/format";
import { discardWadspace, downloadTemplate, openWadspace } from "@/lib/launch";
import { isLocked, useApp } from "@/lib/store";
import { CATEGORIES, TEMPLATES, templateApps, templateMatches, type Template, type TemplateCategory } from "@/lib/templates";
import type { Wadspace } from "@/lib/types";

export function QuickLaunch({ initialCategory, initialQuery = "", focusSearch = false }: { initialCategory: TemplateCategory | null; initialQuery?: string; focusSearch?: boolean }) {
  const user = useApp((s) => s.user);
  const wadspaces = useApp((s) => s.wadspaces);
  const [category, setCategory] = useState<TemplateCategory | null>(initialCategory);
  const [q, setQ] = useState(initialQuery);
  const apps = useApp((s) => s.apps);
  const [launching, setLaunching] = useState<Template | null>(null);

  const copies = wadspaces.filter((w) => w.templateId && w.owner === user?.username);
  const copyOf = (t: Template) => copies.find((w) => w.templateId === t.id);

  const items = useMemo(() => TEMPLATES.filter((t) => (!category || t.category === category) && templateMatches(t, q, apps)), [category, q, apps]);

  // "All" with no search reads better as one shelf per category.
  const grouped = !category && !q.trim();

  return (
    <Page>
      <PageHeader title="Quick Launch" subtitle="Pre-made wadspaces. Instant ones open right away; the rest download in the background while you do something else.">
        <SearchBox value={q} onChange={setQ} placeholder="Search templates, apps, categories" autoFocus={focusSearch} />
      </PageHeader>

      <div className="mb-8 flex flex-wrap gap-2">
        <Chip on={!category} onClick={() => setCategory(null)}>
          All <span className="tabular-nums opacity-60">{TEMPLATES.length}</span>
        </Chip>
        {CATEGORIES.map((c) => (
          <Chip key={c.value} on={category === c.value} onClick={() => setCategory(c.value)}>
            {c.value === "ai" && <Bot className="size-3.5" />}
            {c.label} <span className="tabular-nums opacity-60">{TEMPLATES.filter((t) => t.category === c.value).length}</span>
          </Chip>
        ))}
      </div>

      {copies.length > 0 && <InUse copies={copies} />}


      {grouped ? (
        <div className="space-y-10">
          <Shelf title="Featured" blurb="Hand-picked wadspaces worth a spin this week.">
            {FEATURED.map((id, i) => {
              const t = TEMPLATES.find((x) => x.id === id)!;
              return <FeaturedCard key={t.id} t={t} copy={copyOf(t)} index={i} onLaunch={setLaunching} />;
            })}
          </Shelf>
          {CATEGORIES.map((c) => (
            <Shelf key={c.value} title={c.label} blurb={c.blurb} onSeeAll={() => setCategory(c.value)}>
              {TEMPLATES.filter((t) => t.category === c.value).map((t, i) => (
                <div key={t.id} className="flex w-[17.5rem] shrink-0 snap-start">
                  <TemplateCard t={t} copy={copyOf(t)} index={i} onLaunch={setLaunching} />
                </div>
              ))}
            </Shelf>
          ))}
        </div>
      ) : items.length ? (
        <Grid>
          {items.map((t, i) => (
            <TemplateCard key={t.id} t={t} copy={copyOf(t)} index={i} onLaunch={setLaunching} />
          ))}
        </Grid>
      ) : (
        <EmptyState
          icon={<Rocket className="size-6" />}
          title="Nothing matches"
          body={`No pre-made wadspace matches "${q}". You can always build exactly what you need.`}
          action={
            <Link to={category === "ai" ? "/builder?agent=1" : "/builder"}>
              <Button variant="primary">
                <Wand2 className="size-4" /> Build your own
              </Button>
            </Link>
          }
        />
      )}

      <LaunchDialog template={launching} onClose={() => setLaunching(null)} />
    </Page>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">{children}</div>;
}

function TemplateCard({ t, copy, index, onLaunch }: { t: Template; copy?: Wadspace; index: number; onLaunch: (t: Template) => void }) {
  const apps = useApp((s) => s.apps);
  const focus = useApp((s) => s.focus);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const list = useMemo(() => templateApps(t, apps), [t, apps]);
  const locked = !!copy && isLocked(focus, copy.id);
  const [hero, ...rest] = list;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  return (
    <motion.article
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index, 8) * 0.035, type: "spring", stiffness: 300, damping: 30 }}
      className="group relative flex w-full flex-col overflow-hidden rounded-3xl border border-line bg-surface transition-[box-shadow,border-color,transform] duration-300 hover:-translate-y-0.5 hover:border-line-strong hover:shadow-glow"
    >
      <div className="relative h-32 overflow-hidden bg-[#0a0614]">
        <img src={t.image} alt="" loading="lazy" className="size-full object-cover opacity-90 transition-transform duration-500 group-hover:scale-[1.05]" />
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-black/30" />
        <div className="absolute left-3 top-3 flex flex-wrap gap-1.5">
          {t.agent ? (
            <Badge tone="glass">
              <Bot className="size-3" /> {t.agent.autonomy === "auto" ? "Autonomous" : "Asks first"}
            </Badge>
          ) : t.instant ? (
            <Badge tone="glass">
              <Zap className="size-3 fill-current" /> Instant
            </Badge>
          ) : (
            <Badge tone="glass">{size(t.sizeMB)}</Badge>
          )}
        </div>
        {copy && (
          <div className="absolute right-3 top-3">
            <Badge tone="glass"><CopyStatus ws={copy} /></Badge>
          </div>
        )}
        {hero && <AppTile app={hero} size={64} glass className="absolute bottom-3 left-3" />}
        <div className="absolute bottom-3 right-3 flex -space-x-2">
          {rest.slice(0, 5).map((a) => (
            <AppTile key={a.id} app={a} size={34} glass className="ring-2 !ring-black/30" />
          ))}
        </div>
      </div>

      <div className="flex flex-1 flex-col p-4">
        <h3 className="truncate font-display text-[17px] font-semibold tracking-tight">{t.name}</h3>
        <p className="mt-0.5 line-clamp-2 text-[13px] text-muted">{t.description}</p>
        <p className="mt-2 truncate text-[11.5px] text-faint">{list.map((a) => a.name).join(" · ")}</p>

        <div className="mt-auto flex items-center gap-1.5 pt-4">
          {copy ? (
            <>
              <Button variant="primary" size="sm" className="flex-1" disabled={locked} onClick={() => openWadspace(copy)}>
                <Play className="size-3.5 fill-current" /> Open
              </Button>
              <IconButton label="Discard" title="Discard: remove it from this machine and your account" disabled={busy} onClick={() => run(() => discardWadspace(copy))}>
                <Trash2 className="size-4" />
              </IconButton>
            </>
          ) : (
            <>
              <Button variant="primary" size="sm" className="flex-1" disabled={busy || !!focus} title={focus ? "A focus session is running" : undefined} onClick={() => onLaunch(t)}>
                {t.agent ? <><Zap className="size-3.5 fill-current" /> Launch</> : <><Rocket className="size-3.5" /> Launch</>}
              </Button>
              <IconButton label="Download" title="Download to this machine" disabled={busy} onClick={() => run(() => downloadTemplate(t))}>
                <CloudDownload className="size-4" />
              </IconButton>
            </>
          )}
          <IconButton label="Open in Builder" title="Open in Wadspace Builder to customise it" onClick={() => navigate(builderHref(t))}>
            <Wand2 className="size-4" />
          </IconButton>
        </div>
      </div>
    </motion.article>
  );
}

const FEATURED = ["ai-claude-code", "fo-deep-work", "ga-retro", "cr-design", "ev-browser"];

export const builderHref = (t: Template) => `/builder?template=${t.id}`;

/** An app-store shelf: a heading, then a row that scrolls sideways with arrow buttons. */
function Shelf({ title, blurb, onSeeAll, children }: { title: string; blurb: string; onSeeAll?: () => void; children: React.ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const update = () => {
    const el = row.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft < 8, end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8 });
  };
  useEffect(() => {
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const page = (dir: 1 | -1) => row.current?.scrollBy({ left: dir * row.current.clientWidth * 0.85, behavior: "smooth" });

  return (
    <section>
      <div className="mb-3 flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="font-display text-xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-0.5 truncate text-sm text-muted">{blurb}</p>
        </div>
        {onSeeAll && (
          <button type="button" onClick={onSeeAll} className="shrink-0 text-sm font-medium text-muted hover:text-fg">
            See all
          </button>
        )}
      </div>
      <div className="group/shelf relative">
        {/* Stays inside the page margins and fades out at whichever edge has more to scroll.
            The vertical padding leaves room for the cards' hover lift and glow. */}
        <div
          ref={row}
          onScroll={update}
          className="ws-no-scrollbar flex snap-x snap-mandatory gap-4 overflow-x-auto py-3"
          style={{ maskImage: fadeMask(edges), WebkitMaskImage: fadeMask(edges) }}
        >
          {children}
        </div>
        <ShelfArrow dir={-1} hidden={edges.start} onClick={() => page(-1)} />
        <ShelfArrow dir={1} hidden={edges.end} onClick={() => page(1)} />
      </div>
    </section>
  );
}

const FADE = "56px";
const fadeMask = ({ start, end }: { start: boolean; end: boolean }) =>
  `linear-gradient(to right, ${start ? "black" : "transparent"} 0, black ${start ? "0px" : FADE}, black calc(100% - ${end ? "0px" : FADE}), ${end ? "black" : "transparent"} 100%)`;

/** Round arrow sitting on the row's edge; shows while the shelf is hovered and hides at that end. */
function ShelfArrow({ dir, hidden, onClick }: { dir: 1 | -1; hidden: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      tabIndex={hidden ? -1 : 0}
      aria-label={dir < 0 ? "Scroll left" : "Scroll right"}
      className={clsx(
        "absolute top-1/2 z-20 grid size-11 -translate-y-1/2 place-items-center rounded-full border border-line-strong bg-surface/90 text-fg shadow-deep backdrop-blur-md transition-[opacity,transform,background-color] duration-200 hover:scale-105 hover:bg-surface-2 focus-visible:opacity-100",
        dir < 0 ? "left-0 -translate-x-1/2" : "right-0 translate-x-1/2",
        hidden ? "pointer-events-none !opacity-0" : "opacity-0 group-hover/shelf:opacity-100 [@media(hover:none)]:opacity-100",
      )}
    >
      {dir < 0 ? <ChevronLeft className="size-5" /> : <ChevronRight className="size-5" />}
    </button>
  );
}

/** A wide, image-led card for the Featured shelf. */
function FeaturedCard({ t, copy, index, onLaunch }: { t: Template; copy?: Wadspace; index: number; onLaunch: (t: Template) => void }) {
  const apps = useApp((s) => s.apps);
  const focus = useApp((s) => s.focus);
  const list = templateApps(t, apps);
  const category = CATEGORIES.find((c) => c.value === t.category)?.label;
  const locked = !!copy && isLocked(focus, copy.id);
  return (
    <motion.article
      initial={{ opacity: 0, x: 16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05, type: "spring", stiffness: 300, damping: 30 }}
      className="group relative isolate flex h-64 w-[min(36rem,85vw)] shrink-0 snap-start flex-col justify-end overflow-hidden rounded-3xl border border-line p-5 text-white transition-[box-shadow,transform] duration-300 hover:-translate-y-0.5 hover:shadow-glow"
    >
      <img src={t.image} alt="" className="absolute inset-0 -z-10 size-full object-cover transition-transform duration-700 group-hover:scale-[1.04]" />
      <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/90 via-black/45 to-black/5" />
      <div className="absolute left-5 top-5 flex gap-1.5">
        {category && <Badge tone="glass">{category}</Badge>}
        <Badge tone="glass">{t.instant ? <><Zap className="size-3 fill-current" /> Instant</> : t.agent ? <><Bot className="size-3" /> AI agent</> : size(t.sizeMB)}</Badge>
      </div>
      <div className="absolute right-5 top-5 flex -space-x-2">
        {list.slice(0, 5).map((a) => (
          <AppTile key={a.id} app={a} size={38} glass className="ring-2 !ring-black/30" />
        ))}
      </div>

      <h3 className="font-display text-2xl font-bold tracking-tight">{t.name}</h3>
      <p className="mt-1 line-clamp-2 max-w-md text-sm text-white/75">{t.description}</p>
      <div className="mt-4 flex items-center gap-2">
        {copy ? (
          <Button variant="primary" size="sm" disabled={locked} onClick={() => openWadspace(copy)}>
            <Play className="size-3.5 fill-current" /> Open
          </Button>
        ) : (
          <Button variant="primary" size="sm" disabled={!!focus} onClick={() => onLaunch(t)}>
            {t.agent ? <Zap className="size-3.5 fill-current" /> : <Rocket className="size-3.5" />} Launch
          </Button>
        )}
        <Link to={builderHref(t)} className="flex h-8 items-center gap-1.5 rounded-xl bg-white/15 px-3 text-[13px] font-medium ring-1 ring-white/20 backdrop-blur-md transition-colors hover:bg-white/25">
          <Wand2 className="size-3.5" /> Open in Builder
        </Link>
      </div>
    </motion.article>
  );
}

/** Quick Launch copies the user currently has, with one-click discard. */
function InUse({ copies }: { copies: Wadspace[] }) {
  const focus = useApp((s) => s.focus);
  const apps = useApp((s) => s.apps);
  const heroOf = (w: Wadspace) => apps.find((a) => a.id === TEMPLATES.find((t) => t.id === w.templateId)?.apps[0]);
  return (
    <section className="mb-10">
      <h2 className="mb-3 font-display text-lg font-semibold tracking-tight">
        In use <span className="ml-1 text-sm font-normal text-faint">{copies.length}</span>
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {copies.map((w) => (
          <div key={w.id} className="flex w-72 shrink-0 items-center gap-3 rounded-2xl border border-line bg-surface p-2 pr-3">
            {heroOf(w) ? <AppTile app={heroOf(w)!} size={44} /> : <span className="grid size-11 shrink-0 place-items-center rounded-[28%] bg-surface-2"><Rocket className="size-5 text-muted" /></span>}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{w.name}</div>
              <div className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                <CopyStatus ws={w} />
              </div>
            </div>
            <IconButton label="Open" disabled={isLocked(focus, w.id)} onClick={() => openWadspace(w)}>
              <Play className="size-4 fill-current" />
            </IconButton>
            <IconButton label="Discard" onClick={() => discardWadspace(w)}>
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Where a Quick Launch copy is: on this machine, on its way down, or only in the account. */
function CopyStatus({ ws }: { ws: Wadspace }) {
  const download = useApp((s) => s.downloads.find((d) => d.wadspaceId === ws.id));
  if (ws.local) return <><HardDrive className="size-3" /> Downloaded</>;
  if (download) return <><CloudDownload className="size-3" /> Downloading {Math.floor(download.progress * 100)}%</>;
  return <><Rocket className="size-3" /> Launched</>;
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx("flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium ring-1 transition-colors", on ? "bg-accent text-accent-fg ring-accent" : "bg-surface-2 text-muted ring-line hover:text-fg")}
    >
      {children}
    </button>
  );
}

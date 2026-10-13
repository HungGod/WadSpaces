// An app from the catalog, in detail: what it does and how it looks, its
// licence, how it gets into a template's image (the RUN line and the base
// image's own feature script), and the sign-in it keeps.
import { useEffect, useState } from "react";
import { ExternalLink, KeyRound, Minus, Plus } from "lucide-react";
import clsx from "clsx";
import { runLine, SECRET_KINDS, type AppDef } from "@core/catalog/catalog";
import { Badge, Button, Modal } from "./ui";

/** The base image's feature scripts (images/base/.../features), read when shown. */
const SCRIPTS = import.meta.glob("@features/*.sh", { query: "?raw", import: "default" }) as Record<string, () => Promise<string>>;

/** A feature's script, once loaded. */
function useFeatureScript(feature: string | null, open: boolean) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!feature || !open) return;
    const load = Object.entries(SCRIPTS).find(([path]) => path.endsWith(`/${feature}.sh`))?.[1];
    let live = true;
    load?.().then((t) => live && setText(t));
    return () => {
      live = false;
    };
  }, [feature, open]);
  return text;
}

/** An app: what it does, how it looks, how it gets into an image, and what sign-in it keeps. */
export function AppDetails({ app, onClose, added, onToggle }: { app: AppDef | null; onClose: () => void; added?: boolean; onToggle?: () => void }) {
  return (
    <Modal open={!!app} onClose={onClose} width={760}>
      {app && <Body key={app.id} app={app} added={added} onToggle={onToggle} />}
    </Modal>
  );
}

function Body({ app, added, onToggle }: { app: AppDef; added?: boolean; onToggle?: () => void }) {
  const [shot, setShot] = useState(0);
  const [showScript, setShowScript] = useState(false);
  const feature = app.install.kind === "feature" ? app.install.feature : null;
  const script = useFeatureScript(feature, showScript);
  const run = runLine(app);
  const current = app.screenshots[shot];
  return (
    <div className="space-y-5">
      <div className="flex items-start gap-4">
        <img src={app.icon} alt="" className="size-14 shrink-0 object-contain" />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-xl font-semibold tracking-tight">{app.name}</h2>
          <p className="text-sm text-muted">{app.summary}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge>{app.category}</Badge>
            {app.secret && (
              <Badge tone="accent">
                <KeyRound className="size-3" /> Keeps a sign-in
              </Badge>
            )}
            {app.options && <Badge>Customizable</Badge>}
            {app.license && <Badge>{app.license}</Badge>}
          </div>
        </div>
        {onToggle && (
          <Button variant={added ? "secondary" : "primary"} onClick={onToggle}>
            {added ? (
              <>
                <Minus className="size-4" /> Remove
              </>
            ) : (
              <>
                <Plus className="size-4" /> Add to template
              </>
            )}
          </Button>
        )}
      </div>

      {current && (
        <figure>
          <div className="overflow-hidden rounded-2xl bg-black ring-1 ring-line">
            <img src={current.src} alt={current.caption || `${app.name} screenshot`} className="mx-auto max-h-[380px] w-full object-contain" />
          </div>
          {current.caption && <figcaption className="mt-1.5 text-center text-xs text-muted">{current.caption}</figcaption>}
          {app.screenshots.length > 1 && (
            <div className="mt-2 flex justify-center gap-2">
              {app.screenshots.map((s, i) => (
                <button key={s.src} type="button" onClick={() => setShot(i)} className={clsx("h-12 w-20 overflow-hidden rounded-lg ring-1", i === shot ? "ring-2 ring-accent" : "ring-line opacity-70 hover:opacity-100")} aria-label={`Screenshot ${i + 1}`}>
                  <img src={s.src} alt="" className="size-full object-cover" />
                </button>
              ))}
            </div>
          )}
        </figure>
      )}

      <p className="text-sm leading-relaxed">{app.description}</p>

      <section className="rounded-2xl bg-surface-2/60 p-4 ring-1 ring-line">
        <div className="text-xs font-semibold uppercase tracking-[0.12em] text-faint">How it gets into the image</div>
        <p className="mt-2 text-sm">{app.install.source}</p>
        {run && <pre className="mt-2 overflow-x-auto rounded-lg bg-bg px-3 py-2 font-mono text-[12px] text-muted ring-1 ring-line">RUN {run}</pre>}
        {feature && (
          <>
            <button type="button" onClick={() => setShowScript(!showScript)} className="mt-2 text-xs font-medium text-accent hover:underline">
              {showScript ? "Hide" : "Show"} the feature script ({feature}.sh)
            </button>
            {showScript && <pre className="mt-2 max-h-60 overflow-auto rounded-lg bg-bg px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted ring-1 ring-line">{script ?? "Loading…"}</pre>}
          </>
        )}
        <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {app.example && (
            <a href={app.example} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-muted hover:text-fg">
              <ExternalLink className="size-3" /> Following {app.example.replace("https://github.com/", "")}
            </a>
          )}
          {app.homepage && (
            <a href={app.homepage} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 text-xs text-muted hover:text-fg">
              <ExternalLink className="size-3" /> {app.homepage.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </a>
          )}
        </div>
      </section>

      {app.secret && (
        <p className="flex items-start gap-2 text-xs text-muted">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" />
          {SECRET_KINDS[app.secret.kind].label}: {SECRET_KINDS[app.secret.kind].keeps}. Saved or picked when you construct a wadspace.
        </p>
      )}
    </div>
  );
}

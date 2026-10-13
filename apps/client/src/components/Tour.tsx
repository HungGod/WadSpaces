// The new user's tour (lib/tour.ts): a card beside what each step is about,
// with that spotlit, from the Builder in the sidebar to the Launch button.
import { useLocation, useNavigate } from "react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Sparkles, X } from "lucide-react";
import clsx from "clsx";
import { useApp } from "@/lib/store";
import { useTour, type TourStep } from "@/lib/tour";

interface StepDef {
  /** Elements to spotlight; the hole is their combined bounding box. */
  targets: string[];
  /** Where to put the card relative to the hole, in order of preference. */
  placement: ("right" | "below" | "left" | "above")[];
  /** Darken everything outside the hole and block clicks there. */
  blocking: boolean;
  /** Only valid on the Builder page. */
  builder: boolean;
}

const STEPS: Record<TourStep, StepDef> = {
  nav: { targets: ['[data-tour="nav-builder"]'], placement: ["right"], blocking: true, builder: false },
  board: { targets: ['[data-tour="board"]'], placement: ["below", "left"], blocking: false, builder: true },
  create: { targets: ['[data-tour="create"]'], placement: ["below", "left"], blocking: false, builder: true },
  build: { targets: ['[data-tour="build"]'], placement: ["above", "right"], blocking: false, builder: true },
  launch: { targets: ['[data-tour="launcher"]'], placement: ["right", "above"], blocking: true, builder: false },
};

const NUMBERED: TourStep[] = ["board", "create", "build", "launch"];
const PAD = 8;
const CARD_W = 340;

type Box = { top: number; left: number; right: number; bottom: number };

function measure(selectors: string[]): Box | null {
  const rects = selectors.map((s) => document.querySelector(s)?.getBoundingClientRect()).filter((r): r is DOMRect => !!r && r.width > 0);
  if (!rects.length || rects.length < selectors.length) return null;
  return {
    top: Math.min(...rects.map((r) => r.top)) - PAD,
    left: Math.min(...rects.map((r) => r.left)) - PAD,
    right: Math.max(...rects.map((r) => r.right)) + PAD,
    bottom: Math.max(...rects.map((r) => r.bottom)) + PAD,
  };
}

const same = (a: Box | null, b: Box | null) => a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.right === b.right && a.bottom === b.bottom);

export function Tour() {
  const { step, completed, next, finish } = useTour();
  const user = useApp((s) => s.user);
  const pathname = useLocation().pathname;
  const navigate = useNavigate();
  const [hole, setHole] = useState<Box | null>(null);
  const [missing, setMissing] = useState(false);
  const [cardH, setCardH] = useState(220);
  const card = useRef<HTMLDivElement>(null);
  const def = step ? STEPS[step] : null;
  // Step 0 finishes by opening the Builder.
  useEffect(() => {
    if (step === "nav" && pathname.startsWith("/builder")) next();
  }, [step, pathname, next]);

  // Follow the target elements every frame (they move with layout, scrolling and resizes).
  useEffect(() => {
    if (!def) return;
    let raf = 0;
    let lostAt: number | null = null;
    const tick = () => {
      const box = def.targets.length ? measure(def.targets) : null;
      setHole((prev) => (same(prev, box) ? prev : box));
      // Only fall back to the "go to Builder" card if targets stay missing (not just while a page loads).
      if (def.targets.length && !box) lostAt ??= performance.now();
      else lostAt = null;
      setMissing(lostAt !== null && performance.now() - lostAt > 700);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [def]);

  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setCardH(e.contentRect.height));
    ro.observe(el);
    return () => ro.disconnect();
  });

  if (!step || !def) return null;

  // Off the Builder: a card to go back. On it with nothing to spotlight yet
  // (a picker open, an earlier step): the card alone, docked.
  const lost = def.builder && !pathname.startsWith("/builder");
  const docked = !lost && def.targets.length > 0 && missing;
  const index = NUMBERED.indexOf(step);

  const content = copy(step, user?.displayName ?? "there");
  const primary =
    step === "nav"
      ? { label: "Open the Builder", onClick: () => navigate("/builder") }
      : step === "board"
        ? { label: "Next step", onClick: next, ready: true }
        : step === "create" || step === "build"
          ? { label: completed[step] ? "Next step" : "Skip this step", onClick: next, ready: !!completed[step] }
          : null;

  // ---- Card placement ----
  const vw = typeof window === "undefined" ? 1600 : window.innerWidth;
  const vh = typeof window === "undefined" ? 900 : window.innerHeight;
  let pos: { left: number; top: number };
  if (lost || docked || !hole) {
    pos = { left: vw - CARD_W - 24, top: vh - cardH - 24 };
  } else {
    const fits = {
      right: hole.right + 16 + CARD_W <= vw - 16,
      left: hole.left - 16 - CARD_W >= 16,
      below: hole.bottom + 16 + cardH <= vh - 16,
      above: hole.top - 16 - cardH >= 16,
    };
    const side = def.placement.find((p) => fits[p]);
    const clampY = (y: number) => Math.min(Math.max(16, y), vh - cardH - 16);
    const clampX = (x: number) => Math.min(Math.max(16, x), vw - CARD_W - 16);
    if (side === "right") pos = { left: hole.right + 16, top: clampY(hole.top) };
    else if (side === "left") pos = { left: hole.left - 16 - CARD_W, top: clampY(hole.top) };
    else if (side === "below") pos = { left: clampX(hole.right - CARD_W), top: hole.bottom + 16 };
    else if (side === "above") pos = { left: clampX(hole.right - CARD_W), top: hole.top - 16 - cardH };
    // Big spotlight with no room beside it: dock the card at the right edge, over the dimmed area.
    else pos = { left: vw - CARD_W - 16, top: clampY(hole.top + 24) };
  }

  const dim = "bg-[#0a0614]/70";
  const showHole = def.blocking && hole && !lost && !docked;

  return (
    <div className="pointer-events-none fixed inset-0 z-[10050]">
      {hole && !lost && !docked && !def.blocking && (
        <motion.div
          className="absolute rounded-2xl border-2 border-accent"
          style={{ top: hole.top, left: hole.left, width: hole.right - hole.left, height: hole.bottom - hole.top }}
          animate={{ boxShadow: ["0 0 0 0px var(--accent-soft)", "0 0 0 10px transparent"] }}
          transition={{ duration: 1.4, repeat: Infinity }}
        />
      )}
      {showHole && (
        <>
          {/* Four blockers around the hole: dim the page and swallow clicks outside the spotlight. */}
          <div className={clsx("pointer-events-auto absolute inset-x-0 top-0", dim)} style={{ height: Math.max(0, hole.top) }} />
          <div className={clsx("pointer-events-auto absolute inset-x-0 bottom-0", dim)} style={{ top: hole.bottom }} />
          <div className={clsx("pointer-events-auto absolute left-0", dim)} style={{ top: hole.top, height: hole.bottom - hole.top, width: Math.max(0, hole.left) }} />
          <div className={clsx("pointer-events-auto absolute right-0", dim)} style={{ top: hole.top, height: hole.bottom - hole.top, left: hole.right }} />
          <motion.div
            className="absolute rounded-2xl border-2 border-accent"
            style={{ top: hole.top, left: hole.left, width: hole.right - hole.left, height: hole.bottom - hole.top }}
            animate={{ boxShadow: ["0 0 0 0px var(--accent-soft)", "0 0 0 10px transparent"] }}
            transition={{ duration: 1.4, repeat: Infinity }}
          />
        </>
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={`${step}-${lost}`}
          ref={card}
          initial={{ opacity: 0, y: 8, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          transition={{ type: "spring", stiffness: 420, damping: 32 }}
          className="pointer-events-auto absolute rounded-3xl border border-line-strong bg-surface p-5 text-fg shadow-deep"
          style={{ width: CARD_W, left: pos.left, top: pos.top }}
          role="dialog"
          aria-label="Tutorial"
        >
          <div className="mb-3 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-accent">
              <Sparkles className="size-3" /> {index >= 0 ? `Step ${index + 1} of ${NUMBERED.length}` : "Welcome"}
            </span>
            <button type="button" onClick={finish} className="rounded-lg p-1 text-faint hover:bg-surface-2 hover:text-fg" aria-label="Skip tour" title="Skip tour">
              <X className="size-4" />
            </button>
          </div>

          {lost ? (
            <>
              <h3 className="font-display text-lg font-bold tracking-tight">Continue in the Builder</h3>
              <p className="mt-1.5 text-sm text-muted">The rest of the tour happens in the Builder.</p>
              <div className="mt-5 flex items-center justify-between">
                <button type="button" onClick={finish} className="text-xs text-faint hover:text-fg">Skip tour</button>
                <button type="button" onClick={() => navigate("/builder")} className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg hover:brightness-110">
                  Open the Builder <ArrowRight className="size-4" />
                </button>
              </div>
            </>
          ) : (
            <>
              <h3 className="font-display text-lg font-bold tracking-tight">{content.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{content.body}</p>
              {content.tip && <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted ring-1 ring-line">{content.tip}</p>}
              <div className="mt-5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  {NUMBERED.map((s, i) => (
                    <span key={s} className={clsx("h-1.5 rounded-full transition-all", i === index ? "w-5 bg-accent" : i < index ? "w-1.5 bg-accent/60" : "w-1.5 bg-line-strong")} />
                  ))}
                  <button type="button" onClick={finish} className="ml-2 text-xs text-faint hover:text-fg">
                    Skip tour
                  </button>
                </div>
                {primary && (
                  <button
                    type="button"
                    onClick={primary.onClick}
                    className={clsx(
                      "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-4 text-sm font-semibold transition-all",
                      step === "nav" || ("ready" in primary && primary.ready) ? "bg-accent text-accent-fg hover:brightness-110" : "bg-surface-2 text-muted ring-1 ring-line hover:text-fg",
                    )}
                  >
                    {primary.label} <ArrowRight className="size-4" />
                  </button>
                )}
              </div>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function copy(step: TourStep, name: string): { title: string; body: string; tip?: string } {
  switch (step) {
    case "nav":
      return {
        title: `Welcome to WadSpaces, ${name}!`,
        body: "Wadspaces are made in the Builder, as stacks of modules: a template (its apps), maybe Extensions (how they're set up), then its Customization (name, background, projects and keys). Let's make your first one.",
      };
    case "board":
      return {
        title: "The board",
        body: "Each stack is a wadspace. Drag a module (and what's on it) onto another stack to copy it there, Shift+drag to take just one, or drop it between stacks for a new one. Click a module to edit it.",
        tip: "A template can sit on another whose apps it all has: it builds on that one's image.",
      };
    case "create":
      return {
        title: "Make a stack",
        body: "+ Create puts a new stack at the end of the board with a blank template. Click it to pick its apps.",
      };
    case "build":
      return {
        title: "Build it",
        body: "The Build bucket builds every stack that needs it (or drop one stack on it). Its images are built on your machine; a stack shows when it's out of date.",
      };
    case "launch":
      return {
        title: "Launch it",
        body: "Launch opens wadspaces, WadBrowsers and the terminal together on your machine, or for a focus session. Click it to finish the tour.",
      };
  }
}

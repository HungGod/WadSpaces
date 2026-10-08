import { create } from "zustand";
import { backend } from "@/data";

/** New-user tutorial: highlight the Builder tab, then walk through apps → projects → test. */
export type TourStep = "nav" | "apps" | "projects" | "test" | "testing";
export type TourEvent = "app-added" | "preview-opened";

const ORDER: TourStep[] = ["nav", "apps", "projects", "test", "testing"];
const key = (user: string) => `ws-tour:${user}`;

interface TourState {
  user: string | null;
  step: TourStep | null;
  /** Steps whose action the user has completed (e.g. added an app). */
  completed: Partial<Record<TourStep, boolean>>;
  /** Start (or resume) the tour for a user. */
  start: (user: string, resume?: boolean) => void;
  next: () => void;
  signal: (e: TourEvent) => void;
  /** Finish or skip: marks the user onboarded so it doesn't run again. */
  finish: () => void;
}

function save(user: string | null, step: TourStep | null) {
  if (!user) return;
  try {
    if (step) localStorage.setItem(key(user), step);
    else localStorage.removeItem(key(user));
  } catch {}
}

export const useTour = create<TourState>((set, get) => ({
  user: null,
  step: null,
  completed: {},

  start: (user, resume = false) => {
    let step: TourStep = "nav";
    if (resume) {
      try {
        const saved = localStorage.getItem(key(user)) as TourStep | null;
        if (saved && ORDER.includes(saved)) step = saved === "testing" ? "test" : saved;
      } catch {}
    }
    set({ user, step, completed: {} });
    save(user, step);
  },

  next: () => {
    const { step, user } = get();
    if (!step) return;
    const i = ORDER.indexOf(step);
    if (i >= ORDER.length - 1) return get().finish();
    const nextStep = ORDER[i + 1];
    set({ step: nextStep });
    save(user, nextStep);
  },

  // Adding an app marks the step done (the user may keep adding, then hit Next);
  // opening the preview moves straight on to the "testing" hint.
  signal: (e) => {
    const { step, completed } = get();
    if (step === "apps" && e === "app-added") set({ completed: { ...completed, apps: true } });
    if (step === "test" && e === "preview-opened") get().next();
  },

  finish: () => {
    const { user } = get();
    save(user, null);
    set({ step: null });
    backend.setOnboarded().catch(() => {});
  },
}));

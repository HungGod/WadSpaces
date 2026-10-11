// The new user's tour through the Builder: the Builder in the sidebar, a
// template stack (Step 1), customizing it and Import (Step 2), constructing a
// wadspace and its secrets (Step 3), the live preview, then the Launch
// button. Where it got to is kept per user, so a reload resumes it.
import { create } from "zustand";
import { backend } from "@/data";

export type TourStep = "nav" | "stack" | "customize" | "construct" | "preview" | "launch";
/** What the Builder and launcher tell the tour. */
export type TourEvent = "stack-opened" | "customization-saved" | "wadspace-saved" | "launcher-opened";

export const ORDER: TourStep[] = ["nav", "stack", "customize", "construct", "preview", "launch"];
const key = (user: string) => `ws-tour:${user}`;

interface TourState {
  user: string | null;
  step: TourStep | null;
  /** Steps whose action the user has done (e.g. saved a customization). */
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
  } catch {
    // No storage: the tour starts over next time.
  }
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
        if (saved && ORDER.includes(saved)) step = saved;
      } catch {
        // No storage: from the top.
      }
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

  // Opening a stack and opening the launcher move on; saving in Steps 2 and 3
  // marks those done (the user may keep going, then hit Next).
  signal: (e) => {
    const { step, completed } = get();
    if (step === "stack" && e === "stack-opened") get().next();
    if (step === "customize" && e === "customization-saved") set({ completed: { ...completed, customize: true } });
    if (step === "construct" && e === "wadspace-saved") get().next();
    if (step === "launch" && e === "launcher-opened") get().finish();
  },

  finish: () => {
    const { user } = get();
    save(user, null);
    set({ step: null });
    backend.setOnboarded().catch(() => {});
  },
}));

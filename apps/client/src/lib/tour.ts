// The new user's tour through the Builder: the Builder in the sidebar, the
// board and its stacks, + Create (a new stack), the Build bucket, then the
// Launch button. Where it got to is kept per user, so a reload resumes it.
import { create } from "zustand";
import { backend } from "@/data";

export type TourStep = "nav" | "board" | "create" | "build" | "launch";
/** What the Builder and launcher tell the tour. */
export type TourEvent = "stack-created" | "build-started" | "launcher-opened";

export const ORDER: TourStep[] = ["nav", "board", "create", "build", "launch"];
const key = (user: string) => `ws-tour:${user}`;

interface TourState {
  user: string | null;
  step: TourStep | null;
  /** Steps whose action the user has done (e.g. made a stack). */
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

  // Making a stack and building one move on; opening the launcher finishes.
  signal: (e) => {
    const { step, completed } = get();
    if (step === "create" && e === "stack-created") {
      set({ completed: { ...completed, create: true } });
      get().next();
    }
    if (step === "build" && e === "build-started") get().next();
    if (step === "launch" && e === "launcher-opened") get().finish();
  },

  finish: () => {
    const { user } = get();
    save(user, null);
    set({ step: null });
    backend.setOnboarded().catch(() => {});
  },
}));

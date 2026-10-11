// Which app-wide dialog or drawer is open, so any card or page can open one:
// a wadspace's details (WadspaceDrawer) and the launcher.
import { create } from "zustand";

interface UiState {
  /** The wadspace whose details drawer is open. */
  detailsId: string | null;
  /** The launcher, maybe straight into customizing a wadspace for a run. */
  launcher: { customize?: string } | null;
  openDetails: (id: string | null) => void;
  openLauncher: (opts?: { customize?: string }) => void;
  closeLauncher: () => void;
}

export const useUi = create<UiState>((set) => ({
  detailsId: null,
  launcher: null,
  openDetails: (detailsId) => set({ detailsId }),
  openLauncher: (opts = {}) => set({ launcher: opts }),
  closeLauncher: () => set({ launcher: null }),
}));

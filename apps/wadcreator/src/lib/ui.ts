import { create } from "zustand";

/** Which global dialog/drawer is open. Any card or page can open these. */
interface UiState {
  detailsId: string | null;
  focusOpen: boolean;
  focusPreselect: string[];
  /** The Run dialog: a wadspace to pick projects for, or a launch to follow. */
  run: { wadspaceId: string; launchId?: string } | null;
  openDetails: (id: string | null) => void;
  openFocus: (preselect?: string[]) => void;
  closeFocus: () => void;
  openRun: (wadspaceId: string, launchId?: string) => void;
  closeRun: () => void;
}

export const useUi = create<UiState>((set) => ({
  detailsId: null,
  focusOpen: false,
  focusPreselect: [],
  run: null,
  openDetails: (detailsId) => set({ detailsId }),
  openFocus: (preselect = []) => set({ focusOpen: true, focusPreselect: preselect }),
  closeFocus: () => set({ focusOpen: false }),
  openRun: (wadspaceId, launchId) => set({ run: { wadspaceId, launchId } }),
  closeRun: () => set({ run: null }),
}));

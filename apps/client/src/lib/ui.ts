import { create } from "zustand";

/** Which global dialog/drawer is open. Any card or page can open these. */
interface UiState {
  detailsId: string | null;
  /** The Edit dialog: a wadspace's name, description and background. */
  editId: string | null;
  /** The Start dialog: wadspaces to open together, maybe in a focus session. */
  start: { preselect: string[]; focus: boolean } | null;
  /** The Run dialog: a wadspace to pick projects for, or a launch to follow. */
  run: { wadspaceId: string; launchId?: string } | null;
  openDetails: (id: string | null) => void;
  openEdit: (id: string | null) => void;
  openStart: (preselect?: string[], opts?: { focus?: boolean }) => void;
  closeStart: () => void;
  openRun: (wadspaceId: string, launchId?: string) => void;
  closeRun: () => void;
}

export const useUi = create<UiState>((set) => ({
  detailsId: null,
  editId: null,
  start: null,
  run: null,
  openDetails: (detailsId) => set({ detailsId }),
  openEdit: (editId) => set({ editId }),
  openStart: (preselect = [], opts = {}) => set({ start: { preselect, focus: !!opts.focus } }),
  closeStart: () => set({ start: null }),
  openRun: (wadspaceId, launchId) => set({ run: { wadspaceId, launchId } }),
  closeRun: () => set({ run: null }),
}));

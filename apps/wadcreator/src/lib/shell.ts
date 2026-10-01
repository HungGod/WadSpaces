// The offline app's Electron shell (desktop/preload.cjs), when there is one.
// In a browser (online app, or offline dev in Chrome) it's undefined.

export interface ShellBridge {
  shell: true;
  ready(): void;
}

export const shell: ShellBridge | undefined = (globalThis as { wadcreator?: ShellBridge }).wadcreator;

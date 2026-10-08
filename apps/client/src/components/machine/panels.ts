// The machine app's menus (Wi-Fi, power, GitHub sign-in): opened by the HUD's buttons
// (through wadd's `panel` event) or a page. MachineChrome shows them.
type Panel = "wifi" | "power" | "github";
const listeners = new Set<(p: Panel) => void>();

export function openMachinePanel(p: Panel) {
  listeners.forEach((fn) => fn(p));
}

export function onMachinePanel(fn: (p: Panel) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export type { Panel };

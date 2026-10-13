// The machine's HUD floats its bar over the bottom-right of every window
// (apps/hud). In the machine's own app, --hud-room on the page is the height
// the bar takes while it's out (0 while it's tucked behind its arrow, and
// anywhere else): what sits along the bottom edge stays above it.
import { inTauri } from "./shell";

/** The bar (about 34 px of pills) and its 12 px margin, and a little air. */
export const HUD_ROOM = "52px";

export function followHud() {
  if (!inTauri) return;
  let last: boolean | null = null;
  const check = () =>
    import("@/gen/bindings")
      .then(({ commands }) => commands.hudBarOpen())
      .then((open) => {
        if (open === last) return;
        last = open;
        document.documentElement.style.setProperty("--hud-room", open ? HUD_ROOM : "0px");
      })
      .catch(() => {});
  void check();
  // The HUD says nothing when its bar comes and goes; what it remembers is read again.
  setInterval(check, 1000);
}

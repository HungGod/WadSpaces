// What the image doesn't decide alone about how a desktop looks: the
// machine's screen size (icons wrap into columns by its height; wadd's
// GET /v1/machine, or the default machine's heartbeat online), and the
// picture selkies-desktop draws on the Start button and in the middle of
// every desktop: the WadSpaces logo (the base's icon.png), always.
import { useApp } from "@/lib/store";

export interface Screen {
  w: number;
  h: number;
}

/** The picture the base image's icon.png is (images/base/root/usr/share/selkies/www). */
export const LOGO = "/brand/wadspaces-icon-dark-transparent.svg";

/** The launch machine's screen, in logical pixels: the wadspace gets all of it (the HUD floats over it). */
export const useScreen = (): Screen => {
  const s = useApp((st) => st.machineScreen);
  return { w: s.width, h: s.height };
};

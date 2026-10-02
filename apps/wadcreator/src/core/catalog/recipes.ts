// How each app in the catalog (apps.json) gets into a real wadspace image.
//
//   feature   an existing `wadspaces-feature` script in Wadspaces-David/_common;
//             `desktop` is the launcher it writes (add_desktop_entry)
//   apt       Debian trixie packages, installed by `wadspaces-apt`; `desktop`
//             names the launcher to put on the desktop (otherwise the helper
//             takes the first new one in /usr/share/applications)
//   webapp    a Chrome --app window (`wadspaces-webapp`); pulls in chrome
//   builtin   already in the base image
//   soon      not installable yet (third-party repo, AI agent, ...): shown in
//             the catalog with a "Coming soon" badge and skipped by builds
//
// The recipes are wad-core's (crates/wad-core/src/recipes.rs), run as WebAssembly.
import type { FeatureId } from "../spec";
import { call } from "../wasm";

export type Recipe =
  | { kind: "feature"; feature: FeatureId; desktop: string[] }
  | { kind: "apt"; packages: string[]; desktop?: string }
  | { kind: "webapp"; url: string }
  | { kind: "builtin"; desktop: string }
  | { kind: "soon"; reason: string };

/** The catalog's recipe; custom apps from the Builder's "Custom app" dialog are websites. */
export function recipeFor(appId: string, domain?: string): Recipe {
  return call("recipeFor", appId, ...(domain !== undefined ? [domain] : []));
}

export const isInstallable = (r: Recipe) => r.kind !== "soon";

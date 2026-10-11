// Saved sign-ins (wadd's): kept on the machine and mounted into each
// wadspace whose apps use them, so signing in once covers all of them.
import { call } from "./wasm";
import { recipeFor } from "./catalog/recipes";
import type { LayoutIcon } from "./model";

/** A web app's kind of sign-in: a WadBrowser profile, any web app can use it. */
export const WEB = "web";

/** Where a catalog app keeps its sign-in, under the home folder (a folder's
 *  path ends in /); null for an app the catalog doesn't know. */
export const signInPaths = (appId: string): string[] | null => call("signInPaths", appId);

/** A path a sign-in may keep: under the home folder, not the Desktop. */
export const isSignInPath = (p: string): boolean => call("isSignInPath", p);

/** Which sign-ins an icon's app can use: "web" for WadBrowser web apps, its
 *  app id for an installed app, or null (Chrome windows, apps not
 *  installable yet). */
export function signInKind(icon: Pick<LayoutIcon, "appId" | "url" | "iconUrl">): string | null {
  const r = recipeFor(icon.appId, icon.url);
  if (r.kind === "webapp") return r.chrome ? null : WEB;
  if (r.kind === "soon") return null;
  return icon.appId;
}

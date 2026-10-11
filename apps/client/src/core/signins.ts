// Saved sign-ins (wadd's): kept on the machine and mounted into each
// wadspace whose slots pick them, so signing in once covers all of them.
import { call } from "./wasm";

/** A web app's kind of sign-in: a WadBrowser profile, any web app can use it. */
export const WEB = "web";

/** Where a kind of sign-in (or a catalog app) keeps its files, under the
 *  home folder (a folder's path ends in /); null when there are none to keep. */
export const signInPaths = (appId: string): string[] | null => call("signInPaths", appId);

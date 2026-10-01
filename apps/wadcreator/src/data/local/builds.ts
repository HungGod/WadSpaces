// Building on this machine: the app makes the build folder (the same one
// "Download build folder" gives you), tars it, and hands it to wadd, which
// builds it with podman and adds the workspace (wadd/builds.py).
import { toBuildSpec } from "@core/build";
import { bundleFiles } from "@core/generator";
import type { WadspaceSpec } from "@core/model";
import type { Project } from "@core/projects";
import { tar } from "@core/tar";
import { toWaddSpec, type WaddSpec } from "@core/spec";
import { renderWallpaper } from "@/lib/wallpaperRender";
import type { BuildUpdate, LaunchUpdate } from "@/lib/wadd";
import type { BuildProgress, LaunchProgress } from "../backend";

export interface BuildRequest {
  workspace: WaddSpec;
  baseImage: string;
  tarball: Uint8Array;
  skipped: { label: string; reason: string }[];
}

const union = (a?: string[], b?: string[]) => {
  const all = [...(a ?? []), ...(b ?? [])];
  return all.length ? [...new Set(all)] : undefined;
};

/**
 * The build folder for a wadspace, and the workspace entry wadd should run it
 * as. A workspace already on the machine keeps its own extras (its icon,
 * extra volumes) and takes the Builder's settings for the rest. `projects`
 * names its default projects in the folder's README.
 */
export async function buildRequest(ws: WadspaceSpec, installed?: WaddSpec, projects?: Project[]): Promise<BuildRequest> {
  const wp = await renderWallpaper(ws.layout.wallpaper);
  const { spec, skipped } = toBuildSpec(ws, { wallpaperFile: wp.fileName, projects });
  const files = bundleFiles(spec, new Uint8Array(await wp.blob.arrayBuffer()), ws.dockerfile);
  const fresh = toWaddSpec(spec);
  const workspace: WaddSpec = installed
    ? { ...installed, ...fresh, volumes: union(installed.volumes, fresh.volumes), icon: installed.icon }
    : fresh;
  return { workspace, baseImage: spec.baseImage, tarball: tar(files), skipped };
}

/** wadd's build job, as the app tracks builds. */
export function toProgress(u: BuildUpdate): BuildProgress {
  const status = u.status === "done" ? "done" : u.status === "error" || u.status === "cancelled" ? "error" : "building";
  return {
    id: u.id,
    wadspaceId: u.wsId,
    name: u.name,
    status,
    progress: u.progress,
    error: u.status === "cancelled" ? "Cancelled" : u.error,
    from: u.from,
    lines: u.lines,
    restartRequired: u.restartRequired,
  };
}

/** wadd's launch job, as the app tracks launches. */
export function toLaunchProgress(u: LaunchUpdate): LaunchProgress {
  return {
    id: u.id,
    wadspaceId: u.wsId,
    name: u.name,
    projects: u.projects,
    status: u.status,
    progress: u.progress,
    phase: u.phase,
    error: u.status === "cancelled" ? "Cancelled" : u.error,
    parts: u.parts,
    from: u.from ?? 0,
    lines: u.lines ?? [],
  };
}

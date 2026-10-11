// Building on this machine: the Rust wadd makes the build folder itself from
// the design (designRequest); the app only draws the wallpaper. Build and
// launch events, as the app tracks them.
import type { WadspaceSpec } from "@core/model";
import type { Project } from "@core/projects";
import { renderWallpaper } from "@/lib/wallpaperRender";
import type { BuildUpdate, LaunchUpdate } from "@/lib/wadd";
import type { BuildProgress, LaunchProgress } from "../backend";

/** What the Rust wadd builds from: the design, its wallpaper as drawn here, and its projects. */
export interface DesignRequest {
  design: WadspaceSpec;
  wallpaper: { fileName: string; data: string };
  projects: Project[];
}

export async function designRequest(ws: WadspaceSpec, projects?: Project[]): Promise<DesignRequest> {
  const wp = await renderWallpaper(ws.layout.wallpaper);
  return { design: ws, wallpaper: { fileName: wp.fileName, data: base64(new Uint8Array(await wp.blob.arrayBuffer())) }, projects: projects ?? [] };
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
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
    layer: u.layer ?? null,
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

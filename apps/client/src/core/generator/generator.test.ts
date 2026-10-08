import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { newSpec, toWaddSpec } from "../spec";
import { bundleFiles, compose, dockerfile, quadlet, readme, wadbrowserConf } from "./index";

const here = (p: string) => resolve(__dirname, p);
// The monorepo root (apps/client/src/core/generator → five up). Unit-file
// fixtures there are shared with wadd's tests, so the two renderers can't drift.
const REPO = here("../../../../..");
const fixture = (name: string) => readFileSync(`${REPO}/fixtures/quadlet/${name}`, "utf8");
// Hand-written workspaces from before the Builder (the old Wadspaces-David
// recipes), kept as what the generator must still reproduce.
const containers = `${REPO}/fixtures/presets`;

describe("quadlet", () => {
  it("matches wadd's renderer byte for byte", () => {
    const expected = fixture("wad-writing.container");
    const got = quadlet({
      id: "writing",
      name: "Writing",
      image: "ghcr.io/hunggod/wadspaces-writing:latest",
      port: 3100,
      hotkey: 1,
      env: { TZ: "Pacific/Fiji", PUID: "1000", PGID: "1000" },
      secrets: ["github_token"],
      volumes: ["wad-writing-obsidian:/config/.config/obsidian:z"],
      devices: ["/dev/dri"],
      shm_size: "1g",
    });
    expect(got).toBe(expected);
  });

  it("matches wadd for a native (display: host) workspace", () => {
    const expected = fixture("wad-writing-host.container");
    const got = quadlet({
      id: "writing",
      name: "Writing",
      image: "ghcr.io/hunggod/wadspaces-cosmic-bodybuilding:latest",
      display: "host",
      hotkey: 1,
      env: { TZ: "Pacific/Fiji", PUID: "1000", PGID: "1000" },
      secrets: ["github_token"],
      volumes: ["wad-writing-obsidian:/config/.config/obsidian:z"],
      devices: ["/dev/dri"],
      shm_size: "1g",
    });
    expect(got).toBe(expected);
  });

  it("matches wadd with projects mounted", () => {
    // Same inputs as wadd's tests (fixtures/quadlet/wad-writing-projects.container):
    // writing-host.yaml plus two projects.
    const expected = fixture("wad-writing-projects.container");
    const got = quadlet({
      id: "writing",
      name: "Writing",
      image: "ghcr.io/hunggod/wadspaces-cosmic-bodybuilding:latest",
      display: "host",
      hotkey: 1,
      env: { PUID: "1000", PGID: "1000", TZ: "Pacific/Fiji" },
      secrets: ["github_token"],
      volumes: ["wad-writing-obsidian:/config/.config/obsidian:z"],
      devices: ["/dev/dri"],
      shm_size: "1g",
      projects: [
        { id: "wrtvault0000000000ab", mount: "Writing" },
        { id: "notes000000000000000", mount: "Notes" },
      ],
    });
    expect(got).toBe(expected);
  });

  it("matches wadd with a folder project: its own path, no relabel, SELinux separation off", () => {
    // Same inputs as fixtures/quadlet/wad-writing-folder.container:
    // writing.yaml plus a GitHub project and a folder project.
    const expected = fixture("wad-writing-folder.container");
    const got = quadlet({
      id: "writing",
      name: "Writing",
      image: "ghcr.io/hunggod/wadspaces-writing:latest",
      port: 3100,
      hotkey: 1,
      env: { PUID: "1000", PGID: "1000", TZ: "Pacific/Fiji" },
      secrets: ["github_token"],
      volumes: ["wad-writing-obsidian:/config/.config/obsidian:z"],
      devices: ["/dev/dri"],
      shm_size: "1g",
      projects: [
        { id: "wrtvault0000000000ab", mount: "Writing" },
        { id: "notesfolder000000000", mount: "Notes", path: "/var/home/wad/Notes" },
      ],
    });
    expect(got).toBe(expected);
  });

  it("disables SELinux separation once, native or with a folder project", () => {
    const base = { id: "a", name: "A", image: "i", display: "host" as const };
    const got = quadlet({ ...base, projects: [{ id: "p", mount: "P", path: "/mnt/x" }] });
    expect(got.match(/SecurityLabelDisable=true/g)).toHaveLength(1);
    expect(
      got.indexOf("Volume=/run/user/1000:/run/wadspaces-display\nEnvironment=PULSE_SERVER=unix:/run/wadspaces-display/pulse/native\nSecurityLabelDisable=true\n"),
    ).toBeGreaterThan(got.indexOf("wadspaces-extra"));
    expect(quadlet({ id: "a", name: "A", image: "i", port: 3100, projects: [{ id: "p", mount: "P" }] })).not.toContain("SecurityLabelDisable");
  });

  it("takes the project and state directories like wadd's daemon config", () => {
    const got = quadlet({ id: "a", name: "A", image: "i", port: 3100, projects: [{ id: "wrtvault0000000000ab", mount: "Writing" }] }, "/srv/p", "/srv/s");
    expect(got).toContain("Volume=/srv/p/wrtvault0000000000ab:/config/Desktop/Writing:rw,z\n");
    expect(got).toContain("Volume=/srv/s/extra/a:/run/wadspaces-extra:ro,z\n");
    expect(quadlet({ id: "a", name: "A", image: "i", port: 3100, projects: [] })).not.toContain("wadspaces-extra");
  });

});

const kaleB = newSpec({
  id: "kale-b",
  name: "Kale Browser",
  display: "host",
  features: ["git", "python", "nodejs", "vscode", "claude-code"],
  projects: [{ id: "kaleb00000000000000a", name: "KaleBrowser", mount: "KaleBrowser" }],
  webapps: [
    { name: "Github", url: "https://github.com" },
    { name: "Claude", url: "https://claude.ai" },
    { name: "Open Router", url: "https://openrouter.ai/" },
  ],
  port: 3130,
});

describe("bundle matches the hand-written workspaces", () => {
  it("kale-b Dockerfile instructions", () => {
    const body = (s: string) => s.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(body(dockerfile(kaleB))).toEqual(body(readFileSync(`${containers}/kale-b/Dockerfile`, "utf8")));
  });

  it("wad-c web apps", () => {
    const wadc = newSpec({
      id: "wad-c",
      name: "Wad Creator",
      display: "stream",
      features: ["git", "nodejs", "firebase", "vscode", "claude-code", "chrome"],
      webapps: [
        { name: "Claude", url: "https://claude.ai" },
        { name: "GitHub", url: "https://github.com" },
        { name: "Google Cloud", url: "https://console.cloud.google.com" },
        { name: "OpenRouter", url: "https://openrouter.ai" },
      ],
    });
    const run = (s: string) => s.split("\n").filter((l) => /^(RUN|    wadspaces)/.test(l));
    expect(run(dockerfile(wadc))).toEqual(run(readFileSync(`${containers}/wad-c/Dockerfile`, "utf8")));
  });
});

describe("bundleFiles", () => {
  it("lists the expected files", () => {
    const paths = bundleFiles(kaleB).map((f) => f.path);
    expect(paths).toEqual([
      "Dockerfile",
      "docker-compose.yml",
      "README.md",
      "wad-kale-b.container",
      "workspaces.yaml.snippet",
    ]);
    expect(toWaddSpec(kaleB).volumes).toEqual(["wad-kale-b-config:/config:z"]);
  });

  it("puts web apps' icons and what links open in into the image", () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const spec = { ...kaleB, webapps: [{ id: "claude", name: "Claude", url: "https://claude.ai" }], defaultBrowser: "full" as const };
    const files = bundleFiles(spec, undefined, undefined, { claude: png, stranger: png });
    expect(files.map((f) => f.path).slice(5)).toEqual([
      "root/etc/wadspaces/wadbrowser.conf",
      "root/usr/share/icons/hicolor/512x512/apps/wadspaces-webapp-claude.png",
    ]);
    expect(wadbrowserConf(spec)).toContain("default = full\n");
    expect(wadbrowserConf(kaleB)).toBeNull();
  });

  it("names the default projects and leaves them out of the image", () => {
    expect(readme(kaleB)).toContain("| Default projects | KaleBrowser |");
    expect(readme(newSpec({ id: "x", name: "X" }))).toContain("| Default projects | none |");
    // wadd mounts them at launch: the unit in the folder has none.
    expect(bundleFiles(kaleB).find((f) => f.path === "wad-kale-b.container")!.content).not.toContain("/config/Desktop");
  });

  it("compose lists the projects as mounts to fill in by hand", () => {
    const project = "      # - /path/to/KaleBrowser:/config/Desktop/KaleBrowser:z  (project KaleBrowser)\n";
    // Native (lean) workspaces: after the desktop's runtime dir it draws on.
    expect(compose(kaleB)).toContain(`      - wad-kale-b-config:/config:z\n      - \${XDG_RUNTIME_DIR}:/run/wadspaces-display\n${project}`);
    expect(compose({ ...kaleB, persistConfig: false })).toContain(`    volumes:\n      - \${XDG_RUNTIME_DIR}:/run/wadspaces-display\n${project}`);
    // Streamed (Selkies) ones have no other volumes without a config volume.
    const stream = { ...kaleB, display: "stream" as const };
    expect(compose(stream)).toContain(`      - wad-kale-b-config:/config:z\n${project}`);
    expect(compose({ ...stream, persistConfig: false })).toContain(`    # volumes:\n${project}`);
  });
});

describe("display", () => {
  it("a native workspace builds on the lean base, has no port, and runs by hand as a window on the desktop", () => {
    const spec = newSpec({ id: "notes", name: "Notes", port: 3170 });
    expect(spec.display).toBe("host");
    expect(dockerfile(spec)).toContain("ARG BASE_IMAGE=localhost/wadspaces-base:trixie");
    const w = toWaddSpec(spec);
    expect(w.display).toBe("host");
    expect(w.port).toBeUndefined();
    const c = compose(spec);
    expect(c).not.toContain("wadspaces-stream");
    expect(c).toContain("- ${XDG_RUNTIME_DIR}:/run/wadspaces-display");
    expect(c).toContain("- WADSPACES_WAYLAND=${WAYLAND_DISPLAY:-wayland-0}");
    expect(c).not.toContain("127.0.0.1:3170");
  });

  it("a streamed workspace builds on the Selkies base and publishes its port", () => {
    const spec = newSpec({ id: "old", name: "Old", display: "stream", port: 3180 });
    expect(dockerfile(spec)).toContain("ARG BASE_IMAGE=localhost/wadspaces-selkies:trixie");
    expect(toWaddSpec(spec).port).toBe(3180);
    expect(compose(spec)).not.toContain("wadspaces-stream");
  });
});

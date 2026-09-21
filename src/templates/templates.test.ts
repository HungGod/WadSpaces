import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { newSpec, toWaddSpec } from "../lib/spec";
import { bundleFiles, dockerfile, kaleResourcesJson, quadlet, reposList } from "./index";

const here = (p: string) => resolve(__dirname, p);
const containers = here("../../../containers");

describe("quadlet", () => {
  it("matches wadd's renderer byte for byte", () => {
    // Same fixture as Workspace-Switcher/tests/fixtures/wad-writing.container
    const expected = readFileSync(here("__fixtures__/wad-writing.container"), "utf8");
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

  it("stays in sync with the switcher's copy of the fixture", () => {
    const upstream = here("../../../Workspace-Switcher/tests/fixtures/wad-writing.container");
    if (!existsSync(upstream)) return;
    expect(readFileSync(here("__fixtures__/wad-writing.container"), "utf8")).toBe(readFileSync(upstream, "utf8"));
  });
});

const kaleB = newSpec({
  id: "kale-b",
  name: "Kale Browser",
  features: ["git", "python", "nodejs", "vscode", "claude-code"],
  repos: [{ url: "https://github.com/HungGod/KaleBrowser.git", dest: "KaleBrowser", postClone: "npm install" }],
  kaleResources: [
    { app_name: "Github", app_url: "https://github.com" },
    { app_name: "Claude", app_url: "https://claude.ai" },
    { app_name: "Open Router", app_url: "https://openrouter.ai/" },
  ],
  port: 3130,
});

describe("bundle matches the hand-written workspaces", () => {
  it.runIf(existsSync(containers))("kale-b repos.list and resources", () => {
    expect(reposList(kaleB)).toBe(readFileSync(`${containers}/kale-b/root/etc/wadspaces/repos.list`, "utf8"));
    expect(kaleResourcesJson(kaleB)).toBe(
      readFileSync(`${containers}/kale-b/root/etc/wadspaces/kalebrowser-resources.json`, "utf8"),
    );
  });

  it.runIf(existsSync(containers))("kale-b Dockerfile instructions", () => {
    const body = (s: string) => s.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(body(dockerfile(kaleB))).toEqual(body(readFileSync(`${containers}/kale-b/Dockerfile`, "utf8")));
  });

  it.runIf(existsSync(containers))("wad-c web apps", () => {
    const wadc = newSpec({
      id: "wad-c",
      name: "Wad Creator",
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
      "root/etc/wadspaces/repos.list",
      "root/etc/wadspaces/kalebrowser-resources.json",
    ]);
    expect(toWaddSpec(kaleB).volumes).toEqual(["wad-kale-b-config:/config:z"]);
  });
});

import { PRESETS } from "../lib/presets";

describe("presets reproduce containers/", () => {
  for (const p of PRESETS) {
    const dir = p.id === "writing" ? "cosmic-bodybuilding" : p.id;
    it.runIf(existsSync(`${containers}/${dir}`))(`${p.id} repos.list`, () => {
      expect(reposList(p)).toBe(readFileSync(`${containers}/${dir}/root/etc/wadspaces/repos.list`, "utf8"));
    });
  }
});

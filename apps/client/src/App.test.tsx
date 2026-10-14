// @vitest-environment jsdom
// The WadSpaces Client as you use it: a library loads (one from before stacks
// moved to them), the sidebar's launcher launches wadspaces and WadBrowsers,
// and Home shows your wadspaces. Against the fake backend with the sample
// library (test/sample.ts): what's launched is what the fake records. (The
// Builder's board has tests of its own, in components/builder.)
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { setBackendForTests } from "./data";
import { useApp } from "./lib/store";
import { forgetWritesForTests, useBoard } from "./components/builder/store";
import { useUi } from "./lib/ui";
import type { FakeBackend } from "./test/fakeBackend";
import { GOOGLE, legacyBackend, sampleBackend } from "./test/sample";
import type { Wadspace } from "@core/layers";

beforeAll(() => {
  // jsdom has neither; the Builder measures its preview and scrolls panels into view.
  // Every element measures 320×180: thumbnails and the preview draw.
  globalThis.ResizeObserver ??= class {
    constructor(private cb: ResizeObserverCallback) {}
    observe() {
      this.cb([{ contentRect: { width: 320, height: 180 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.scrollTo ??= () => {};
});

let fake: FakeBackend;

beforeEach(() => {
  fake = sampleBackend();
  setBackendForTests(fake);
  useUi.setState({ detailsId: null, launcher: null });
  useApp.setState({ layersLoaded: false, toasts: [], builds: [], launches: [], templates: [], extensions: [], wadspaces: [], browsers: [], images: {}, signIns: [], projects: [] });
  // The board (and what it keeps on this machine) starts again too.
  localStorage.removeItem("wadspaces.builder");
  forgetWritesForTests();
  useBoard.setState({ stacks: [], loaded: false, unsaved: null, saveError: null, past: [], deleted: [] });
});

afterEach(cleanup);

const open = async (path = "/builder") => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  // Loaded: the sample's wadspaces are in the store.
  await waitFor(() => expect(useApp.getState().wadspaces.length).toBeGreaterThan(0));
};

describe("loading", () => {
  it("moves a library from before stacks to them, once", async () => {
    const legacy = legacyBackend();
    setBackendForTests(legacy);
    await open("/");
    const ws = useApp.getState().wadspaces;
    expect(ws.map((w) => [w.id, w.version, w.order])).toEqual([["cosmic-bodybuilding", 3, 1], ["vanua-academy", 3, 2]]);
    expect(useApp.getState().extensions.map((e) => e.id)).toEqual(["vanua-academy-dev"]);
    // Written behind: the Extensions moved, the old documents gone, the stacks saved.
    await waitFor(() => expect([...legacy.wadspaces.values()].every((w) => w.version === 3)).toBe(true));
    expect([...legacy.extensions.keys()]).toEqual(["vanua-academy-dev"]);
    expect(legacy.customizations.size).toBe(0);
  });
});

describe("the Builder's board", () => {
  const stackNames = () => [...document.querySelectorAll(".wb .stacks > .stack .stack-name")].map((e) => e.textContent);

  it("shows the stacks, and saves a new one made with Create", async () => {
    await open("/builder");
    await waitFor(() => expect(stackNames()).toEqual(["Cosmic Bodybuilding", "VanuaAcademy"]));
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(stackNames()).toEqual(["Cosmic Bodybuilding", "VanuaAcademy", "New template"]));
    // Written behind: a stack whose template has no apps yet.
    await waitFor(() => expect([...fake.wadspaces.values()].find((w) => w.version === 3 && w.draftTemplate)).toBeTruthy());
    const made = [...fake.wadspaces.values()].find((w) => w.version === 3 && w.draftTemplate);
    expect(made && made.version === 3 && [made.order, made.draftTemplate, made.template]).toEqual([3, { name: "New template", description: "" }, undefined]);
  });

  it("copies a stack beside it when asked to (a wadspace's Copy)", async () => {
    await open("/builder?stack=cosmic-bodybuilding&copy=1");
    await waitFor(() => expect(stackNames()).toEqual(["Cosmic Bodybuilding", "Cosmic Bodybuilding - 1", "VanuaAcademy"]));
    await waitFor(() => expect(fake.wadspaces.size).toBe(3));
    const copy = [...fake.wadspaces.values()].find((w) => w.version === 3 && w.customization?.name === "Cosmic Bodybuilding - 1");
    // The same template (shared, not copied), its own customization.
    expect(copy && copy.version === 3 && [copy.template, copy.order]).toEqual(["writing", 2]);
    expect(fake.templates.size).toBe(2);
  });
});

describe("Builds in the sidebar", () => {
  it("stops a running build and takes it off the list, for good", async () => {
    let cancelled = "";
    fake.cancelBuild = async (id: string) => void (cancelled = id);
    await open("/");
    act(() => useApp.getState().applyBuild({ id: "b1", wadspaceId: "", name: "Dev", progress: 0.4, from: 0, lines: [], status: "building", error: null, layer: "template:dev" } as never));
    fireEvent.click(await screen.findByRole("button", { name: "Stop Dev's build" }));
    expect(cancelled).toBe("b1");
    expect(useApp.getState().builds).toEqual([]);
    // Its cancelling reports in: it stays off.
    act(() => useApp.getState().applyBuild({ id: "b1", wadspaceId: "", name: "Dev", progress: 0.4, from: 0, lines: [], status: "error", error: "cancelled", layer: "template:dev" } as never));
    expect(useApp.getState().builds).toEqual([]);
  });
});

describe("Storage's report", () => {
  it("opens with everything that can go ticked, deleted in one go", async () => {
    const { SAMPLE_OTHER } = await import("./test/fakeBackend");
    fake.thisMachine = true;
    fake.sizes = { ...fake.sizes, other: SAMPLE_OTHER };
    await open("/machines");
    // Closed at first: just a line.
    expect(await screen.findByRole("button", { name: /Report/ })).toBeTruthy();
    expect(screen.queryByText("Everything else, part by part")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Report/ }));
    expect(await screen.findByText("Everything else, part by part")).toBeTruthy();
    expect(await screen.findByText(/7 picked/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Delete…/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Delete, freeing/ }));
    await waitFor(() => expect(fake.deleted).toHaveLength(1));
    expect(fake.deleted[0]).toEqual(expect.objectContaining({ images: ["aa11", "bb22", "cc33", "dd44"], volumes: ["wad-iq-dev-config", "wad-kale-p-config"], updateCopy: true }));
  });
});

describe("Files on the machine", () => {
  it("looks through what's saved, edits a text file and deletes a folder", async () => {
    fake.thisMachine = true;
    fake.fileTree = { "home/Downloads/notes.md": "# Notes\n", "home/Downloads/old.zip": "zip", "home/Documents/plan.txt": "Plan\n" };
    await open("/machines");
    fireEvent.click(await screen.findByRole("button", { name: /Files/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Downloads" }));
    expect(await screen.findByRole("button", { name: "notes.md" })).toBeTruthy();
    // Edited and saved.
    fireEvent.click(screen.getByRole("button", { name: "Edit notes.md" }));
    const text = (await screen.findByLabelText("The file's text")) as HTMLTextAreaElement;
    expect(text.value).toBe("# Notes\n");
    fireEvent.change(text, { target: { value: "# Notes\n\nDone.\n" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fake.fileTree["home/Downloads/notes.md"]).toBe("# Notes\n\nDone.\n"));
    // Back to the top: Documents deleted, for good.
    fireEvent.click(screen.getAllByRole("button", { name: "Your files" }).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Documents" }));
    fireEvent.click(await screen.findByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(Object.keys(fake.fileTree).some((p) => p.startsWith("home/Documents"))).toBe(false));
  });
});

describe("Recently deleted", () => {
  it("deletes a stack for good, with the template only it used", async () => {
    await open("/builder");
    await waitFor(() => expect(useBoard.getState().stacks).toHaveLength(2));
    const cosmic = useBoard.getState().stacks.find((s) => s.id === "cosmic-bodybuilding")!;
    act(() => useBoard.getState().deleteIds([cosmic.customization!.id, ...cosmic.templates.map((t) => t.id)]));
    // Soft-deleted: in Recently deleted, its document marked.
    await waitFor(() => expect((fake.wadspaces.get("cosmic-bodybuilding") as Wadspace).deletedAt).toBeTruthy());
    const ids = useBoard.getState().deleted.map((d) => d.id);
    expect(ids).toHaveLength(2);
    await act(() => useBoard.getState().deleteForever(ids));
    // For good: the wadspace, and Writing (no other stack has it); Dev stays.
    await waitFor(() => expect(fake.wadspaces.has("cosmic-bodybuilding")).toBe(false));
    expect(fake.templates.has("writing")).toBe(false);
    expect(fake.templates.has("dev")).toBe(true);
    expect(useBoard.getState().deleted).toEqual([]);
  });
});

describe("unsaved work on the board", () => {
  const stackNames = () => [...document.querySelectorAll(".wb .stacks > .stack .stack-name")].map((e) => e.textContent);
  const drafts = () => [...fake.wadspaces.values()].filter((w) => w.version === 3 && w.draftTemplate);

  it("keeps a stack the account refuses, and saves it on Retry", async () => {
    const save = fake.saveWadspace.bind(fake);
    fake.saveWadspace = async () => {
      throw new Error("Missing or insufficient permissions.");
    };
    await open("/builder");
    await waitFor(() => expect(stackNames()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    // Refused: still on the board, kept on this machine, and said so.
    const retry = await screen.findByRole("button", { name: /Not saved · Retry/ });
    expect(stackNames()).toEqual(["Cosmic Bodybuilding", "VanuaAcademy", "New template"]);
    expect(JSON.parse(localStorage.getItem("wadspaces.builder")!).state.unsaved).toHaveLength(3);
    expect(drafts()).toEqual([]);
    // The account takes it now.
    fake.saveWadspace = save;
    fireEvent.click(retry);
    await waitFor(() => expect(drafts()).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Not saved/ })).toBeNull());
    expect(JSON.parse(localStorage.getItem("wadspaces.builder")!).state.unsaved).toBeNull();
  });

  it("saves work a restart cut off when the app starts again, Builder open or not", async () => {
    // A save that never finished (no network, then the machine restarted).
    fake.saveWadspace = () => new Promise(() => {});
    await open("/builder");
    await waitFor(() => expect(stackNames()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem("wadspaces.builder")!).state.unsaved).toHaveLength(3));
    cleanup();

    // Started again: the account never got it; what this machine kept is written.
    const kept = localStorage.getItem("wadspaces.builder");
    fake = sampleBackend();
    setBackendForTests(fake);
    useApp.setState({ layersLoaded: false, templates: [], extensions: [], wadspaces: [] });
    useBoard.setState({ stacks: [], loaded: false, unsaved: null, past: [] });
    localStorage.setItem("wadspaces.builder", kept!);
    forgetWritesForTests();
    await useBoard.persist.rehydrate();
    await open("/");
    await waitFor(() => expect(drafts()).toHaveLength(1));
    expect(useApp.getState().wadspaces.some((w) => w.draftTemplate)).toBe(true);
  });
});

describe("the launcher", () => {
  const launcher = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Launch" }));
    return screen.findByRole("dialog");
  };
  /** A wadspace's card in the launcher (its picture's labels say its name too). */
  const space = (dialog: HTMLElement, name: string) =>
    within(dialog)
      .getAllByRole("button")
      .find((b) => b.hasAttribute("aria-pressed") && b.querySelector(".text-\\[13px\\]")?.textContent === name)!;
  const launch = async (dialog: HTMLElement) => act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /^Launch$/ })));

  it("launches wadspaces, WadBrowser and the terminal together, with no projects step", async () => {
    await open("/");
    const dialog = await launcher();
    expect(within(dialog).getByRole("heading", { name: "Wadspaces" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "On this machine" })).toBeTruthy();
    fireEvent.click(space(dialog, "Cosmic Bodybuilding"));
    fireEvent.click(within(dialog).getByRole("button", { name: "WadBrowser" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Terminal" }));
    // The terminal has nothing to customize.
    expect(within(dialog).queryByRole("button", { name: "Customize Terminal" })).toBeNull();
    await launch(dialog);
    expect(fake.launches[0].items.map((i) => i.kind)).toEqual(["wadspace", "browser", "terminal"]);
    expect(fake.launches[0].focusMinutes).toBeNull();
  });

  it("puts spaces first, then what runs on the machine", async () => {
    await open("/");
    const dialog = await launcher();
    fireEvent.click(within(dialog).getByRole("button", { name: "Terminal" }));
    fireEvent.click(space(dialog, "VanuaAcademy"));
    await launch(dialog);
    expect(fake.launches[0].items).toEqual([{ kind: "wadspace", wadspaceId: "vanua-academy" }, { kind: "terminal" }]);
  });

  it("runs two WadBrowsers set up differently at once", async () => {
    await open("/");
    const dialog = await launcher();
    fireEvent.click(within(dialog).getByRole("button", { name: "WadBrowser Focus" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "VanuaAcademy Mail" }));
    await launch(dialog);
    expect(fake.launches[0].items.map((i) => i.kind === "browser" && [i.config.name, i.config.mode, i.config.webapps.length, i.savedId ?? null])).toEqual([
      ["WadBrowser Focus", "focus", 0, null],
      ["VanuaAcademy Mail", "focus", 2, "vanua-academy-mail"],
    ]);
  });

  it("customizes a wadspace for a throwaway run, saving nothing", async () => {
    await open("/");
    const dialog = await launcher();
    fireEvent.click(within(dialog).getByRole("button", { name: "Customize Cosmic Bodybuilding" }));
    // Only its own options: background and keys (its projects are its own).
    expect(within(dialog).getByRole("heading", { name: "Background" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Keys" })).toBeTruthy();
    expect(within(dialog).queryByRole("heading", { name: "Folders" })).toBeNull();
    expect(within(dialog).queryByText("Open at boot")).toBeNull();
    fireEvent.click(within(dialog).getByTitle("Midnight"));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Throwaway run/ })));
    // Back in the list, picked, as a run of its own.
    expect(within(dialog).getByText("Cosmic Bodybuilding (run)")).toBeTruthy();
    await launch(dialog);
    const item = fake.launches[0].items[0];
    expect(item.kind === "wadspace" && item.overrides?.wallpaper.value).toContain("linear-gradient");
    expect(fake.wadspaces.size).toBe(2);
  });

  it("saves a customized wadspace as a new one, under a name of its own", async () => {
    await open("/");
    const dialog = await launcher();
    fireEvent.click(within(dialog).getByRole("button", { name: "Customize Cosmic Bodybuilding" }));
    const save = () => within(dialog).getByRole("button", { name: /Save as new wadspace/ }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("New wadspace name"), { target: { value: "Cosmic Bodybuilding" } });
    expect(save().disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("New wadspace name"), { target: { value: "Cosmic Sequel" } });
    await act(async () => fireEvent.click(save()));
    const sequel = [...fake.wadspaces.values()].find((w) => w.version === 3 && w.customization?.name === "Cosmic Sequel");
    // A copy of its stack, at the board's end.
    expect(sequel && sequel.version === 3 && [sequel.template, sequel.order]).toEqual(["writing", 3]);
    expect(within(dialog).getByText("Cosmic Sequel")).toBeTruthy();
  });

  it("sets up a WadBrowser with web apps sharing a sign-in, and saves it to launch later", async () => {
    await open("/");
    const dialog = await launcher();
    fireEvent.click(within(dialog).getByRole("button", { name: "Customize WadBrowser" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add GitHub" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Google Cloud" }));
    // Google Cloud uses the saved Google sign-in; GitHub gets a new one.
    fireEvent.click(within(within(dialog).getByText("Google Cloud", { selector: ".truncate.text-sm.font-medium" }).closest(".rounded-2xl")! as HTMLElement).getByRole("button", { name: "Existing" }));
    const pick = within(dialog).getByLabelText("Existing secret for Google Cloud") as HTMLSelectElement;
    fireEvent.change(pick, { target: { value: [...pick.options].find((o) => o.textContent === GOOGLE)!.value } });
    fireEvent.change(within(dialog).getByLabelText("Setup name"), { target: { value: "Cloud work" } });
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Save setup/ })));
    const saved = [...fake.browsers.values()].find((b) => b.name === "Cloud work")!;
    expect(saved.webapps.map((w) => w.name)).toEqual(["GitHub", "Google Cloud"]);
    const made = fake.signIns.find((s) => s.name === "Cloudwork-WadBrowser-GitHub")!;
    expect(made.app).toBe("web");
    expect(saved.secrets).toEqual({ "web:github": { id: made.id, name: "Cloudwork-WadBrowser-GitHub", kind: "web" }, "web:google-cloud": { id: "s-google", name: GOOGLE, kind: "web" } });
    expect(within(dialog).getByRole("button", { name: "Cloud work" })).toBeTruthy();
  });

  it("runs a wadspace without saving any sign-in", async () => {
    await open("/");
    const dialog = await launcher();
    fireEvent.click(within(dialog).getByRole("button", { name: "Customize Cosmic Bodybuilding" }));
    const before = fake.signIns.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Don't save" }));
    expect(within(dialog).getByText(/nothing is saved on the machine/)).toBeTruthy();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Throwaway run/ })));
    expect(fake.signIns.length).toBe(before);
    await launch(dialog);
    const item = fake.launches[0].items[0];
    expect(item.kind === "wadspace" && item.overrides?.bySlot).toEqual({});
  });

  it("names an unnamed WadBrowser setup's new sign-ins WadSpaces-WadBrowser.<app>, and can save none", async () => {
    await open("/");
    const dialog = await launcher();
    fireEvent.click(within(dialog).getByRole("button", { name: "Customize WadBrowser" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add GitHub" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add Gmail" }));
    expect((within(dialog).getByLabelText("New secret for GitHub") as HTMLInputElement).placeholder).toBe("WadSpaces-WadBrowser.GitHub");
    // Named, they follow the name.
    fireEvent.change(within(dialog).getByLabelText("Setup name"), { target: { value: "Work" } });
    expect((within(dialog).getByLabelText("New secret for GitHub") as HTMLInputElement).placeholder).toBe("Work-WadBrowser-GitHub");
    fireEvent.change(within(dialog).getByLabelText("Setup name"), { target: { value: "" } });
    const before = fake.signIns.length;
    fireEvent.click(within(dialog).getByRole("button", { name: "Don't save any" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Throwaway run/ })));
    expect(fake.signIns.length).toBe(before);
    await launch(dialog);
    const item = fake.launches[0].items[0];
    expect(item.kind === "browser" && [item.config.webapps.length, item.config.secrets]).toEqual([2, {}]);
  });

  it("launches in focus mode after picking how long", async () => {
    await open("/");
    const dialog = await launcher();
    fireEvent.click(space(dialog, "VanuaAcademy"));
    fireEvent.click(within(dialog).getByRole("button", { name: /Focus mode/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "25 min" }));
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: /Start focus for 25 min/ })));
    expect(fake.launches[0]).toEqual({ items: [{ kind: "wadspace", wadspaceId: "vanua-academy" }], focusMinutes: 25 });
  });

  it("opens straight into customizing a wadspace for a run from its details", async () => {
    await open("/");
    act(() => useUi.getState().openDetails("vanua-academy"));
    fireEvent.click(await screen.findByRole("button", { name: /Customize for a run/ }));
    expect(await screen.findByText("Customize VanuaAcademy")).toBeTruthy();
  });
});

describe("Home", () => {
  it("shows your wadspaces, which open on the Builder's board", async () => {
    await open("/");
    expect(await screen.findByRole("heading", { name: "Your wadspaces" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open VanuaAcademy in the Builder" }));
    // The board, its stacks in order.
    await waitFor(() => expect([...document.querySelectorAll(".wb .stack .stack-name")].map((e) => e.textContent)).toEqual(["Cosmic Bodybuilding", "VanuaAcademy"]));
  });
});

describe("Secrets", () => {
  it("renames a sign-in, and the name the wadspaces using it keep", async () => {
    await open("/secrets");
    await act(() => useApp.getState().renameSignIn("s-github", "GitHub (me)"));
    expect(fake.signIns.find((s) => s.id === "s-github")?.name).toBe("GitHub (me)");
    const keys = (await fake.listWadspaces()).flatMap((w) => (w.version === 3 ? (w.customization?.secrets.groups ?? []).flatMap((g) => (g.key ? [g.key] : [])) : []));
    expect(keys.filter((k) => k.id === "s-github").map((k) => k.name)).toEqual(["GitHub (me)"]);
  });
});

describe("Machines", () => {
  it("lists this machine's wadspaces, built or not, and what they take on its disk", async () => {
    fake.thisMachine = true;
    fake.installed.set("cosmic-bodybuilding", fake.wadspaces.get("cosmic-bodybuilding") as Wadspace);
    fake.running.add("cosmic-bodybuilding");
    fake.sizes = { ...fake.sizes, layers: { "template:writing": 1.6e9 }, homes: { "cosmic-bodybuilding": 9e8 } };
    await open("/machines");
    // The storage tree: the base, the templates, the wadspaces.
    expect(await screen.findByText(/WadSpaces uses/)).toBeTruthy();
    expect(screen.getByText("WadSpaces base")).toBeTruthy();
    expect(screen.getAllByText("Cosmic Bodybuilding").length).toBeGreaterThan(0);
    // VanuaAcademy isn't built here: listed, to build.
    expect(screen.getByText(/1 running · 1 installed · 1 not built here/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Build here/ })).toBeTruthy();
  });
});

describe("Machines' storage", () => {
  it("deletes just what's picked, once what runs on it is picked too", async () => {
    fake.thisMachine = true;
    fake.installed.set("cosmic-bodybuilding", fake.wadspaces.get("cosmic-bodybuilding") as Wadspace);
    await open("/machines");
    const node = async (name: string) => (await screen.findAllByRole("button", { pressed: false })).find((b) => b.textContent?.includes(name))!;
    fireEvent.click(await node("Writing"));
    // Cosmic is installed on Writing's image: it has to go too.
    expect(await screen.findByText(/Cosmic Bodybuilding runs on a picked image/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Delete…/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Pick it too" }));
    fireEvent.click(screen.getByRole("button", { name: /Delete…/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Delete, freeing/ }));
    await waitFor(() => expect(fake.deleted).toEqual([{ layers: ["template:writing"], wadspaces: ["cosmic-bodybuilding"], images: [], volumes: [], updateCopy: false }]));
    // Dev and its Extensions stay.
    expect(fake.images.has("template:dev")).toBe(true);
  });
});

describe("Secrets", () => {
  it("shows each key with the apps it signs in and the wadspaces it's in", async () => {
    await open("/secrets");
    const card = (await screen.findByText("team@example.com-WadBrowser-Google")).closest("div.rounded-2xl") as HTMLElement;
    // Signing in three apps: a folder of their icons.
    expect(card.querySelectorAll("span.grid-cols-2 img").length).toBe(3);
    // Used in: VanuaAcademy, and the VanuaAcademy Mail setup (one row each).
    const used = [...card.querySelectorAll("[title]")].map((e) => e.getAttribute("title")).filter((t) => t?.includes(": "));
    expect(used).toEqual(["VanuaAcademy: Gmail, Google Drive, Google Workspace", "VanuaAcademy Mail: Gmail, Google Drive"]);
  });
});

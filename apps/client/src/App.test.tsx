// @vitest-environment jsdom
// The WadSpaces Client as you use it: Step 1 lists template stacks, Step 2
// customizes a template and saves it as a customization, Step 3 constructs a
// wadspace with secrets, and the sidebar's launcher launches them. Against
// the fake backend with the sample library (test/sample.ts): what's launched
// is what the fake records.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { useDraft } from "./components/wadbuilder/draft";
import { setBackendForTests } from "./data";
import { useApp } from "./lib/store";
import { useUi } from "./lib/ui";
import type { FakeBackend } from "./test/fakeBackend";
import { CLAUDE_CODE, GOOGLE, sampleBackend } from "./test/sample";

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
});

let fake: FakeBackend;

beforeEach(() => {
  fake = sampleBackend();
  setBackendForTests(fake);
  useDraft.getState().reset();
  useDraft.getState().pick(null);
  useUi.setState({ detailsId: null, launcher: null });
  useApp.setState({ toasts: [], builds: [], launches: [], templates: [], customizations: [], wadspaces: [], browsers: [], images: {}, signIns: [], projects: [] });
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

const startFrom = async (template: string) => fireEvent.click(await screen.findByRole("button", { name: `Start from ${template}` }));

describe("the Builder", () => {
  it("opens on Step 1 with one stack per template", async () => {
    await open();
    expect(await screen.findByRole("heading", { name: "Choose your template" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Templates" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start from Writing" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start from Dev" })).toBeTruthy();
    expect(screen.getByText("Build your own template")).toBeTruthy();
    // No separate wadspace or customization sections: they're in the stacks.
    expect(screen.queryByRole("heading", { name: "Your wadspaces" })).toBeNull();
    expect(screen.getByText(/1 customization · 1 wadspace/)).toBeTruthy();
  });

  it("pictures each layer's desktop: VS Code with extensions gets a +", async () => {
    await open();
    await screen.findByRole("button", { name: "Start from Dev" });
    // VanuaAcademy Dev and the wadspace on it add Claude Code to VS Code.
    expect(screen.getAllByTitle("1 added").length).toBeGreaterThan(0);
  });

  it("picks a starting point in a stack: the template, its customization, or a wadspace", async () => {
    await open();
    await startFrom("Dev");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("VanuaAcademy Dev")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Open VanuaAcademy" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Edit VanuaAcademy" })).toBeTruthy();
    expect(within(dialog).getAllByRole("button", { name: "Start here" })).toHaveLength(2);
  });

  it("opens (launches) a wadspace straight from its stack", async () => {
    await open();
    await startFrom("Dev");
    await act(async () => fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Open VanuaAcademy" })));
    expect(fake.launches).toEqual([{ items: [{ kind: "wadspace", wadspaceId: "vanua-academy" }], focusMinutes: null }]);
  });

  it("edits a saved wadspace from Step 2, then constructs it with its secrets", async () => {
    await open();
    await startFrom("Dev");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Edit VanuaAcademy" }));
    expect(useDraft.getState().step).toBe("customize");
    expect(screen.getByText("VanuaAcademy Dev", { selector: "div" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Next: construct/ }));
    expect((screen.getByPlaceholderText("e.g. VanuaAcademy") as HTMLInputElement).value).toBe("VanuaAcademy");
    const firebase = screen.getByLabelText("Existing secret for Google FireBase (web app)") as HTMLSelectElement;
    expect(firebase.selectedOptions[0].textContent).toBe(GOOGLE);
    // Only WadBrowser sign-ins are offered to a web app.
    expect([...firebase.options].map((o) => o.textContent)).not.toContain(CLAUDE_CODE);
    expect(screen.getAllByText(/Shared with/).length).toBeGreaterThan(0);
  });

  it("starts a new wadspace from a saved one, without its name", async () => {
    await open();
    await startFrom("Writing");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: /New from it/ }));
    const w = useDraft.getState().wadspace;
    expect(w).toMatchObject({ id: undefined, name: "", projects: ["writing"] });
    expect(w.wallpaper.value).toBe("/wallpapers/cosmic-bodybuilding.png");
  });

  it("needs a new name for changes to a template, and builds what's saved", async () => {
    await open();
    await startFrom("Dev");
    fireEvent.click(within(await screen.findByRole("dialog")).getAllByRole("button", { name: "Start here" })[0]);
    fireEvent.change(screen.getByLabelText("Web app name"), { target: { value: "GitHub" } });
    fireEvent.change(screen.getByLabelText("Web app address"), { target: { value: "github.com" } });
    fireEvent.click(within(screen.getByLabelText("Web app name").closest("form")!).getByRole("button", { name: /Add/ }));
    expect(screen.getByText("https://github.com")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Next: construct/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/differs from the Dev template/)).toBeTruthy();
    // A name in use won't do.
    fireEvent.change(screen.getByLabelText("Customization name"), { target: { value: "VanuaAcademy Dev" } });
    fireEvent.click(screen.getByRole("button", { name: /Save new/ }));
    expect(screen.getByText(/is taken/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Customization name"), { target: { value: "My Dev" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Save new/ })));
    expect([...fake.customizations.values()].map((c) => c.name)).toContain("My Dev");
    // Saving builds its image.
    expect(fake.builds).toEqual(["custom:my-dev"]);
    fireEvent.click(screen.getByRole("button", { name: /Next: construct/ }));
    expect(screen.getByText("GitHub (web app)")).toBeTruthy();
  });

  it("imports another customization's setup as a starting point", async () => {
    await open();
    await startFrom("Writing");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start here" }));
    fireEvent.click(screen.getByRole("button", { name: /Import/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByText("VanuaAcademy Dev"));
    // Writing has no WadBrowser or VS Code: only the tools come across.
    expect((within(dialog).getByLabelText("Web apps") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: /^Import$/ }));
    expect(useDraft.getState().setup?.tools).toEqual(["firebase"]);
  });

  it("shows what an app is, with screenshots and its licence, from the template maker", async () => {
    await open();
    fireEvent.click(await screen.findByText("Build your own template"));
    fireEvent.click(screen.getByRole("button", { name: "About Krita" }));
    expect(await screen.findByRole("heading", { name: "Krita" })).toBeTruthy();
    expect(screen.getByText("How it gets into the image")).toBeTruthy();
    expect(screen.getByText("GPL-3.0-only")).toBeTruthy();
    expect(screen.getByText("RUN wadspaces-feature krita")).toBeTruthy();
  });

  it("constructs a new wadspace, making its new sign-ins and saving refs to them", async () => {
    await open();
    await startFrom("Writing");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Start here" }));
    fireEvent.click(screen.getByRole("button", { name: /Next: construct/ }));
    fireEvent.change(screen.getByPlaceholderText("e.g. VanuaAcademy"), { target: { value: "Night Notes" } });
    expect((screen.getByLabelText("New secret for Obsidian") as HTMLInputElement).placeholder).toBe("NightNotes-Obsidian");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Save new wadspace/ })));
    const saved = fake.wadspaces.get("night-notes")!;
    expect(saved.base).toEqual({ kind: "template", id: "writing" });
    const made = fake.signIns.find((s) => s.name === "NightNotes-Obsidian")!;
    expect(made.app).toBe("obsidian");
    expect(saved.secrets).toEqual({ "app:obsidian": { id: made.id, name: "NightNotes-Obsidian", kind: "obsidian" } });
    // Back on Step 1.
    expect(useDraft.getState().step).toBe("template");
  });

  it("deletes softly, restores from Recently deleted, and refuses to delete what's built on", async () => {
    await open();
    await act(async () => useApp.getState().remove("wadspace", "cosmic-bodybuilding"));
    expect(fake.wadspaces.get("cosmic-bodybuilding")?.deletedAt).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /Recently deleted \(1\)/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /Restore/ })));
    expect(fake.wadspaces.get("cosmic-bodybuilding")?.deletedAt).toBeUndefined();
    // Dev has VanuaAcademy Dev on it.
    await expect(useApp.getState().remove("template", "dev")).rejects.toThrow(/VanuaAcademy Dev/);
    // For good, once nothing's on it.
    await act(async () => useApp.getState().remove("wadspace", "cosmic-bodybuilding"));
    await act(async () => useApp.getState().remove("template", "writing"));
    await expect(useApp.getState().purge("template", "writing")).rejects.toThrow(/Cosmic Bodybuilding \(recently deleted\)/);
    await act(async () => useApp.getState().purge("wadspace", "cosmic-bodybuilding"));
    await act(async () => useApp.getState().purge("template", "writing"));
    expect(fake.templates.has("writing")).toBe(false);
    expect(fake.images.has("template:writing")).toBe(false);
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
    // Only construction options: background, folders, secrets.
    expect(within(dialog).getByRole("heading", { name: "Background" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Folders" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Secrets" })).toBeTruthy();
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
    expect([...fake.wadspaces.values()].map((w) => w.name)).toContain("Cosmic Sequel");
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
    expect(item.kind === "wadspace" && item.overrides?.secrets).toEqual({});
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
  it("shows your templates, which open their picker in the Builder", async () => {
    await open("/");
    expect(await screen.findByRole("heading", { name: "Your templates" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start from Dev" }));
    expect(await screen.findByRole("heading", { name: "Choose your template" })).toBeTruthy();
    expect(within(await screen.findByRole("dialog")).getByText("VanuaAcademy Dev")).toBeTruthy();
  });
});

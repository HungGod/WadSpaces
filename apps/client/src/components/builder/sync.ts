// The board and the documents behind it.
//
// The board (model.ts) is stacks of modules, copied freely between stacks.
// The documents (core/layers.ts) are templates (one builds on another by its
// `parent`), Extensions layers (each made on a template) and wadspaces (one
// per stack, its customization kept in it). Two pure halves:
//
//   toBoard  the documents as stacks: a stack per wadspace, in board order,
//            its template chain, Extensions and customization as modules.
//            A module that's a document says so (`ref`).
//   plan     the writes that make the documents what the board shows, and
//            the documents as they'll be. Templates and Extensions are shared
//            by what makes their image: a module reuses its document while
//            that still is what the module is; else one just like it
//            (the same apps on the same template below; the same setups on
//            the same template), else it changes its own document when no
//            other stack has it, else a new document is made for it (so
//            a shared template or Extensions layer changed in one stack is
//            copied, not changed under the others). Wadspaces are written
//            when they differ; a stack that's gone is deleted softly.
import type { Extensions, Setup, StackCustomization, Template, Wadspace } from "@core/layers";
import { freeId } from "@/lib/store";
import { BLANK_WALLPAPER, subOf, type AppSub, type CustomSub, type CustomizationModule, type ExtensionsModule, type Stack, type TemplateModule } from "./model";

export interface Docs {
  templates: Template[];
  extensions: Extensions[];
  wadspaces: Wadspace[];
}

const alive = <T extends { deletedAt?: string | null }>(xs: T[]) => xs.filter((x) => !x.deletedAt);

// ------------------------------------------------------------ documents → board

/** A template document as a module in a stack. */
const templateModule = (t: Template, stackId: string): TemplateModule => ({
  layer: "template",
  id: `${t.id}@${stackId}`,
  ref: t.id,
  name: t.name,
  description: t.description,
  apps: [...t.apps],
});

/** An Extensions document's setups as submodules. */
function appSubs(e: Omit<Setup, "templateId">, origin: string, idBase: string): AppSub[] {
  const subs: AppSub[] = [];
  if (e.webapps.length || e.browserMode === "focus") subs.push({ key: "wadbrowser", id: `${idBase}:wadbrowser`, origin, mode: e.browserMode, webapps: e.webapps.map((w) => ({ ...w })) });
  if (e.extensions.length) subs.push({ key: "vscode", id: `${idBase}:vscode`, origin, extensions: [...e.extensions] });
  if (e.tools.length) subs.push({ key: "tools", id: `${idBase}:tools`, origin, tools: [...e.tools] });
  return subs;
}

const extensionsModule = (e: { name: string } & Omit<Setup, "templateId">, stackId: string, ref?: string): ExtensionsModule => ({
  layer: "extensions",
  id: `${ref ?? "draft-extensions"}@${stackId}`,
  ...(ref && { ref }),
  name: e.name,
  subs: appSubs(e, e.name, `${ref ?? "draft"}@${stackId}`),
  autostart: [...e.autostart],
});

function customizationModule(c: StackCustomization, stackId: string): CustomizationModule {
  const id = `customization@${stackId}`;
  const subs: CustomSub[] = [
    { key: "look", id: `${id}:look`, origin: c.name, name: c.name, description: c.description, wallpaper: c.wallpaper },
    { key: "folders", id: `${id}:folders`, origin: c.name, mounts: c.projects.map((p) => ({ ...p })) },
    { key: "secrets", id: `${id}:secrets`, origin: c.name, bySlot: { ...c.secrets.bySlot }, ...(c.secrets.groups && { groups: c.secrets.groups.map((g) => ({ ...g, members: [...g.members] })) }) },
  ];
  return { layer: "customization", id, subs };
}

/** The template documents a template builds on, bottom first (itself last). */
function chain(templates: Template[], id: string | undefined): Template[] {
  const out: Template[] = [];
  for (let t = templates.find((x) => x.id === id); t && out.length < 9 && !out.includes(t); t = templates.find((x) => x.id === t!.parent)) out.unshift(t);
  return out;
}

/** The documents as the board shows them: a stack per wadspace (not deleted ones), in order. */
export function toBoard(docs: Docs): Stack[] {
  return alive(docs.wadspaces)
    .sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt))
    .map((w) => {
      const templates = chain(docs.templates, w.template).map((t) => templateModule(t, w.id));
      if (w.draftTemplate) templates.push({ layer: "template", id: `draft-template@${w.id}`, name: w.draftTemplate.name, description: w.draftTemplate.description, apps: [] });
      const e = w.extensions ? docs.extensions.find((x) => x.id === w.extensions) : undefined;
      const stack: Stack = { id: w.id, templates };
      if (e) stack.extensions = extensionsModule(e, w.id, e.id);
      else if (w.draftExtensions) stack.extensions = extensionsModule(w.draftExtensions, w.id);
      if (w.customization) stack.customization = customizationModule(w.customization, w.id);
      return stack;
    });
}

// ------------------------------------------------------------ board → documents

/** An Extensions module's setups as a document has them. */
export function setupOfModule(m: ExtensionsModule): Omit<Setup, "templateId"> {
  const browser = subOf(m, "wadbrowser");
  return {
    browserMode: browser?.mode ?? "browser",
    webapps: (browser?.webapps ?? []).map((w) => ({ id: w.id, name: w.name, url: w.url })),
    extensions: [...(subOf(m, "vscode")?.extensions ?? [])],
    tools: [...(subOf(m, "tools")?.tools ?? [])],
    autostart: [...(m.autostart ?? [])],
  };
}

/** A customization module as the wadspace keeps it. */
export function customizationOf(m: CustomizationModule): StackCustomization {
  const look = subOf(m, "look");
  const keys = subOf(m, "secrets");
  return {
    name: look?.name ?? "",
    description: look?.description ?? "",
    wallpaper: look?.wallpaper ?? BLANK_WALLPAPER,
    projects: (subOf(m, "folders")?.mounts ?? []).map((p) => ({ ...p })),
    secrets: { bySlot: { ...(keys?.bySlot ?? {}) }, ...(keys?.groups && { groups: keys.groups }) },
  };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
/** JSON with each object's keys sorted, so stored documents compare by what's in them. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(canonical) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)])) : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const setupKey = (s: Omit<Setup, "templateId">) => JSON.stringify([s.browserMode, s.webapps, s.extensions, s.tools, s.autostart]);

export interface Plan {
  templates: Template[];
  extensions: Extensions[];
  wadspaces: Wadspace[];
  /** Wadspaces (stacks) gone from the board: deleted softly. */
  deleted: string[];
  /** Each module's document, by module id: the board takes these as their `ref`s. */
  refs: Record<string, string>;
  /** The documents once written. */
  docs: Docs;
}

/** What to write so the documents are what `stacks` shows. `owner` and `now` stamp new and changed ones. */
export function plan(stacks: Stack[], docs: Docs, owner: string, now: string): Plan {
  const templates = new Map(docs.templates.map((t) => [t.id, t]));
  const extensions = new Map(docs.extensions.map((e) => [e.id, e]));
  const out: Plan = { templates: [], extensions: [], wadspaces: [], deleted: [], refs: {}, docs };
  const putT = (t: Template) => {
    templates.set(t.id, t);
    out.templates = [...out.templates.filter((x) => x.id !== t.id), t];
  };
  const putE = (e: Extensions) => {
    extensions.set(e.id, e);
    out.extensions = [...out.extensions.filter((x) => x.id !== e.id), e];
  };
  // How many stacks (but `stackId`) have a module that's this document.
  const othersWith = (ref: string, stackId: string, layer: "template" | "extensions") =>
    stacks.filter((s) => s.id !== stackId && (layer === "template" ? s.templates.some((t) => t.ref === ref) : s.extensions?.ref === ref)).length;
  // A new document's id, from its name.
  const fresh = <T extends { id: string }>(name: string, taken: Map<string, T>) => freeId(name || "layer", [...taken.values()]);

  stacks.forEach((s, i) => {
    // The template chain, bottom up; a blank one on top waits as a draft.
    let parent: string | undefined;
    let draftTemplate: Wadspace["draftTemplate"];
    const solid = s.templates.filter((t) => t.apps.length);
    const top = s.templates[s.templates.length - 1];
    if (top && !top.apps.length) draftTemplate = { name: top.name, description: top.description };
    for (const m of solid) {
      const want = { name: m.name, description: m.description, apps: [...m.apps], ...(parent && { parent }) };
      const cur = m.ref ? templates.get(m.ref) : undefined;
      const isIt = (t: Template) => !t.deletedAt && sameSet(t.apps, m.apps) && (t.parent ?? undefined) === parent;
      let id: string;
      if (cur && isIt(cur)) {
        id = cur.id;
        if (cur.name !== m.name || cur.description !== m.description || !same(cur.apps, m.apps)) putT({ ...cur, ...want, updatedAt: now });
      } else {
        const twin = [...templates.values()].find(isIt);
        if (twin) {
          id = twin.id;
          if (twin.name !== m.name || twin.description !== m.description) putT({ ...twin, name: m.name, description: m.description, updatedAt: now });
        } else if (cur && !cur.deletedAt && !othersWith(cur.id, s.id, "template")) {
          id = cur.id;
          const { parent: _p, ...rest } = cur;
          putT({ ...rest, ...want, updatedAt: now });
        } else {
          id = fresh(m.name, templates);
          putT({ id, owner, ...want, createdAt: now, updatedAt: now });
        }
      }
      out.refs[m.id] = id;
      parent = id;
    }

    // Its Extensions, made on the top template; with no template yet, kept in the stack.
    let extId: string | undefined;
    let draftExtensions: Wadspace["draftExtensions"];
    const em = s.extensions;
    if (em) {
      const setup = setupOfModule(em);
      if (!parent) draftExtensions = { name: em.name, ...setup };
      else {
        const isIt = (e: Extensions) => !e.deletedAt && e.templateId === parent && setupKey(e) === setupKey(setup);
        const cur = em.ref ? extensions.get(em.ref) : undefined;
        if (cur && isIt(cur)) {
          extId = cur.id;
          if (cur.name !== em.name) putE({ ...cur, name: em.name, updatedAt: now });
        } else {
          const twin = [...extensions.values()].find(isIt);
          if (twin) {
            extId = twin.id;
            if (twin.name !== em.name) putE({ ...twin, name: em.name, updatedAt: now });
          } else if (cur && !cur.deletedAt && !othersWith(cur.id, s.id, "extensions")) {
            extId = cur.id;
            putE({ ...cur, name: em.name, templateId: parent, ...setup, updatedAt: now });
          } else {
            extId = fresh(em.name, extensions);
            putE({ id: extId, owner, name: em.name, description: "", templateId: parent, ...setup, createdAt: now, updatedAt: now });
          }
        }
        out.refs[em.id] = extId;
      }
    }

    // The wadspace: the stack itself.
    const was = docs.wadspaces.find((w) => w.id === s.id);
    const next: Wadspace = {
      version: 3,
      id: s.id,
      owner: was?.owner ?? owner,
      ...(was?.sharedWith && { sharedWith: was.sharedWith }),
      order: i + 1,
      ...(parent && { template: parent }),
      ...(draftTemplate && { draftTemplate }),
      ...(extId && { extensions: extId }),
      ...(draftExtensions && { draftExtensions }),
      ...(s.customization && { customization: customizationOf(s.customization) }),
      createdAt: was?.createdAt ?? now,
      updatedAt: was?.updatedAt ?? now,
    };
    const { updatedAt: _a, ...a } = next;
    const { updatedAt: _b, deletedAt: _d, ...b } = was ?? ({} as Wadspace);
    if (!was || was.deletedAt || !same(a, b)) out.wadspaces.push({ ...next, updatedAt: now });
  });

  const onBoard = new Set(stacks.map((s) => s.id));
  out.deleted = alive(docs.wadspaces)
    .filter((w) => !onBoard.has(w.id))
    .map((w) => w.id);
  const wadspaces = new Map(docs.wadspaces.map((w) => [w.id, w]));
  for (const w of out.wadspaces) wadspaces.set(w.id, w);
  for (const id of out.deleted) wadspaces.set(id, { ...wadspaces.get(id)!, deletedAt: now });
  out.docs = { templates: [...templates.values()], extensions: [...extensions.values()], wadspaces: [...wadspaces.values()] };
  return out;
}

/** Whether a plan writes anything. */
export const writes = (p: Plan) => p.templates.length + p.extensions.length + p.wadspaces.length + p.deleted.length > 0;

/** The stacks with each module's document noted. */
export function withRefs(stacks: Stack[], refs: Record<string, string>): Stack[] {
  return stacks.map((s) => ({
    ...s,
    templates: s.templates.map((t) => (refs[t.id] && t.ref !== refs[t.id] ? { ...t, ref: refs[t.id] } : t)),
    ...(s.extensions && { extensions: refs[s.extensions.id] && s.extensions.ref !== refs[s.extensions.id] ? { ...s.extensions, ref: refs[s.extensions.id] } : s.extensions }),
  }));
}

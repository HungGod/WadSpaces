// WadBuilder: the Builder and the library in one, in three steps.
//
//   1. Choose your template   (and open what you've made)
//   2. Template customization (saved as a customization: its own image)
//   3. WadSpaces construction (name, background, projects, secrets)
import { useState } from "react";
import { ArrowLeft, ArrowRight, Check, Loader2, Save } from "lucide-react";
import clsx from "clsx";
import { resolve } from "@core/layers";
import { useApp } from "@/lib/store";
import { Button, Input } from "@/components/ui";
import { useDraft, type Step } from "@/components/wadbuilder/draft";
import { Preview } from "@/components/wadbuilder/Preview";
import { StepConstruct, useConstructSave } from "@/components/wadbuilder/StepConstruct";
import { StepCustomize, useCustomizeSave } from "@/components/wadbuilder/StepCustomize";
import { StepTemplate } from "@/components/wadbuilder/StepTemplate";

const STEPS: { value: Step; label: string }[] = [
  { value: "template", label: "Choose your template" },
  { value: "customize", label: "Template customization" },
  { value: "construct", label: "WadSpaces construction" },
];

export default function Builder() {
  const step = useDraft((s) => s.step);
  const base = useDraft((s) => s.base);
  const goto = useDraft((s) => s.goto);
  const w = useDraft((s) => s.wadspace);
  const templates = useApp((s) => s.templates);
  const customizations = useApp((s) => s.customizations);
  const { dirty } = useCustomizeSave();
  const at = STEPS.findIndex((s) => s.value === step);
  const r = base && resolve({ templates, customizations }, base);
  const reachable = (s: Step) => s === "template" || (!!r && (s === "customize" || !dirty));

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-4 border-b border-line bg-bg-2/60 px-5 backdrop-blur-xl">
        <div className="min-w-0 flex-1 basis-0">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">WadBuilder</div>
          <div className="truncate font-display text-lg font-semibold tracking-tight">{step === "template" ? "New or existing" : w.name.trim() || (w.id ? "Untitled" : r ? `New ${r.customization?.name ?? r.template.name} wadspace` : "")}</div>
        </div>
        <ol className="flex shrink-0 items-center gap-1 rounded-2xl bg-surface-2/70 p-1 ring-1 ring-line">
          {STEPS.map((s, i) => {
            const on = s.value === step;
            const past = i < at;
            return (
              <li key={s.value} className="flex items-center gap-1">
                {i > 0 && <span className={clsx("h-px w-4", past || on ? "bg-accent/60" : "bg-line-strong")} />}
                <button
                  type="button"
                  disabled={!reachable(s.value)}
                  onClick={() => goto(s.value)}
                  aria-current={on ? "step" : undefined}
                  className={clsx("flex h-8 items-center gap-2 rounded-xl pl-1.5 pr-3 text-[13px] font-medium transition-colors disabled:opacity-40", on ? "bg-surface text-fg shadow-sm ring-1 ring-line-strong" : "text-muted hover:text-fg")}
                >
                  <span className={clsx("grid size-5 place-items-center rounded-full text-[11px] font-bold", on ? "bg-accent text-accent-fg" : past ? "bg-accent/20 text-accent" : "bg-surface-3 text-muted")}>
                    {past ? <Check className="size-3" strokeWidth={3} /> : i + 1}
                  </span>
                  {s.label}
                </button>
              </li>
            );
          })}
        </ol>
        <div className="flex-1 basis-0" />
      </div>

      {step === "template" ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <StepTemplate />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[480px] shrink-0 flex-col border-r border-line bg-bg-2/40">
            <div className="min-h-0 flex-1 overflow-y-auto">{step === "customize" ? <StepCustomize /> : <StepConstruct />}</div>
            {step === "customize" ? <CustomizeFooter /> : <ConstructFooter />}
          </aside>
          <Preview />
        </div>
      )}
    </div>
  );
}

function CustomizeFooter() {
  const goto = useDraft((s) => s.goto);
  const { r, dirty, empty, save, nameProblem } = useCustomizeSave();
  const [name, setName] = useState("");
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  if (!r) return null;
  const fromCustom = !!r.customization;
  const problem = nameProblem(name);
  const saveAs = async (n: string, update: boolean) => {
    setSaving(true);
    await save(n, update);
    setSaving(false);
  };
  const saveNew = async () => {
    setTried(true);
    if (problem) return;
    await saveAs(name.trim(), false);
    setName("");
    setTried(false);
  };
  return (
    <div className="shrink-0 space-y-2 border-t border-line bg-bg-2/60 p-3">
      {dirty && !(empty && !fromCustom) && (
        <div className="rounded-xl bg-surface-2 p-2.5 ring-1 ring-line">
          <div className="mb-2 text-xs text-muted">
            {fromCustom
              ? `Changes to ${r.customization!.name}: update it (its wadspaces get them on rebuild), or save them as a new customization.`
              : `This differs from the ${r.template.name} template, so it needs a new name: it's saved as a customization, its own image.`}
          </div>
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void saveNew()}
              placeholder="New name"
              className="h-9 text-[13px]"
              aria-label="Customization name"
              aria-invalid={tried && !!problem}
            />
            <Button size="sm" className="h-9 shrink-0" onClick={() => void saveNew()} disabled={!name.trim() || saving}>
              {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />} Save new
            </Button>
            {fromCustom && (
              <Button size="sm" variant="secondary" className="h-9 shrink-0" disabled={saving} onClick={() => void saveAs(r.customization!.name, true)}>
                Update
              </Button>
            )}
          </div>
          {tried && problem && <p className="mt-1.5 text-xs text-danger">{problem}</p>}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => goto("template")}>
          <ArrowLeft className="size-4" /> Back
        </Button>
        <Button variant="primary" className="flex-1" disabled={dirty} onClick={() => goto("construct")} title={dirty ? "Save the changes under a new name first" : undefined}>
          Next: construct a wadspace <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

function ConstructFooter() {
  const goto = useDraft((s) => s.goto);
  const reset = useDraft((s) => s.reset);
  const w = useDraft((s) => s.wadspace);
  const { save, problems, canSave } = useConstructSave();
  const [saving, setSaving] = useState(false);
  return (
    <div className="shrink-0 space-y-2 border-t border-line bg-bg-2/60 p-3">
      {problems.map((p) => (
        <p key={p} className="text-xs text-danger">
          {p}
        </p>
      ))}
      <div className="flex gap-2">
        <Button variant="ghost" onClick={() => goto("customize")}>
          <ArrowLeft className="size-4" /> Customize
        </Button>
        <Button
          variant="primary"
          className="flex-1"
          disabled={!canSave || saving}
          title={!w.name.trim() ? "Name it first" : undefined}
          onClick={async () => {
            setSaving(true);
            const saved = await save();
            setSaving(false);
            if (!saved) return;
            useApp.getState().toast({ title: w.id ? `Saved ${saved.name}` : `Made ${saved.name}`, body: "Launch it from the sidebar.", tone: "success" });
            reset();
          }}
        >
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />} {w.id ? "Save wadspace" : "Save new wadspace"}
        </Button>
      </div>
    </div>
  );
}

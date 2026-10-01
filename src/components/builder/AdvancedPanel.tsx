import { Plus, X } from "lucide-react";
import clsx from "clsx";
import { FEATURES, type FeatureId } from "@core/spec";
import type { Advanced } from "@/lib/types";
import { Input, Label, Segmented, Textarea, Toggle } from "../ui";

// Tools install into the image without a desktop icon; apps with icons come
// from the desktop itself.
const TOOLS: FeatureId[] = ["git", "python", "cpp", "nodejs", "firebase", "hplip"];

function Heading({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h3>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

function Rows<T>({ items, onChange, blank, add, render }: { items: T[]; onChange: (v: T[]) => void; blank: () => T; add: string; render: (item: T, set: (v: T) => void) => React.ReactNode }) {
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="relative space-y-1.5 rounded-xl bg-surface-2 p-2 pr-9 ring-1 ring-line">
          {render(it, (v) => onChange(items.map((x, j) => (j === i ? v : x))))}
          <button type="button" onClick={() => onChange(items.filter((_, j) => j !== i))} className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md text-faint hover:bg-surface-3 hover:text-fg" aria-label="Remove">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...items, blank()])} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg">
        <Plus className="size-3.5" /> {add}
      </button>
    </div>
  );
}

const list = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

/** The old editor's settings: what else goes in the image, and how the machine runs it. */
export function AdvancedPanel({ value, onChange, offline }: { value: Advanced; onChange: (v: Advanced) => void; offline: boolean }) {
  const set = (patch: Partial<Advanced>) => onChange({ ...value, ...patch });
  const toggleTool = (f: FeatureId) => set({ tools: value.tools.includes(f) ? value.tools.filter((x) => x !== f) : [...value.tools, f] });

  return (
    <div className="h-full space-y-7 overflow-y-auto p-4">
      <section>
        <Heading hint="Installed in the image, no desktop icon.">Tools</Heading>
        <div className="flex flex-wrap gap-1.5">
          {TOOLS.map((id) => {
            const f = FEATURES.find((x) => x.id === id)!;
            const on = value.tools.includes(id);
            return (
              <button
                key={id}
                type="button"
                title={f.description}
                onClick={() => toggleTool(id)}
                className={clsx("rounded-full px-3 py-1 text-xs font-medium ring-1 transition-colors", on ? "bg-accent-soft text-fg ring-accent" : "bg-surface-2 text-muted ring-line hover:text-fg")}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      </section>

      <section>
        <Heading hint="Sites as single-purpose Kale Browser apps. Web icons on the desktop can also open this way.">Kale Browser apps</Heading>
        <Rows
          items={value.kaleResources}
          onChange={(kaleResources) => set({ kaleResources })}
          blank={() => ({ app_name: "", app_url: "" })}
          add="Add Kale Browser app"
          render={(k, setK) => (
            <>
              <Input className="h-8 text-xs" placeholder="Name" value={k.app_name} onChange={(e) => setK({ ...k, app_name: e.target.value })} />
              <Input className="h-8 font-mono text-xs" placeholder="https://…" value={k.app_url} onChange={(e) => setK({ ...k, app_url: e.target.value })} />
            </>
          )}
        />
      </section>

      <section>
        <Heading>On the machine</Heading>
        <div className="space-y-4">
          <div>
            <Label>Display</Label>
            <Segmented
              value={value.display}
              onChange={(display) => set({ display })}
              className="w-full"
              options={[
                { value: "host", label: "On its screen" },
                { value: "stream", label: "Streamed (legacy)" },
              ]}
            />
            <p className="mt-1.5 text-xs text-muted">
              {value.display === "host"
                ? "A window on the machine's own screen, with no input lag. The same image streams to a browser when used remotely."
                : "An all-in-one Selkies image streamed into the kiosk. Slower input; for older wadspaces."}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Hotkey</Label>
              <select
                value={value.hotkey ?? ""}
                onChange={(e) => set({ hotkey: e.target.value ? Number(e.target.value) : null })}
                className="h-10 w-full rounded-xl bg-surface-2 px-3 text-sm outline-none ring-1 ring-line focus:ring-2 focus:ring-accent"
              >
                <option value="">None</option>
                {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                  <option key={n} value={n}>
                    Super+{n}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label>Shared memory</Label>
              <Input value={value.shmSize} onChange={(e) => set({ shmSize: e.target.value })} className="font-mono" />
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">
              Keep settings and sign-ins
              <span className="block text-xs text-muted">Saves /config (logins, extensions) between runs. Projects are kept either way.</span>
            </span>
            <Toggle checked={value.persistConfig} onChange={(persistConfig) => set({ persistConfig })} label="Keep settings" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">
              Start with the machine
              <span className="block text-xs text-muted">Opens instantly; uses memory while idle.</span>
            </span>
            <Toggle checked={value.autostart} onChange={(autostart) => set({ autostart })} label="Start with the machine" />
          </div>
          <div>
            <Label hint="podman secret names">Secrets</Label>
            <Input className="font-mono" value={value.secrets.join(", ")} placeholder="github_token" onChange={(e) => set({ secrets: list(e.target.value) })} />
          </div>
          <div>
            <Label hint="/dev/kvm for Android emulators">Devices</Label>
            <Input className="font-mono" value={value.devices.join(", ")} onChange={(e) => set({ devices: list(e.target.value) })} />
          </div>
          <div>
            <Label hint="KEY=value per line">Environment</Label>
            <Textarea
              rows={4}
              className="font-mono text-xs"
              value={Object.entries(value.env)
                .map(([k, v]) => `${k}=${v}`)
                .join("\n")}
              onChange={(e) =>
                set({
                  env: Object.fromEntries(
                    e.target.value
                      .split("\n")
                      .map((l) => l.split(/=(.*)/s))
                      .filter(([k]) => k?.trim())
                      .map(([k, v]) => [k.trim(), v ?? ""]),
                  ),
                })
              }
            />
          </div>
          {offline && (
            <div>
              <Label hint="leave empty to build localhost/wadspaces-<id>">Image</Label>
              <Input className="font-mono text-xs" value={value.image ?? ""} onChange={(e) => set({ image: e.target.value.trim() || undefined })} />
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

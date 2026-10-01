import { Bot, Hand, Sparkles, Zap } from "lucide-react";
import clsx from "clsx";
import { PERMISSIONS, RUNTIMES, defaultAgent } from "@/lib/agent";
import type { AgentConfig } from "@/lib/types";
import { Input, Label, Segmented, Textarea, Toggle } from "../ui";

const EXAMPLES = [
  "Clone github.com/acme/web, get the test suite passing, and open a PR with the fixes.",
  "Research the top 5 open-source vector databases and write a comparison to ~/Desktop/report.md.",
  "Watch ~/Downloads for new invoices and file them into ~/Documents/Invoices by month.",
];

interface Props {
  agent: AgentConfig | undefined;
  onChange: (a: AgentConfig | undefined) => void;
}

/** Right-hand builder tab: the AI agent that boots with this wadspace, and the prompt it starts on. */
export function AgentPanel({ agent, onChange }: Props) {
  if (!agent?.enabled) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent ring-1 ring-accent/25">
          <Bot className="size-7" />
        </div>
        <h3 className="mt-4 font-display text-lg font-semibold tracking-tight">Give an AI agent this desktop</h3>
        <p className="mt-1 text-sm text-muted">Pick an agent, decide what it&apos;s allowed to do, and write the prompt it starts on when the wadspace boots.</p>
        <button
          type="button"
          onClick={() => onChange({ ...(agent ?? defaultAgent()), enabled: true })}
          className="mt-5 inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-medium text-accent-fg hover:brightness-110"
        >
          <Sparkles className="size-4" /> Add an AI agent
        </button>
      </div>
    );
  }

  const set = (patch: Partial<AgentConfig>) => onChange({ ...agent, ...patch });
  const runtime = RUNTIMES.find((r) => r.value === agent.runtime) ?? RUNTIMES[0];

  return (
    <div className="h-full space-y-6 overflow-y-auto p-4">
      <div className="flex items-center justify-between rounded-xl bg-accent-soft px-3 py-2.5 ring-1 ring-accent/25">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Bot className="size-4 text-accent" /> Agent starts on boot
        </span>
        <Toggle checked onChange={() => set({ enabled: false })} label="Agent starts on boot" />
      </div>

      <section>
        <Heading>Starting prompt</Heading>
        <Textarea
          rows={7}
          value={agent.prompt}
          onChange={(e) => set({ prompt: e.target.value })}
          placeholder="What should the agent work on as soon as the wadspace is up?"
          className="font-mono text-[12.5px] leading-relaxed"
          autoFocus={!agent.prompt}
        />
        {!agent.prompt && (
          <div className="mt-2 space-y-1.5">
            <div className="text-[11px] text-faint">Try one:</div>
            {EXAMPLES.map((ex) => (
              <button key={ex} type="button" onClick={() => set({ prompt: ex })} className="block w-full rounded-lg bg-surface-2 px-2.5 py-1.5 text-left text-xs text-muted ring-1 ring-line hover:text-fg hover:ring-line-strong">
                {ex}
              </button>
            ))}
          </div>
        )}
        <p className="mt-2 text-xs text-faint">Sent to the agent once, the first time the container boots. You can keep talking to it from inside the wadspace.</p>
      </section>

      <section>
        <Heading>Agent</Heading>
        <Label>Runtime</Label>
        <div className="grid grid-cols-2 gap-1.5">
          {RUNTIMES.map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => set({ runtime: r.value, model: r.models[0] ?? "" })}
              className={clsx("h-9 rounded-xl text-[13px] font-medium ring-1 transition-all", agent.runtime === r.value ? "bg-accent-soft ring-2 ring-accent" : "bg-surface-2 ring-line hover:ring-line-strong")}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="mt-3">
          {agent.runtime === "custom" ? (
            <>
              <Label>Launch command</Label>
              <Input value={agent.command ?? ""} onChange={(e) => set({ command: e.target.value })} placeholder="my-agent --prompt-file /run/prompt.md" className="h-9 font-mono text-[12.5px]" />
            </>
          ) : (
            <>
              <Label>Model</Label>
              <select value={agent.model} onChange={(e) => set({ model: e.target.value })} className="h-9 w-full cursor-pointer rounded-xl bg-surface-2 px-2.5 font-mono text-[12.5px] text-fg outline-none ring-1 ring-line focus:ring-2 focus:ring-accent">
                {runtime.models.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </>
          )}
        </div>
      </section>

      <section>
        <Heading>Permissions</Heading>
        <div className="space-y-1.5">
          {PERMISSIONS.map(({ key, label, hint }) => (
            <div key={key} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2 ring-1 ring-line">
              <div className="min-w-0">
                <div className="text-sm">{label}</div>
                <div className="truncate text-[11px] text-faint">{hint}</div>
              </div>
              <Toggle checked={agent.permissions[key]} onChange={(v) => set({ permissions: { ...agent.permissions, [key]: v } })} label={label} />
            </div>
          ))}
        </div>
        <div className="mt-3">
          <Label>When it wants to act</Label>
          <Segmented
            value={agent.autonomy}
            onChange={(autonomy) => set({ autonomy })}
            className="w-full"
            options={[
              { value: "ask", label: <><Hand className="size-3.5" /> Ask first</> },
              { value: "auto", label: <><Zap className="size-3.5" /> Autonomous</> },
            ]}
          />
        </div>
      </section>

      <section>
        <Heading>Standing instructions</Heading>
        <Textarea
          rows={4}
          value={agent.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          placeholder="Rules it follows for the whole session, e.g. “Commit after every working change. Never push to main.”"
          className="text-[13px]"
        />
      </section>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h3 className="mb-3 text-[10.5px] font-semibold uppercase tracking-[0.14em] text-faint">{children}</h3>;
}

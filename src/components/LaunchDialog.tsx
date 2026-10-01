import { Link } from "react-router";
import { useEffect, useState } from "react";
import { Bot, Rocket, Wand2, Zap } from "lucide-react";
import { AppTile } from "@/components/AppTile";
import { Button, Label, Modal, Textarea } from "@/components/ui";
import { runtimeLabel } from "@/lib/agent";
import { quickLaunch } from "@/lib/launch";
import { useApp } from "@/lib/store";
import { templateApps, type Template } from "@/lib/templates";

/** Launch a template; an AI wadspace asks for the prompt to start on. */
export function LaunchDialog({ template: t, onClose }: { template: Template | null; onClose: () => void }) {
  const apps = useApp((s) => s.apps);
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (t) setPrompt(t.agent?.prompt ?? "");
  }, [t]);

  const launch = () => {
    if (!t) return;
    // Fire inside the click so the popup isn't blocked; the dialog can close straight away.
    quickLaunch(t, { prompt: t.agent ? prompt : undefined });
    onClose();
  };

  const list = t ? templateApps(t, apps) : [];

  return (
    <Modal open={!!t} onClose={onClose} width={560}>
      {t && (
        <div className="space-y-5">
          <div className="flex items-center gap-4">
            {list[0] && <AppTile app={list[0]} size={56} />}
            <div className="min-w-0 flex-1">
              <h2 className="truncate font-display text-xl font-bold tracking-tight">{t.name}</h2>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {list.slice(1).map((a) => (
                  <AppTile key={a.id} app={a} size={24} />
                ))}
                {t.agent && (
                  <span className="ml-1 flex items-center gap-1 text-xs text-muted">
                    <Bot className="size-3.5" /> {runtimeLabel(t.agent)} · {t.agent.model}
                  </span>
                )}
              </div>
            </div>
          </div>

          {t.agent && (
            <div>
              <Label>What should it do?</Label>
              <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Describe the task…" autoFocus />
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Link to={`/builder?template=${t.id}`} onClick={onClose} className="mr-auto flex items-center gap-1.5 text-sm font-medium text-muted transition-colors hover:text-fg">
              <Wand2 className="size-4" /> Open in Builder
            </Link>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" onClick={launch} disabled={!!t.agent && !prompt.trim()}>
              {t.agent ? <Zap className="size-4 fill-current" /> : <Rocket className="size-4" />} {t.agent ? "Let it rip" : "Launch"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}


import { Link } from "react-router";
import { useMemo, useState } from "react";
import { ArrowRight, Boxes, FilePen, HardDrive, Plus, Timer, Trash2, Users } from "lucide-react";
import { Page } from "@/components/Page";
import { SearchBox, WadspaceGrid } from "@/components/WadspaceGrid";
import { DesktopThumb } from "@/components/desktop/DesktopThumb";
import { Button, EmptyState, IconButton, PageHeader, Segmented } from "@/components/ui";
import { backend } from "@/data";
import { timeAgo } from "@/lib/format";
import { useApp } from "@/lib/store";
import { useUi } from "@/lib/ui";
import type { Draft, Wadspace } from "@/lib/types";
import { hasAccount, hasLocal } from "@/lib/machine";

type Tab = "all" | "local" | "shared" | "drafts";
type Sort = "recent" | "name" | "size";

export default function WadspacesPage() {
  const user = useApp((s) => s.user);
  const wadspaces = useApp((s) => s.wadspaces);
  const drafts = useApp((s) => s.drafts);
  const focus = useApp((s) => s.focus);
  const openFocus = useUi((s) => s.openFocus);
  const [tab, setTab] = useState<Tab>("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("recent");

  const me = user?.username;
  const offline = !hasAccount;
  const filters: Record<Exclude<Tab, "drafts">, (w: Wadspace) => boolean> = {
    all: (w) => w.owner === me || w.sharedWith.includes(me ?? ""),
    local: (w) => w.local,
    shared: (w) => w.owner !== me && w.sharedWith.includes(me ?? ""),
  };
  const count = (t: Tab) => (t === "drafts" ? drafts.length : wadspaces.filter(filters[t]).length);

  const items = useMemo(() => {
    if (tab === "drafts") return [];
    const needle = q.trim().toLowerCase();
    return wadspaces
      .filter(filters[tab])
      .filter((w) => !needle || `${w.name} ${w.description}`.toLowerCase().includes(needle))
      .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "size" ? b.sizeMB - a.sizeMB : b.updatedAt.localeCompare(a.updatedAt)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wadspaces, tab, q, sort, me]);

  const draftItems = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return drafts
      .filter((d) => !needle || `${d.name} ${d.description}`.toLowerCase().includes(needle))
      .sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt)));
  }, [drafts, q, sort]);

  return (
    <Page>
      <PageHeader title="Wadspaces" subtitle={offline ? "Wadspaces on this machine and the ones you've designed here." : "Wadspaces in your account, on your machines, and shared with you."}>
        <Button onClick={() => openFocus()} disabled={!!focus}>
          <Timer className="size-4" /> Focus session
        </Button>
        <Link to="/builder">
          <Button variant="primary">
            <Plus className="size-4" /> New wadspace
          </Button>
        </Link>
      </PageHeader>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: "all" as Tab, label: <><Boxes className="size-3.5" /> All <Count n={count("all")} /></> },
            { value: "local" as Tab, label: <><HardDrive className="size-3.5" /> {hasLocal ? "On this machine" : "On machine"} <Count n={count("local")} /></> },
            ...(backend.caps.sharing ? [{ value: "shared" as Tab, label: <><Users className="size-3.5" /> Shared with me <Count n={count("shared")} /></> }] : []),
            { value: "drafts" as Tab, label: <><FilePen className="size-3.5" /> Drafts <Count n={count("drafts")} /></> },
          ]}
        />
        <div className="flex flex-1 items-center justify-end gap-2">
          <SearchBox value={q} onChange={setQ} placeholder={tab === "drafts" ? "Search drafts" : "Search wadspaces"} />
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-10 cursor-pointer rounded-xl bg-surface px-3 text-sm outline-none ring-1 ring-line focus:ring-2 focus:ring-accent">
            <option value="recent">Recently updated</option>
            <option value="name">Name</option>
            {tab !== "drafts" && <option value="size">Size</option>}
          </select>
        </div>
      </div>

      {tab === "drafts" ? (
        draftItems.length ? (
          <DraftGrid items={draftItems} />
        ) : (
          <EmptyState
            icon={<FilePen className="size-6" />}
            title={q ? "No matches" : "No drafts"}
            body={q ? `No draft matches "${q}".` : "Hit Save in the Builder to keep unbuilt work here and pick it up later."}
            action={!q && <Link to="/builder"><Button variant="primary"><Plus className="size-4" /> Open Builder</Button></Link>}
          />
        )
      ) : items.length ? (
        <WadspaceGrid items={items} />
      ) : (
        <EmptyState
          icon={<Boxes className="size-6" />}
          title={q ? "No matches" : tab === "shared" ? "Nothing shared with you yet" : "No wadspaces here"}
          body={q ? `Nothing matches "${q}".` : tab === "local" ? (hasLocal ? "Build a wadspace in the Builder to put it on this machine." : "Install a wadspace on your default machine to see it here.") : "Build one in the Wadspace Builder to get started."}
          action={!q && <Link to="/builder"><Button variant="primary"><Plus className="size-4" /> Open Builder</Button></Link>}
        />
      )}
    </Page>
  );
}

const STEP_LABEL: Record<Draft["step"], string> = { apps: "Step 1 · Apps", projects: "Step 2 · Projects", customize: "Step 3 · Customize" };

/** Saved-but-unbuilt Builder work, ready to pick back up. */
function DraftGrid({ items }: { items: Draft[] }) {
  const wadspaces = useApp((s) => s.wadspaces);
  const loadDrafts = useApp((s) => s.loadDrafts);
  const toast = useApp((s) => s.toast);

  const remove = async (d: Draft) => {
    if (!confirm(`Delete the draft "${d.name}"? Unbuilt changes will be lost.`)) return;
    await backend.deleteDraft(d.id);
    await loadDrafts();
    toast({ title: "Draft deleted", body: d.name });
  };

  return (
    <>
      <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {items.map((d) => {
          const base = d.wadspaceId && wadspaces.find((w) => w.id === d.wadspaceId);
          const apps = d.layout.icons.length;
          return (
            <div key={d.id} className="group flex flex-col overflow-hidden rounded-2xl border border-dashed border-line-strong bg-surface/60 transition-colors hover:border-accent/50 hover:bg-surface">
              <Link to={`/builder?draft=${d.id}`} className="relative block">
                <DesktopThumb layout={d.layout} className="aspect-[16/7] w-full" />
                <span className="absolute left-2.5 top-2.5 rounded-full bg-black/55 px-2 py-0.5 text-[10.5px] font-medium text-white ring-1 ring-white/15 backdrop-blur-md">{STEP_LABEL[d.step]}</span>
              </Link>
              <div className="flex items-center gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{d.name}</div>
                  <div className="mt-0.5 truncate text-xs text-muted">
                    {base ? `Unbuilt changes to ${base.name}` : `${apps} app${apps === 1 ? "" : "s"}`} · saved {timeAgo(d.updatedAt)}
                  </div>
                </div>
                <IconButton label="Delete draft" onClick={() => remove(d)}>
                  <Trash2 className="size-4" />
                </IconButton>
                <Link to={`/builder?draft=${d.id}`}>
                  <Button size="sm" variant="primary">
                    Continue <ArrowRight className="size-3.5" />
                  </Button>
                </Link>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Count({ n }: { n: number }) {
  return <span className="rounded-md bg-surface-3 px-1.5 text-[11px] tabular-nums text-muted">{n}</span>;
}

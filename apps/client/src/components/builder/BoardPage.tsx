// The Builder's board: every wadspace as a stack of modules (template,
// extensions, customization), in one row. New ones come from existing ones:
// drop modules between two stacks (or after the last) to copy them into a
// new stack, or + Create a blank one; click a module to edit it. What's on
// the board is the documents (sync.ts): changes are saved as they're made.
//
// ?stack=<id> scrolls to that stack; with &copy=1, a copy of it goes beside it.
import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { Plus, Undo2 } from "lucide-react";
import { useApp } from "@/lib/store";
import { Buckets, ConfirmDeleteDialog, Stacks, Toasts } from "./Board";
import { DragProvider } from "./drag";
import { EditorLayer } from "./editors/Editor";
import { modulesOf, stackName } from "./model";
import { PreviewLayer } from "./Preview";
import { useBoard } from "./store";
import "./builder.css";

export function BoardPage() {
  const canUndo = useBoard((s) => s.past.length > 0);
  const stacks = useBoard((s) => s.stacks);
  const { undo } = useBoard.getState();
  const templates = useApp((s) => s.templates);
  const extensions = useApp((s) => s.extensions);
  const wadspaces = useApp((s) => s.wadspaces);
  const [params, setParams] = useSearchParams();

  // The documents as stacks (and what changes in them elsewhere).
  useEffect(() => {
    useBoard.getState().load({ templates, extensions, wadspaces });
  }, [templates, extensions, wadspaces]);

  // Opened on a stack (Home, a wadspace's actions): to it, or to a copy of it. Once per ask.
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const id = params.get("stack");
    if (!id || handled.current === params.toString()) return;
    const b = useBoard.getState();
    const at = b.stacks.findIndex((s) => s.id === id);
    // Not on the board (yet: the documents may still be loading).
    if (at < 0) return;
    handled.current = params.toString();
    if (params.get("copy")) {
      const before = new Set(b.stacks.map((s) => s.id));
      b.newStack(modulesOf(b.stacks[at]), { kind: "stack", stackId: id }, at + 1);
      const made = useBoard.getState().stacks.find((s) => !before.has(s.id));
      if (made) b.toast(`Copied ${stackName(b.stacks[at])}`, true);
      useBoard.setState({ created: made?.id ?? id });
    } else useBoard.setState({ created: id });
    setTimeout(() => useBoard.setState({ created: null }), 1800);
    setParams({}, { replace: true });
  }, [params, stacks, setParams]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, select");
      const s = useBoard.getState();
      const busy = typing || s.editing || s.preview || s.confirming;
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !typing && !s.editing) {
        e.preventDefault();
        undo();
      }
      // Ctrl+click selects modules; Delete deletes them, Escape lets go.
      if (!busy && (e.key === "Delete" || e.key === "Backspace") && s.selected.length) {
        e.preventDefault();
        s.deleteSelected();
      }
      if (!busy && e.key === "Escape") s.clearSelection();
    };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [undo]);

  return (
    <div className="wb">
      <DragProvider>
        <div className="app-main">
          <header className="topbar">
            <span className="page-title">Builder</span>
            <div className="hints">
              <span>
                <kbd>drag</kbd> a module (and what's on top) to copy it
              </span>
              <span>
                <kbd>Shift</kbd>+drag one module
              </span>
              <span>
                <kbd>right-click</kbd> mid-drag to cancel
              </span>
              <span>
                <kbd>click</kbd> to edit
              </span>
              <span>
                <kbd>Ctrl+click</kbd> select, then Delete
              </span>
            </div>
            <div className="spacer" />
            <button className="btn-ghost" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)">
              <Undo2 size={14} /> Undo
            </button>
            <button className="btn-primary" data-tour="create" onClick={() => useBoard.getState().createStack()} title="A new stack on the right, with a blank template">
              <Plus size={14} /> Create
            </button>
          </header>
          <main
            className="board"
            data-tour="board"
            onClick={(e) => {
              // A click on empty board lets go of the selection.
              if (!(e.target as HTMLElement).closest(".mod-tile, button")) useBoard.getState().clearSelection();
            }}
          >
            <Stacks />
          </main>
          <Buckets />
        </div>
        <Toasts />
        <ConfirmDeleteDialog />
        <EditorLayer />
        <PreviewLayer />
      </DragProvider>
    </div>
  );
}

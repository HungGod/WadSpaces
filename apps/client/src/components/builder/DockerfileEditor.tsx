import { Fragment, useEffect, useRef, useState } from "react";
import { Check, FileCode2, RotateCcw, Save } from "lucide-react";
import clsx from "clsx";
import { Button } from "../ui";

const INSTRUCTIONS = /^(\s*)(FROM|RUN|CMD|LABEL|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL|MAINTAINER)\b/i;

/** Just enough highlighting to read like an editor: instructions, comments, strings, flags and variables. */
function highlight(line: string) {
  if (/^\s*#/.test(line)) return <span className="text-faint italic">{line}</span>;
  const out: React.ReactNode[] = [];
  let rest = line;
  const m = rest.match(INSTRUCTIONS);
  if (m) {
    out.push(m[1], <span key="i" className="font-semibold text-accent-2">{m[2]}</span>);
    rest = rest.slice(m[0].length);
  }
  const re = /("(?:[^"\\]|\\.)*"|'[^']*')|(\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)|(\s--?[a-z][\w-]*(?:=[^\s\\]*)?)|(\\$|&&|\|)/g;
  let last = 0;
  for (const t of rest.matchAll(re)) {
    out.push(rest.slice(last, t.index));
    const cls = t[1] ? "text-fg/70 dark:text-[#b7f06a]" : t[2] ? "text-accent" : t[3] ? "text-muted" : "text-faint";
    out.push(<span key={t.index} className={cls}>{t[0]}</span>);
    last = t.index + t[0].length;
  }
  out.push(rest.slice(last));
  return out.map((n, i) => <Fragment key={i}>{n}</Fragment>);
}

/**
 * Raw Dockerfile for the wadspace. `value` is what's saved; edits stay a draft until Save (or Ctrl+S).
 * `generated` is what the desktop editor would produce, for "Reset". `readOnly` shows it without
 * editing (the online app, which doesn't build); `actions` adds buttons to the header.
 */
export function DockerfileEditor({
  value,
  generated,
  custom,
  onSave,
  onReset,
  width,
  height,
  readOnly = false,
  actions,
  notice,
}: {
  value: string;
  generated: string;
  custom: boolean;
  onSave: (text: string) => void;
  onReset: () => void;
  width: number;
  height: number;
  readOnly?: boolean;
  actions?: React.ReactNode;
  notice?: React.ReactNode;
}) {
  const [draft, setDraft] = useState(value);
  const [justSaved, setJustSaved] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const code = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const dirty = draft !== value;

  // Follow the desktop while nothing has been hand-edited.
  useEffect(() => {
    if (!dirty) setDraft(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const save = () => {
    onSave(draft);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 1600);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      save();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: a, selectionEnd: b } = el;
      const next = draft.slice(0, a) + "    " + draft.slice(b);
      setDraft(next);
      requestAnimationFrame(() => el.setSelectionRange(a + 4, a + 4));
    }
  };

  const syncScroll = () => {
    const el = area.current;
    if (!el) return;
    if (code.current) {
      code.current.scrollTop = el.scrollTop;
      code.current.scrollLeft = el.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };

  const lines = draft.split("\n");
  const status = readOnly ? "Generated from the desktop · read-only" : dirty ? "Unsaved edits" : custom ? "Hand-edited" : "Generated from the desktop";

  return (
    <div className="flex flex-col overflow-hidden rounded-[18px] bg-surface shadow-deep ring-1 ring-line-strong" style={{ width, height }}>
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-surface-2/60 px-3">
        <FileCode2 className="size-4 text-accent" />
        <span className="font-mono text-[13px] font-medium">Dockerfile</span>
        <span className={clsx("flex items-center gap-1.5 text-xs", dirty ? "text-fg" : "text-muted")}>
          <span className={clsx("size-1.5 rounded-full", dirty ? "bg-accent-2" : custom ? "bg-accent" : "bg-faint")} />
          {status}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          {actions}
          {!readOnly && (custom || dirty) && (
            <Button
              size="sm"
              variant="ghost"
              title="Throw away hand edits and regenerate from the desktop"
              onClick={() => {
                setDraft(generated);
                onReset();
              }}
            >
              <RotateCcw className="size-3.5" /> Reset
            </Button>
          )}
          {!readOnly && (
            <Button size="sm" variant={dirty ? "primary" : "secondary"} disabled={!dirty} onClick={save} title="Save (Ctrl+S)">
              {justSaved ? <Check className="size-3.5" /> : <Save className="size-3.5" />} {justSaved ? "Saved" : "Save"}
            </Button>
          )}
        </div>
      </div>

      {notice && <div className="shrink-0 border-b border-line bg-surface-2/60 px-3 py-1.5 text-[11.5px] text-muted">{notice}</div>}
      {custom && !readOnly && (
        <div className="shrink-0 border-b border-line bg-accent-soft px-3 py-1.5 text-[11.5px] text-muted">
          This Dockerfile is hand-edited, so changes on the desktop won&apos;t update it. Reset to regenerate it.
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 font-mono text-[12.5px] leading-[20px]">
        <div ref={gutter} className="w-12 shrink-0 select-none overflow-hidden border-r border-line bg-surface-2/40 py-3 pr-2 text-right text-faint">
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <pre ref={code} aria-hidden className="pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre px-4 py-3 text-fg">
            {lines.map((l, i) => (
              <div key={i}>{l ? highlight(l) : " "}</div>
            ))}
          </pre>
          <textarea
            ref={area}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            readOnly={readOnly}
            onScroll={syncScroll}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            aria-label="Dockerfile"
            className="absolute inset-0 resize-none overflow-auto whitespace-pre bg-transparent px-4 py-3 text-transparent caret-accent outline-none selection:bg-accent/25 selection:text-transparent"
          />
        </div>
      </div>
    </div>
  );
}

// Preview: the finished wadspace's desktop, inside the Builder. Nothing is
// launched; clicking an icon opens a stand-in window showing what that app
// comes set up with.
import { useEffect, useState } from "react";
import { Eye, Folder, KeyRound, X } from "lucide-react";
import { SECRET_KIND_LABEL, app, desktopOf, extension, keyCount, webKey, tool, wallpaperCss, type DesktopIcon } from "./catalog";
import { lookOf, stackName, subOf, type Stack } from "./model";
import { useBoard } from "./store";
import { Img } from "./faces";

export function PreviewLayer() {
  const id = useBoard((s) => s.preview);
  const stack = useBoard((s) => s.stacks.find((x) => x.id === id));
  const { openPreview } = useBoard.getState();
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && openPreview(null);
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [openPreview]);
  if (!id || !stack) return null;
  return <Preview stack={stack} onClose={() => openPreview(null)} />;
}

function Preview({ stack, onClose }: { stack: Stack; onClose(): void }) {
  const [open, setOpen] = useState<DesktopIcon | null>(null);
  const icons = desktopOf(stack);
  const look = lookOf(stack);
  const keys = keyCount(stack);
  const folders = subOf(stack.customization, "folders")?.mounts ?? [];

  return (
    <>
      <div className="scrim scrim-open" onClick={onClose} />
      <div className="preview">
        <header className="preview-head">
          <Eye size={16} />
          <span className="preview-title">{stackName(stack)}</span>
          <span className="preview-note">Preview · nothing is launched</span>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </header>
        <div className="preview-desktop" style={{ background: wallpaperCss(look?.wallpaper) }}>
          <div className="pv-icons">
            {icons.map((i) => (
              <button key={i.id} className={`pv-icon${open?.id === i.id ? " on" : ""}`} onClick={() => setOpen(i)}>
                <Img src={i.icon} />
                <span>{i.label}</span>
              </button>
            ))}
            {icons.length === 0 && <span className="empty-note">Nothing on the desktop yet.</span>}
          </div>
          {open && <MockWindow stack={stack} icon={open} onClose={() => setOpen(null)} />}
          <div className="pv-taskbar">
            <Img src="/brand/wadspaces-icon-dark-transparent.svg" className="tb-logo" />
            {icons
              .filter((i) => i.id.startsWith("app:"))
              .map((i) => (
                <button key={i.id} className="pv-tb-app" title={i.label} onClick={() => setOpen(i)}>
                  <Img src={i.icon} />
                </button>
              ))}
            <div className="spacer" />
            {folders.length > 0 && (
              <span className="pv-tray" title={folders.map((f) => f.as).join(", ")}>
                <Folder size={12} /> {folders.length}
              </span>
            )}
            {keys.all > 0 && (
              <span className="pv-tray" title="Saved sign-ins">
                <KeyRound size={12} /> {keys.set}/{keys.all}
              </span>
            )}
            <span className="pv-clock">9:41</span>
          </div>
        </div>
      </div>
    </>
  );
}

/** A stand-in window for an app, web app or folder. */
function MockWindow({ stack, icon, onClose }: { stack: Stack; icon: DesktopIcon; onClose(): void }) {
  const [kind, id] = [icon.id.slice(0, icon.id.indexOf(":")), icon.id.slice(icon.id.indexOf(":") + 1)];
  const secrets = subOf(stack.customization, "secrets")?.bySlot ?? {};
  const signIn = (key: string) => secrets[key];
  let body: React.ReactNode;

  if (kind === "web") {
    const w = subOf(stack.extensions, "wadbrowser")?.webapps.find((x) => x.id === id);
    // A web app signs in with its key group's key.
    const s = webKey(stack, `web:${id}`);
    body = (
      <>
        <div className="mw-url">{w?.url}</div>
        <p>{s ? `Signed in with ${s.name}` : "Not signed in: this sign-in isn't saved, so it ends when the wadspace stops."}</p>
      </>
    );
  } else if (kind === "dir") {
    const m = subOf(stack.customization, "folders")?.mounts.find((x) => x.id === id);
    body = (
      <p>
        ~/Desktop/{m?.as}: {m?.kind === "github" ? <>cloned from <code>{m.repo}</code></> : <>copied from this machine{m?.files ? ` (${m.files} files)` : ""}</>}. The files live in this wadspace.
      </p>
    );
  } else if (id === "vscode") {
    const exts = subOf(stack.extensions, "vscode")?.extensions ?? [];
    const tools = subOf(stack.extensions, "tools")?.tools ?? [];
    body = (
      <>
        <p>{exts.length ? "Extensions:" : "No extensions."}</p>
        <ul className="mw-list">
          {exts.map((e) => {
            const s = signIn(`ext:${e}`);
            return (
              <li key={e}>
                {extension(e).name}
                {extension(e).secret && <span className="faint"> · {s ? `signed in (${s.name})` : "not signed in"}</span>}
              </li>
            );
          })}
        </ul>
        {tools.length > 0 && <p className="faint">Terminal tools: {tools.map((t) => tool(t).name).join(", ")}</p>}
      </>
    );
  } else if (id === "wadbrowser") {
    const b = subOf(stack.extensions, "wadbrowser");
    const k = webKey(stack, "browser");
    body = (
      <>
        <p>{b ? `${b.mode === "focus" ? "Focus mode (web apps only)" : "Browser with an address bar"}, ${b.webapps.length} web app${b.webapps.length === 1 ? "" : "s"}.` : "A plain browser."}</p>
        <p className="faint">{k ? `Profile: ${k.name}` : "No key: signed out when the wadspace stops."}</p>
      </>
    );
  } else {
    const a = app(id);
    const s = a?.secret ? signIn(`app:${id}`) : undefined;
    body = (
      <>
        <p>{a?.summary}</p>
        {a?.secret && <p className="faint">{s ? `${SECRET_KIND_LABEL[a.secret]}: ${s.name}` : `${SECRET_KIND_LABEL[a.secret]} isn't saved.`}</p>}
      </>
    );
  }

  return (
    <div className="mock-window">
      <div className="mw-bar">
        <Img src={icon.icon} />
        <span>{icon.label}</span>
        <div className="spacer" />
        <button className="icon-btn" onClick={onClose}>
          <X size={12} />
        </button>
      </div>
      <div className="mw-body">{body}</div>
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Bell, CheckCircle2, Play, X } from "lucide-react";
import { openBuilt } from "@/lib/build";
import { timeAgo } from "@/lib/format";
import { useApp, type Notice } from "@/lib/store";
import type { PublicUser } from "@/lib/types";
import { Avatar } from "./ui";

/**
 * The profile avatar doubles as a quiet notification point: a dot when something's ready,
 * a small bubble that slides out beside it for a few seconds, and a list on click.
 */
export function ProfileNotices({ user }: { user: PublicUser }) {
  const notices = useApp((s) => s.notices);
  const readNotices = useApp((s) => s.readNotices);
  const clearNotice = useApp((s) => s.clearNotice);
  const unread = notices.filter((n) => !n.read).length;
  const [bubble, setBubble] = useState<Notice | null>(null);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const latest = notices[0];
  // Pinned just outside the sidebar, level with the avatar, so nothing in the sidebar is covered.
  const [anchor, setAnchor] = useState({ left: 0, bottom: 0 });
  const place = () => {
    const el = box.current;
    if (!el) return;
    const side = el.closest("aside")?.getBoundingClientRect();
    const me = el.getBoundingClientRect();
    setAnchor({ left: (side?.right ?? me.right) + 12, bottom: window.innerHeight - me.bottom - 2 });
  };

  // Slide a bubble out for each new notice, then tuck it away again.
  useEffect(() => {
    if (!latest || latest.read) return;
    place();
    setBubble(latest);
    const t = setTimeout(() => setBubble(null), 6500);
    return () => clearTimeout(t);
  }, [latest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close the list on an outside click.
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("mousedown", off);
    return () => window.removeEventListener("mousedown", off);
  }, [open]);

  const toggle = () => {
    place();
    setBubble(null);
    setOpen((o) => !o);
    readNotices();
  };

  const openIt = (n: Notice) => {
    setOpen(false);
    setBubble(null);
    readNotices();
    if (n.wadspaceId) openBuilt(n.wadspaceId);
  };

  return (
    <div ref={box} className="relative shrink-0">
      <button type="button" onClick={toggle} className="relative block rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" aria-label={unread ? `${unread} new notification${unread > 1 ? "s" : ""}` : "Notifications"} title="Notifications">
        <Avatar user={user} size={32} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex size-3">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex size-3 rounded-full bg-accent ring-2 ring-bg-2" />
          </span>
        )}
      </button>

      <AnimatePresence>
        {bubble && !open && (
          <motion.div
            key={bubble.id}
            initial={{ opacity: 0, x: -8, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -6, transition: { duration: 0.15 } }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            style={anchor}
            className="fixed z-50 flex w-[22rem] items-center gap-2.5 rounded-2xl border border-line-strong bg-surface/95 py-2 pl-3 pr-2 shadow-deep backdrop-blur-xl"
            role="status"
          >
            {/* Tail pointing back at the avatar */}
            <span className="absolute -left-[5px] bottom-3 size-2.5 rotate-45 border-b border-l border-line-strong bg-surface" />
            <CheckCircle2 className="size-4 shrink-0 text-fg dark:text-accent" />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[13px] font-semibold">{bubble.title}</div>
              {bubble.body && <div className="truncate text-[11.5px] text-muted">{bubble.body}</div>}
            </div>
            {bubble.wadspaceId && (
              <button type="button" onClick={() => openIt(bubble)} className="h-7 shrink-0 rounded-lg bg-accent px-2.5 text-xs font-semibold text-accent-fg hover:brightness-110">
                Open
              </button>
            )}
            <button type="button" onClick={() => setBubble(null)} className="grid size-6 shrink-0 place-items-center rounded-md text-faint hover:text-fg" aria-label="Hide">
              <X className="size-3.5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, transition: { duration: 0.12 } }}
            style={anchor}
            className="fixed z-50 w-80 overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-deep"
          >
            <div className="flex items-center gap-2 border-b border-line px-4 py-3 text-sm font-semibold">
              <Bell className="size-4 text-accent" /> Notifications
            </div>
            {notices.length ? (
              <ul className="max-h-80 divide-y divide-line overflow-y-auto">
                {notices.map((n) => (
                  <li key={n.id} className="group flex items-center gap-3 px-4 py-3">
                    <CheckCircle2 className="size-4 shrink-0 text-fg dark:text-accent" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">{n.title}</div>
                      <div className="truncate text-[11.5px] text-muted">
                        {n.body} · {timeAgo(n.at)}
                      </div>
                    </div>
                    {n.wadspaceId && (
                      <button type="button" onClick={() => openIt(n)} className="grid size-7 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg" aria-label={`Open ${n.title}`} title="Open">
                        <Play className="size-3.5 fill-current" />
                      </button>
                    )}
                    <button type="button" onClick={() => clearNotice(n.id)} className="grid size-7 shrink-0 place-items-center rounded-lg text-faint opacity-0 hover:bg-surface-2 hover:text-fg group-hover:opacity-100" aria-label="Clear" title="Clear">
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-center text-sm text-muted">You&apos;re all caught up.</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

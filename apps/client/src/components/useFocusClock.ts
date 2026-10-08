import { useEffect, useRef, useState } from "react";
import { useApp } from "@/lib/store";

/** Mount once (in the shell / popup): polls the server's focus lock and toasts when it ends. */
export function useFocusPolling(announce = true) {
  const focus = useApp((s) => s.focus);
  const loadFocus = useApp((s) => s.loadFocus);
  const toast = useApp((s) => s.toast);
  const had = useRef(false);

  useEffect(() => {
    loadFocus().catch(() => {});
    const t = setInterval(() => loadFocus().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [loadFocus]);

  useEffect(() => {
    if (focus) had.current = true;
    else if (had.current) {
      had.current = false;
      if (announce) toast({ title: "Focus session complete", body: "All wadspaces are unlocked again.", tone: "success" });
    }
  }, [focus, toast, announce]);
}

/** Ms remaining in the focus session, ticking every second (0 when none). */
export function useFocusRemaining() {
  const focus = useApp((s) => s.focus);
  const skew = useApp((s) => s.clockSkew);
  const loadFocus = useApp((s) => s.loadFocus);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!focus) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [focus]);

  // Read the clock at render time; the interval only exists to trigger re-renders.
  const remaining = focus ? Math.max(0, focus.endsAt - (Date.now() + skew)) : 0;
  // When the local countdown hits zero, re-check immediately rather than waiting for the next poll.
  useEffect(() => {
    if (focus && remaining === 0) loadFocus().catch(() => {});
  }, [focus, remaining, loadFocus]);

  return remaining;
}

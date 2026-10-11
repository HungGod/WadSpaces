import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { Check, KeyRound, Loader2, Plus, X } from "lucide-react";
import clsx from "clsx";
import type { LayoutIcon } from "@/lib/types";
import { backend } from "@/data";
import { useApp } from "@/lib/store";
import { WEB, isSignInPath, signInKind, signInPaths } from "@core/signins";
import { fitting, signInAppName } from "../SignIns";

/** Which sign-in an app on the desktop uses: this wadspace's own, or a saved
 *  one (shared with every wadspace whose apps use it). */
export function SignInPicker({ icon, onSave, onCancel }: { icon: LayoutIcon; onSave: (i: LayoutIcon) => void; onCancel: () => void }) {
  const all = useApp((s) => s.signIns);
  const loadSignIns = useApp((s) => s.loadSignIns);
  const kind = signInKind(icon) ?? WEB;
  const options = useMemo(() => fitting(all, icon), [all, icon]);
  const [pick, setPick] = useState<string | undefined>(icon.signIn);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState(kind === WEB ? icon.label : `${icon.label}`);
  const [paths, setPaths] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = kind === WEB ? [] : signInPaths(kind);
  const typed = paths
    .split("\n")
    .map((l) => l.trim().replace(/^~\//, ""))
    .filter(Boolean);
  const badPath = typed.find((p) => !isSignInPath(p));
  // A design from another machine names a sign-in this one hasn't got: it's
  // made (empty) when the wadspace starts.
  const missing = icon.signIn && !all.some((s) => s.id === icon.signIn);

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await backend.createSignIn({ name: name.trim(), app: kind, ...(!known && kind !== WEB && { paths: typed }) });
      await loadSignIns().catch(() => {});
      setPick(s.id);
      setMaking(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const row = (id: string | undefined, title: string, sub: string) => (
    <button
      key={id ?? "own"}
      type="button"
      onClick={() => setPick(id)}
      className={clsx("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left", pick === id ? "bg-white/15" : "hover:bg-white/10")}
    >
      <span className={clsx("grid size-4 shrink-0 place-items-center rounded-full ring-1", pick === id ? "bg-[#c6ff1f] ring-[#c6ff1f] text-[#0a0614]" : "ring-white/30")}>
        {pick === id && <Check className="size-3" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{title}</span>
        <span className="block truncate text-[11px] text-white/50">{sub}</span>
      </span>
    </button>
  );

  return (
    <div className="absolute inset-0 z-[9600] grid place-items-center bg-black/40 backdrop-blur-[2px]" onPointerDown={onCancel} onContextMenu={(e) => e.stopPropagation()}>
      <motion.form
        initial={{ opacity: 0, y: 10, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        onPointerDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...icon, signIn: pick });
        }}
        className="w-[380px] rounded-2xl border border-white/10 bg-[#140d22]/95 p-4 text-white shadow-2xl backdrop-blur-xl"
      >
        <div className="mb-1 flex items-center justify-between">
          <h3 className="flex items-center gap-2 font-display text-base font-semibold">
            <KeyRound className="size-4 text-[#c6ff1f]" /> {icon.label}'s sign-in
          </h3>
          <button type="button" onClick={onCancel} className="rounded-md p-1 text-white/60 hover:bg-white/10 hover:text-white" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <p className="mb-3 text-xs text-white/55">
          A saved sign-in is shared by every wadspace whose apps use it: sign in once, in any of them. It takes effect the next time this wadspace starts.
        </p>

        <div className="max-h-[220px] space-y-0.5 overflow-y-auto">
          {row(undefined, "This wadspace only", "Signed in here, separately")}
          {options.map((s) => row(s.id, s.name, s.size ? `${signInAppName(s.app)} · signed in` : `${signInAppName(s.app)} · not signed in yet`))}
          {missing && row(icon.signIn, "A sign-in from another machine", "Made here, empty, when the wadspace starts")}
        </div>

        {making ? (
          <div className="mt-3 space-y-2 rounded-lg bg-white/5 p-2.5">
            <label className="block text-xs text-white/60">
              Name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className="mt-1 w-full rounded-lg bg-white/5 px-2.5 py-2 text-sm text-white outline-none ring-1 ring-white/10 focus:ring-[#c6ff1f]"
              />
            </label>
            {kind !== WEB && !known && (
              <label className="block text-xs text-white/60">
                Which files hold its sign-in? (under the home folder, one per line; end a folder with /)
                <textarea
                  value={paths}
                  onChange={(e) => setPaths(e.target.value)}
                  rows={3}
                  placeholder={".config/app/\n.app-token.json"}
                  className="mt-1 w-full rounded-lg bg-white/5 px-2.5 py-2 font-mono text-xs text-white outline-none ring-1 ring-white/10 focus:ring-[#c6ff1f]"
                />
                {badPath && <span className="text-[#ff6b9b]">{badPath}: not a path under the home folder</span>}
              </label>
            )}
            {error && <p className="text-xs text-[#ff6b9b]">{error}</p>}
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setMaking(false)} className="rounded-lg px-3 py-1.5 text-xs text-white/70 hover:bg-white/10">
                Cancel
              </button>
              <button
                type="button"
                onClick={make}
                disabled={busy || !name.trim() || (kind !== WEB && !known && (!typed.length || !!badPath))}
                className="flex items-center gap-1.5 rounded-lg bg-white/15 px-3 py-1.5 text-xs font-medium hover:bg-white/20 disabled:opacity-50"
              >
                {busy && <Loader2 className="size-3 animate-spin" />} Save sign-in
              </button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setMaking(true)} className="mt-2 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-white/70 hover:bg-white/10 hover:text-white">
            <Plus className="size-4" /> New saved sign-in
          </button>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-white/70 hover:bg-white/10">
            Cancel
          </button>
          <button type="submit" className="rounded-lg bg-[#c6ff1f] px-4 py-2 text-sm font-semibold text-[#0a0614] hover:brightness-110">
            Save
          </button>
        </div>
      </motion.form>
    </div>
  );
}

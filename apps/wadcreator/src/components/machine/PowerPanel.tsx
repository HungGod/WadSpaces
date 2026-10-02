import { useState } from "react";
import { Loader2, Power, RotateCw } from "lucide-react";
import { wadd } from "@/lib/wadd";
import { Button } from "../ui";

/** Restart or shut down this machine (the kiosk has no other way to). */
export function PowerPanel() {
  const [busy, setBusy] = useState<"reboot" | "poweroff" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: "reboot" | "poweroff") => {
    setBusy(action);
    setError(null);
    try {
      await wadd.power(action);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3">
      <Button size="lg" className="w-full justify-start" disabled={!!busy} onClick={() => run("reboot")}>
        {busy === "reboot" ? <Loader2 className="size-4 animate-spin" /> : <RotateCw className="size-4" />} Restart
      </Button>
      <Button size="lg" variant="danger" className="w-full justify-start" disabled={!!busy} onClick={() => run("poweroff")}>
        {busy === "poweroff" ? <Loader2 className="size-4 animate-spin" /> : <Power className="size-4" />} Shut down
      </Button>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

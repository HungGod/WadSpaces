import { FolderGit2, Power, Wifi } from "lucide-react";
import clsx from "clsx";
import { openMachinePanel, type Panel } from "./panels";

const BUTTONS: { panel: Panel; label: string; icon: typeof Wifi }[] = [
  { panel: "wifi", label: "Wi-Fi", icon: Wifi },
  { panel: "github", label: "GitHub", icon: FolderGit2 },
  { panel: "power", label: "Power", icon: Power },
];

/** The machine app's sidebar: this machine's Wi-Fi, GitHub sign-in and power. */
export function MachineButtons({ narrow }: { narrow: boolean }) {
  return (
    <div className={clsx("flex gap-1", narrow ? "flex-col items-center" : "")}>
      {BUTTONS.map(({ panel, label, icon: Icon }) => (
        <button
          key={panel}
          type="button"
          title={label}
          aria-label={label}
          onClick={() => openMachinePanel(panel)}
          className={clsx("flex h-9 items-center justify-center gap-2 rounded-xl text-[13px] font-medium text-muted hover:bg-surface-2 hover:text-fg", narrow ? "w-10" : "flex-1")}
        >
          <Icon className="size-4 shrink-0" />
          {!narrow && <span className="truncate">{label}</span>}
        </button>
      ))}
    </div>
  );
}

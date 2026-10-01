import { useSearchParams } from "react-router";
import { QuickLaunch } from "@/components/QuickLaunch";
import { CATEGORIES, type TemplateCategory } from "@/lib/templates";

export default function LaunchPage() {
  const [params] = useSearchParams();
  const category = params.get("category");
  const q = params.get("q") ?? "";
  const search = params.get("search");
  const initial = CATEGORIES.some((c) => c.value === category) ? (category as TemplateCategory) : null;
  // `key` remounts when a link switches category or search (e.g. Home's cards while already on this page).
  return <QuickLaunch key={`${initial ?? "all"}:${q}:${search ?? ""}`} initialCategory={initial} initialQuery={q} focusSearch={search === "1" || !!q} />;
}

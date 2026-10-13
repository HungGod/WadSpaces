// The Builder: the board of stacks (components/builder). This commit moves
// the documents to stacks; the board comes with the next.
import { Page } from "@/components/Page";
import { EmptyState } from "@/components/ui";
import { wadspaceName } from "@/data/layers";
import { alive, useApp } from "@/lib/store";

export default function BuilderPage() {
  const wadspaces = useApp((s) => s.wadspaces);
  return (
    <Page>
      <EmptyState icon={null} title="The Builder" body={alive(wadspaces).map((w) => wadspaceName(w)).join(" · ") || "No wadspaces yet."} />
    </Page>
  );
}

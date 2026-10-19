import type { Metadata } from "next";

import { ModerationQueue } from "./_components/ModerationQueue";

export const metadata: Metadata = {
  title: "Edit Suggestions",
  description: "Review community-proposed edits to event listings.",
};

export default function ModerateSuggestionsPage() {
  return <ModerationQueue />;
}

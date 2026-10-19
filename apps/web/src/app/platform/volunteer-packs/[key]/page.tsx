"use client";

import { useParams } from "next/navigation";

import { PackEditorView } from "../_components/PackEditorView";

/**
 * `/platform/volunteer-packs/[key]` — the pack editor (FR-014) and its
 * DRAFT-inclusive organizer preview (FR-016).
 *
 * Keyed on the pack's stable slug rather than its UUID so a curator can link a
 * pack to a colleague and a re-seed of the same key lands on the same page.
 */
export default function PlatformVolunteerPackEditorPage() {
  const params = useParams<{ key: string }>();
  const packKey = Array.isArray(params?.key)
    ? (params.key[0] ?? "")
    : (params?.key ?? "");

  return <PackEditorView packKey={packKey} />;
}

"use client";

import { useParams } from "next/navigation";

import { TicketPackEditorView } from "../_components/TicketPackEditorView";

/**
 * `/platform/ticket-packs/[key]` — the pack editor (FR-012) and its
 * DRAFT-inclusive organizer preview.
 *
 * Keyed on the pack's stable slug rather than its UUID so a curator can link
 * a pack to a colleague and a re-seed of the same key lands on the same page.
 */
export default function PlatformTicketPackEditorPage() {
  const params = useParams<{ key: string }>();
  const packKey = Array.isArray(params?.key)
    ? (params.key[0] ?? "")
    : (params?.key ?? "");

  return <TicketPackEditorView packKey={packKey} />;
}

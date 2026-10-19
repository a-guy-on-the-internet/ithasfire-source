import { z } from "zod";

import type { SavedSnippetRecord } from "@th/types/repos/saved-snippets";
import {
  SAVED_SNIPPET_BODY_MAX,
  SAVED_SNIPPET_LABEL_MAX,
} from "@th/types/repos/saved-snippets";

import {
  plainTextMultilineRequired,
  plainTextRequired,
} from "../../../lib/sanitize-plain-text";
import { STARTER_LOCALES } from "./starter-reasons";

// ─────────────────────────────────────────────────────────────────────────────
// Saved snippets (booking-the-night FR-013) — the shared wire vocabulary.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The kinds a client may name. Only DECLINE_REASON has a writer today; ASK is
 * reserved for the deferred ask templates and is refused at the boundary
 * until it is built.
 */
export const savedSnippetKindInputSchema = z
  .enum(["DECLINE_REASON"])
  .default("DECLINE_REASON");

/** The picker's title: one line, sanitized BEFORE the 60 cap. */
export const savedSnippetLabelSchema = plainTextRequired(SAVED_SNIPPET_LABEL_MAX);

/** What is inserted into the reason field: line breaks kept, sanitized BEFORE the 500 cap. */
export const savedSnippetBodySchema = plainTextMultilineRequired(
  SAVED_SNIPPET_BODY_MAX,
);

/**
 * The actor's UI locale, used ONLY to pick the language of the platform
 * starters when a list is first used. Optional: absent → the actor's stored
 * locale → English.
 */
export const starterLocaleInputSchema = z.enum(STARTER_LOCALES).optional();

export const savedSnippetOutputSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["DECLINE_REASON", "ASK"]),
    label: z.string(),
    body: z.string(),
    sortOrder: z.number().int(),
    isStarter: z.boolean(),
  })
  .strict();

export type SavedSnippetOutput = z.infer<typeof savedSnippetOutputSchema>;

/** Owner pair and timestamps stay server-side: the client already named the list. */
export function toSavedSnippetOutput(row: SavedSnippetRecord): SavedSnippetOutput {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    body: row.body,
    sortOrder: row.sortOrder,
    isStarter: row.isStarter,
  };
}

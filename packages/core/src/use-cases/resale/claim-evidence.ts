import { z } from "zod";

import { plainTextMultilineRequired } from "../../lib/sanitize-plain-text";

// ── Claim evidence (v1: text only) ─────────────────────────────────────────
//
// The `evidence` / `sellerEvidence` columns are JSON. Writes go through the
// strict schemas below (sanitized before the length check), so new rows have
// exactly these shapes. Rows written before v1 can hold ANY JSON, so the read
// side never parses them strictly: it derives a display string with
// `safeParse` and returns null when the stored value does not fit.

export const CLAIM_EVIDENCE_TEXT_MAX = 2000;

/** Buyer's evidence when filing a claim. */
export const claimEvidenceSchema = z
  .object({
    description: plainTextMultilineRequired(CLAIM_EVIDENCE_TEXT_MAX),
  })
  .strict();

/** Seller's reply to a claim. */
export const claimSellerEvidenceSchema = z
  .object({
    reply: plainTextMultilineRequired(CLAIM_EVIDENCE_TEXT_MAX),
  })
  .strict();

export type ClaimEvidence = z.infer<typeof claimEvidenceSchema>;
export type ClaimSellerEvidence = z.infer<typeof claimSellerEvidenceSchema>;

// Read-side shapes: lenient (extra keys ignored, no sanitize), because they
// run over legacy rows. A blank string counts as "no text".
const storedEvidenceSchema = z.object({ description: z.string() });
const storedSellerEvidenceSchema = z.object({ reply: z.string() });

/** The buyer's description from a stored `evidence` value, or null. */
export function claimEvidenceText(stored: unknown): string | null {
  const parsed = storedEvidenceSchema.safeParse(stored);
  if (!parsed.success) return null;
  const text = parsed.data.description.trim();
  return text.length > 0 ? text : null;
}

/** The seller's reply from a stored `sellerEvidence` value, or null. */
export function claimSellerReplyText(stored: unknown): string | null {
  const parsed = storedSellerEvidenceSchema.safeParse(stored);
  if (!parsed.success) return null;
  const text = parsed.data.reply.trim();
  return text.length > 0 ? text : null;
}

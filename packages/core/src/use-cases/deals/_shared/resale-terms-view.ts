import { z } from "zod";

import type { Repos } from "@th/ports/repos";

import type { ResaleShareClause } from "../../../lib/pricing/resale-pricing";
import { resaleClauseOfTerms } from "../../../lib/resale-clause";
import type { DealTarget } from "./deal-target";

// The resale clause as the deal read shows it (organiser-resale-share
// FR-011). Kept apart from the writer (`set-resale-clause.ts`) so the reads
// import no terms-writing code.

export const resaleClauseViewSchema = z
  .object({
    type: z.enum(["PERCENT", "FLAT"]),
    /** PERCENT: basis points of the asking price, 0..1000. */
    bps: z.number().int().nullable(),
    /** FLAT: cents per sale, held to 10% of the ask on each sale. */
    cents: z.number().int().nullable(),
    payer: z.enum(["SELLER", "BUYER"]),
  })
  .strict();

/** The RESALE terms behind a target, as the deal read shows them. */
export const resaleTermsViewSchema = z
  .object({
    /**
     * Null when the target has no RESALE terms yet, and for a viewer who sees
     * only their own line (OWN_LINE): the ids and counts are the editor's.
     */
    payoutTermsId: z.uuid().nullable(),
    /** Pass back as `setResaleClause.expectedVersion`. Null with no terms / OWN_LINE. */
    version: z.number().int().nullable(),
    /** Null = not set: resale cannot be switched on (FR-001). Shown to every viewer. */
    clause: resaleClauseViewSchema.nullable(),
    /** RESALE payout lines on the terms; a set clause on an event needs ≥ 1. Null for OWN_LINE. */
    resaleLineCount: z.number().int().nullable(),
  })
  .strict();

export type ResaleTermsView = z.infer<typeof resaleTermsViewSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// The read (getTermsDeal)
// ─────────────────────────────────────────────────────────────────────────────

export function toClauseView(clause: ResaleShareClause): z.infer<typeof resaleClauseViewSchema> {
  return {
    type: clause.type,
    bps: clause.type === "PERCENT" ? clause.bps : null,
    cents: clause.type === "FLAT" ? clause.cents : null,
    payer: clause.payer,
  };
}

/**
 * The RESALE terms behind a target, for the deal read. The caller has already
 * run the read's gate. `eventId` is the event the read resolved (the EVENT
 * target's, or the booking's event); ORG_DEFAULT reads the org's template.
 */
export async function loadResaleTermsView(
  repos: Pick<Repos, "events" | "organizations" | "payoutTerms">,
  target: DealTarget,
  eventId: string | null,
  visibility: "FULL" | "OWN_LINE",
): Promise<ResaleTermsView> {
  let termsId: string | null = null;
  if (target.kind === "ORG_DEFAULT") {
    termsId = (await repos.organizations.getById(target.orgId))?.defaultResalePayoutTermsId ?? null;
  } else if (eventId) {
    termsId = (await repos.events.getById(eventId))?.resalePayoutTermsId ?? null;
  }
  const terms = termsId ? await repos.payoutTerms.getById(termsId) : null;
  if (!terms) {
    return {
      payoutTermsId: null,
      version: null,
      clause: null,
      resaleLineCount: visibility === "FULL" ? 0 : null,
    };
  }
  const clause = resaleClauseOfTerms(terms);
  if (visibility !== "FULL") {
    // The clause is what every seller and buyer is shown anyway (FR-008,
    // FR-009); the row id, version and line count are the editor's.
    return {
      payoutTermsId: null,
      version: null,
      clause: clause ? toClauseView(clause) : null,
      resaleLineCount: null,
    };
  }
  return {
    payoutTermsId: terms.id,
    version: terms.version,
    clause: clause ? toClauseView(clause) : null,
    resaleLineCount: (await repos.payoutTerms.listLines(terms.id)).length,
  };
}

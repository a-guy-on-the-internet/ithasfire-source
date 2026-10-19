/**
 * Pure assembly of a waiver body from clause-library clauses.
 *
 * Single source of the ASSEMBLED format: clauses sorted by `sortOrder`,
 * bodies joined with a blank line, plus the `assembledFromClauses` manifest
 * (`{ clauseId, clauseSlug, clauseVersion }`) stored on the template so
 * acceptance records can be traced back to exact clause versions.
 *
 * Used by the `assembleWaiver` use case (event-scoped, jurisdiction-aware)
 * and by the platform seed (apps/api/src/scripts/seed/waivers.ts), so the
 * two can never drift on formatting.
 */

export type AssemblableClause = {
  id: string;
  slug: string;
  version: number;
  body: string;
  sortOrder: number;
};

export type AssembledClauseReference = {
  clauseId: string;
  clauseSlug: string;
  clauseVersion: number;
};

export type AssembledWaiverBody = {
  /** Clause bodies sorted by `sortOrder`, joined with a blank line. */
  body: string;
  /** Clause manifest in the same order as the body sections. */
  assembledFromClauses: AssembledClauseReference[];
};

export function composeAssembledWaiverBody(
  clauses: readonly AssemblableClause[],
): AssembledWaiverBody {
  const sorted = [...clauses].sort((a, b) => a.sortOrder - b.sortOrder);
  return {
    body: sorted.map((clause) => clause.body).join("\n\n"),
    assembledFromClauses: sorted.map((clause) => ({
      clauseId: clause.id,
      clauseSlug: clause.slug,
      clauseVersion: clause.version,
    })),
  };
}

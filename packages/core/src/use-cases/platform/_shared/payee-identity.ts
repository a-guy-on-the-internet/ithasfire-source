import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";

// ─────────────────────────────────────────────────────────────────────────────
// BEST-EFFORT PAYEE IDENTITY — shared by the staff money views.
//
// Every "what the platform owes" panel has the same problem: the ledger
// returns cents against a `payeeId`, and a human triaging money needs a NAME.
// Resolving that name means two more reads (Payee → subject, then
// Organization/Human → label), and NEITHER of them may be allowed to blank the
// money.
//
// So the whole resolution is BEST-EFFORT and degrades in one direction only:
// a failure loses the LABEL, never the row and never the amount. The caller
// keeps the payeeId and the cents, marks the row `identityResolved: false`,
// and renders "unknown" instead of asserting anything. Swallow + report
// (ReporterPort convention, CLAUDE.md) — the report is GUARDED, because a
// throwing Sentry wiring turning a degraded panel into a failed one is the
// exact outcome the swallow exists to prevent.
//
// PARTIAL SUCCESS IS A REAL STATE and the ordering below encodes it: once the
// Payee read has returned, `identityResolved` is TRUE even if the subsequent
// org/human label read blows up. The subject type and the Connect-capability
// fields are then known (so a caller CAN judge payout eligibility from them)
// while the display label is simply missing. Flipping that flag back to false
// on a label failure would discard verdicts we actually hold.
//
// Extracted from `list-payable-positions.ts` (the original home, and still the
// file to read for how a caller uses this) so `list-upcoming-payouts.ts` gets
// the identical degradation posture rather than a second hand-maintained copy
// of it. Deliberately NOT extracted with it: the payout-ELIGIBILITY verdict.
// That is the payout batch's §3 rule set, only one caller evaluates it, and
// folding it in here would put batch policy inside a naming helper. The
// capability fields it needs ride out on `ResolvedPayeeSubject` instead, so
// the caller computes the verdict itself with no extra read.
// ─────────────────────────────────────────────────────────────────────────────

export type PayeeSubjectKind = "ORGANIZATION" | "HUMAN";

export type PayeeOwnerKey = `${PayeeSubjectKind}:${string}`;

/** Key for {@link ResolvedPayeeIdentities.labels}. */
export const payeeOwnerKey = (
  subjectType: PayeeSubjectKind,
  subjectId: string,
): PayeeOwnerKey => `${subjectType}:${subjectId}`;

/**
 * The `Payee` row, narrowed to what the money views read: who owns the cell,
 * plus the two Connect capability fields the payout batch's eligibility gate
 * keys on.
 */
export type ResolvedPayeeSubject = {
  subjectType: PayeeSubjectKind;
  subjectId: string;
  stripeAccountId: string | null;
  payoutsEnabled: boolean;
};

/** Display naming for one owner. `slug` is organisation-only. */
export type PayeeOwnerNaming = {
  label: string | null;
  slug: string | null;
};

export type ResolvePayeeIdentitiesDeps = {
  repos: Pick<Repos, "payees" | "organizations" | "humans">;
  logger?: LoggerPort;
  /** Reports the best-effort lookup failure. See the file header. */
  reportError?: ReporterPort;
};

/**
 * Caller-supplied naming for the swallow's telemetry, so each view's log line
 * and Sentry tags stay its own.
 */
export type PayeeIdentityTelemetry = {
  /** `logger.error` event name. */
  logEvent: string;
  /** Sentry `tags.useCase`. */
  useCase: string;
  /** Sentry `tags.step`. */
  step: string;
};

export type ResolvedPayeeIdentities = {
  /**
   * False when the Payee read itself failed, so the subject type, the labels
   * AND anything derived from the capability fields are UNKNOWN rather than
   * absent. A label-only failure leaves this TRUE — see the file header.
   */
  identityResolved: boolean;
  /** payeeId → subject. Missing key = no `Payee` row for that id. */
  subjects: Map<string, ResolvedPayeeSubject>;
  /** owner key → naming. Missing key = the org/human lookup missed or failed. */
  labels: Map<PayeeOwnerKey, PayeeOwnerNaming>;
};

/**
 * Resolve who each payee is, and what to call them. Never throws: every
 * failure path returns a partially-populated result and reports the swallow.
 */
export async function resolvePayeeIdentities(
  deps: ResolvePayeeIdentitiesDeps,
  payeeIds: string[],
  telemetry: PayeeIdentityTelemetry,
): Promise<ResolvedPayeeIdentities> {
  const subjects = new Map<string, ResolvedPayeeSubject>();
  const labels = new Map<PayeeOwnerKey, PayeeOwnerNaming>();
  let identityResolved = false;

  try {
    const uniqueIds = [...new Set(payeeIds)];
    const payees =
      uniqueIds.length > 0 ? await deps.repos.payees.getByIds(uniqueIds) : [];
    for (const payee of payees) {
      subjects.set(payee.id, {
        subjectType: payee.subjectType,
        subjectId: payee.subjectId,
        stripeAccountId: payee.stripeAccountId,
        payoutsEnabled: payee.payoutsEnabled,
      });
    }
    // The Payee read has landed. Everything below is naming only, so a
    // failure past this point must NOT retract the subjects we now hold.
    identityResolved = true;

    const orgIds = [
      ...new Set(
        [...subjects.values()]
          .filter((s) => s.subjectType === "ORGANIZATION")
          .map((s) => s.subjectId),
      ),
    ];
    const humanIds = [
      ...new Set(
        [...subjects.values()]
          .filter((s) => s.subjectType === "HUMAN")
          .map((s) => s.subjectId),
      ),
    ];
    const [orgs, humans] = await Promise.all([
      orgIds.length > 0 ? deps.repos.organizations.getByIds(orgIds) : [],
      humanIds.length > 0 ? deps.repos.humans.getByIds(humanIds) : [],
    ]);
    for (const org of orgs) {
      labels.set(payeeOwnerKey("ORGANIZATION", org.id), {
        label: org.name || org.slug || null,
        slug: org.slug || null,
      });
    }
    for (const human of humans) {
      labels.set(payeeOwnerKey("HUMAN", human.id), {
        label: human.name ?? null,
        slug: null,
      });
    }
  } catch (err) {
    deps.logger?.error(telemetry.logEvent, { err });
    // GUARDED: a MISSING or THROWING reporter must never change behaviour
    // (ReporterPort convention, CLAUDE.md).
    try {
      deps.reportError?.(err, {
        tags: { useCase: telemetry.useCase, step: telemetry.step },
      });
    } catch {
      // Reporting is fire-and-forget.
    }
  }

  return { identityResolved, subjects, labels };
}

/**
 * Naming for one payee, or `undefined` when the subject or the label is
 * unknown. Callers coalesce to null — never to a guessed name.
 */
export function ownerNamingFor(
  identities: ResolvedPayeeIdentities,
  payeeId: string,
): PayeeOwnerNaming | undefined {
  const subject = identities.subjects.get(payeeId);
  if (!subject) return undefined;
  return identities.labels.get(
    payeeOwnerKey(subject.subjectType, subject.subjectId),
  );
}

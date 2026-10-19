/**
 * A payee named on a deal, by the platform entity it pays (the editor's
 * vocabulary — `upsertBookingAgreementLine` uses the same ref). Resolved to a
 * Payee row inside the write's transaction; a payee without Stripe yet is
 * created PENDING, as for any payout line while drafting.
 */
import { z } from "zod";

import type { TxRepos } from "@th/ports/repos";
import { fail } from "@th/errors";

import { payeeRefToSubjectType } from "../../booking-agreements/_shared/agreement-lines";

export const dealPayeeRefSchema = z
  .object({
    kind: z.enum(["human", "org"]),
    id: z.uuid(),
  })
  .strict();
export type DealPayeeRef = z.infer<typeof dealPayeeRefSchema>;

export const payeeRefKey = (ref: DealPayeeRef): string => `${ref.kind}:${ref.id}`;

/**
 * Resolve every ref to a payee id — one subject check and one upsert per
 * DISTINCT ref. Refuses refs to humans / orgs that do not exist, so a typo'd
 * id can never mint a Payee row.
 */
export async function resolveDealPayeeRefs(
  tx: Pick<TxRepos, "humans" | "organizations" | "payees">,
  refs: readonly DealPayeeRef[],
): Promise<Map<string, string>> {
  const unique = new Map<string, DealPayeeRef>();
  for (const ref of refs) unique.set(payeeRefKey(ref), ref);

  const humanIds = [...unique.values()].filter((r) => r.kind === "human").map((r) => r.id);
  if (humanIds.length > 0) {
    const found = new Set((await tx.humans.getByIds(humanIds)).map((h) => h.id));
    if (humanIds.some((id) => !found.has(id))) {
      throw fail("HUMAN_NOT_FOUND", { meta: { role: "payee" } });
    }
  }
  for (const ref of unique.values()) {
    if (ref.kind !== "org") continue;
    const org = await tx.organizations.getById(ref.id);
    if (!org) throw fail("ORGANIZATION_NOT_FOUND", { meta: { role: "payee" } });
  }

  const out = new Map<string, string>();
  for (const [key, ref] of unique) {
    const payee = await tx.payees.upsertForSubject({
      subjectType: payeeRefToSubjectType(ref.kind),
      subjectId: ref.id,
    });
    out.set(key, payee.id);
  }
  return out;
}

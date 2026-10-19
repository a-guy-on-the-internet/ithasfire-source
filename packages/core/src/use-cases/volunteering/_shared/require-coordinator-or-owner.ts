import { isAppError } from "@th/errors";
import type { TxRepos } from "@th/ports/repos";
import type {
  VolunteerAskRecord,
  VolunteerGroupRecord,
} from "@th/ports/repos/volunteering";

import { ensureEmailVerified } from "../../_helpers/ensure-email-verified";
import { resolveAskOwnership } from "./resolve-ask-ownership";

/**
 * The coordinator leg needs a VERIFIED email (B2, account squatting through
 * guest checkout). An owner can assign a coordinator by email, which
 * resolves BY EMAIL to whatever account holds that address, possibly an
 * unverified one someone else opened. The assignment stands; the seat opens
 * once the account proves the inbox (email code or magic link, which runs
 * the unproven-account sweep). Owners are unaffected.
 *
 * Call it only AFTER the actor has matched as the coordinator, so a stranger
 * still gets the uniform ownership denial. Throws `{ code: "forbidden",
 * message: "email_verification_required" }`; a failed lookup propagates.
 */
export async function ensureCoordinatorEmailVerified(
  tx: Pick<TxRepos, "humans">,
  actorHumanId: string,
): Promise<void> {
  await ensureEmailVerified(tx, actorHumanId);
}

/**
 * Which capacity granted access. Callers audit-log this so a coordinator
 * action is always distinguishable from an owner action after the fact.
 */
export type CoordinatorOrOwnerAccess = {
  via: "owner" | "coordinator";
  /** The coordinated group, loaded fresh in this tx. Null for owners. */
  group: VolunteerGroupRecord | null;
};

/**
 * Denial codes `resolveAskOwnership` throws when the actor merely LACKS
 * access (vs. structural errors like a dangling subject row — those must
 * propagate untouched, never be masked as "try coordinator instead").
 * Shared with every "owner denied → try the coordinator leg" gate
 * (e.g. assign-signup-to-group) so the two sets can never drift.
 */
export const OWNERSHIP_DENIAL_CODES: ReadonlySet<string> = new Set([
  "INSUFFICIENT_ROLE",
  "NOT_RESOURCE_OWNER",
]);

/**
 * THE trust gate for volunteer-signup actions (generic-volunteering-asks
 * spec, `authz.coordinator_scope` + NFR-002). The actor qualifies when:
 *
 * - (a) they own the ask's subject (`resolveAskOwnership` — the A3 owner
 *   gate), or
 * - (b) they are the assigned coordinator of THE GROUP THE TARGET SIGNUP
 *   BELONGS TO. The group row is loaded fresh inside the same `repos.tx()`
 *   as the mutation (NFR-002) — a just-revoked coordinator can never act on
 *   a stale grant.
 *
 * Pool / unassigned signups (`signupGroupId: null`) are owner-only: a
 * coordinator cannot review/check-in what isn't in their group yet
 * (pulling FROM the pool is `assign-signup-to-group`'s own rule, not this
 * gate). A coordinator acting on another group's signup gets the SAME
 * forbidden error as any non-owner (spec acceptance criterion: `forbidden`,
 * not 404) — deliberately indistinguishable from "no access at all", so the
 * gate can't be used as a which-group-is-that-signup-in oracle.
 *
 * Per the spec authz table, coordinator scope is granted here ONLY for
 * signup-level actions. Ask/role/group management and coordinator
 * assignment never call this helper — they gate on `resolveAskOwnership`
 * directly.
 */
export async function requireCoordinatorOrOwner(
  tx: TxRepos,
  target: { ask: VolunteerAskRecord; signupGroupId: string | null },
  actorHumanId: string,
): Promise<CoordinatorOrOwnerAccess> {
  try {
    await resolveAskOwnership(tx, target.ask, actorHumanId);
    return { via: "owner", group: null };
  } catch (error) {
    if (!(isAppError(error) && OWNERSHIP_DENIAL_CODES.has(error.code))) {
      // Structural failure (subject row gone, event not org-owned, …) —
      // propagate; it is not a "maybe coordinator" situation.
      throw error;
    }

    // Unassigned / pool signup → owner only.
    if (!target.signupGroupId) throw error;

    const group = await tx.volunteering.getGroup(target.signupGroupId);
    if (
      group &&
      group.askId === target.ask.id &&
      group.coordinatorHumanId !== null &&
      group.coordinatorHumanId === actorHumanId
    ) {
      await ensureCoordinatorEmailVerified(tx, actorHumanId);
      return { via: "coordinator", group };
    }

    // Cross-group coordinator or plain stranger: rethrow the ORIGINAL
    // ownership denial so both cases are uniformly `forbidden`.
    throw error;
  }
}

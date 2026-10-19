import type { TxRepos } from "@th/ports/repos";
import type { BookingRequestActRecord } from "@th/ports/repos/booking-requests";

import { ORG_EDIT_ROLES } from "../../../lib/rbac";

// ─────────────────────────────────────────────────────────────────────────────
// Who answers for a TAGGED act (lineup-booking-requests v3, L17).
//
// A tagged PERSON answers for themselves: their row is addressed by the
// owner key (request + "human" + the actor), never by an act id.
//
// A tagged GROUP is answered by any member holding an org edit role
// (ORG_EDIT_ROLES) — the same bar that lets them send a request as that
// group, and the members its notices reach (`listOrgEditMembers`). The row
// is still addressed by its owner key (request + "organization" + the
// group), so the actor can only reach groups they were proven to edit.
//
// Everything here reads; the callers decide what "no identity" means (the
// answer and the invite read both turn it into the uniform
// BOOKING_REQUEST_NOT_FOUND, the thread into NOT_RESOURCE_OWNER).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ids among `orgIds` where `actorHumanId` holds an org EDIT role. ONE
 * batched membership read; none at all when `orgIds` is empty.
 */
export async function orgsActorEdits(
  repos: Pick<TxRepos, "authz">,
  actorHumanId: string,
  orgIds: readonly string[],
): Promise<Set<string>> {
  const unique = [...new Set(orgIds)];
  if (unique.length === 0) return new Set();
  const memberships = await repos.authz.getOrgMemberships({
    orgIds: unique,
    humanId: actorHumanId,
  });
  return new Set(
    memberships
      .filter(
        (membership) =>
          membership.humanId === actorHumanId &&
          unique.includes(membership.orgId) &&
          ORG_EDIT_ROLES.includes(membership.role),
      )
      .map((membership) => membership.orgId),
  );
}

/**
 * Does the actor answer for this group? One membership read (the single-org
 * form of {@link orgsActorEdits}, for the answer mutation, which names the
 * group it answers as).
 */
export async function actorEditsOrg(
  repos: Pick<TxRepos, "authz">,
  actorHumanId: string,
  orgId: string,
): Promise<boolean> {
  return (await orgsActorEdits(repos, actorHumanId, [orgId])).has(orgId);
}

/**
 * The TAGGED rows of `bill` the actor answers for, in bill order: their own
 * person row, and every group row whose group they edit. `bill` is whatever
 * the caller read (live rows, normally) — this only filters it.
 */
export async function taggedActsActorAnswersFor(
  repos: Pick<TxRepos, "authz">,
  actorHumanId: string,
  bill: readonly BookingRequestActRecord[],
): Promise<BookingRequestActRecord[]> {
  const tagged = bill.filter(
    (act) => act.source === "TAGGED" && act.actOwnerId !== null,
  );
  const editable = await orgsActorEdits(
    repos,
    actorHumanId,
    tagged
      .filter((act) => act.actOwnerType === "organization")
      .map((act) => act.actOwnerId as string),
  );
  return tagged.filter((act) =>
    act.actOwnerType === "human"
      ? act.actOwnerId === actorHumanId
      : editable.has(act.actOwnerId as string),
  );
}

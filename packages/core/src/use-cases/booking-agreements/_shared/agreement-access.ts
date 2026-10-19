import type { OrgRole } from "@th/ports/repos/authz";
import type { AgreementRecord } from "@th/ports/repos/agreements";

import { ORG_EDIT_ROLES, type OrgMembershipLookup } from "../../../lib/rbac";
import { fail } from "@th/errors";

export type AgreementSide = "proposer" | "counterparty";

export type AgreementParty = {
  type: "human" | "organization";
  id: string;
};

export type AgreementPartyContext = {
  /** Which side of the agreement the actor controls. */
  side: AgreementSide;
  via: "human" | "org";
  /** The actor's role on the owning org (null for human parties). */
  orgRole: OrgRole | null;
};

export type AgreementPartyRef = Pick<
  AgreementRecord,
  "proposerType" | "proposerId" | "counterpartyType" | "counterpartyId"
>;

export function partyOnSide(
  agreement: AgreementPartyRef,
  side: AgreementSide,
): AgreementParty {
  return side === "proposer"
    ? { type: agreement.proposerType, id: agreement.proposerId }
    : { type: agreement.counterpartyType, id: agreement.counterpartyId };
}

export function otherSide(side: AgreementSide): AgreementSide {
  return side === "proposer" ? "counterparty" : "proposer";
}

/**
 * Party-based authz for the two-party booking Agreement.
 *
 * - Human party: exact `actorHumanId` match.
 * - Org party: membership in the org with a role in `orgRoles`
 *   (defaults to ORG_EDIT_ROLES — mutations are edit-level actions;
 *   pass ORG_ANY_ROLE for read paths).
 *
 * Returns which side the actor controls. When `side` is `"any"` (default)
 * the proposer side is checked first; an actor who somehow controls both
 * sides resolves as the proposer.
 *
 * @throws `{ code: "forbidden", message: "not_agreement_party" }` when the
 *   actor controls neither requested side (including org members whose role
 *   is below `orgRoles`).
 */
export async function requireAgreementParty(
  repos: OrgMembershipLookup,
  input: {
    agreement: AgreementPartyRef;
    actorHumanId: string;
    side?: AgreementSide | "any";
    orgRoles?: readonly OrgRole[];
  },
): Promise<AgreementPartyContext> {
  const roles = input.orgRoles ?? ORG_EDIT_ROLES;
  const sides: AgreementSide[] =
    input.side === undefined || input.side === "any"
      ? ["proposer", "counterparty"]
      : [input.side];

  for (const side of sides) {
    const party = partyOnSide(input.agreement, side);

    if (party.type === "human") {
      if (party.id === input.actorHumanId) {
        return { side, via: "human", orgRole: null };
      }
      continue;
    }

    const membership = await repos.authz.getOrgMembership({
      orgId: party.id,
      humanId: input.actorHumanId,
    });
    if (membership && roles.includes(membership.role)) {
      return { side, via: "org", orgRole: membership.role };
    }
  }

  throw fail("NOT_AGREEMENT_PARTY");
}

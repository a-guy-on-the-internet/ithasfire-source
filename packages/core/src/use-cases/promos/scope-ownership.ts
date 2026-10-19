import type { Repos } from "@th/ports/repos";
import type { PromoScope } from "@th/types";
import { fail } from "@th/errors";

type OwnerType = "HUMAN" | "ORGANIZATION";
type ScopeOwnershipMode = "create" | "mutate";

export async function ensurePromoScopeOwnedByOwner(params: {
  repos: Repos;
  ownerType: OwnerType;
  ownerId: string;
  scope: PromoScope;
  scopeId: string | null | undefined;
  mode: ScopeOwnershipMode;
}): Promise<void> {
  const { repos, ownerType, ownerId, scope, scopeId, mode } = params;

  if (!scopeId) {
    throw fail("SCOPE_REQUIRES_SCOPE_ID");
  }

  if (scope === "ORG") {
    // ORG is the org-wide "self" scope: only an ORGANIZATION owner may hold
    // it, and its scopeId must be that org. (Previously the ownerType check
    // was missing, which let HUMAN owners create ORG-scoped promos carrying
    // their humanId — dead codes that never matched any event at checkout.)
    if (ownerType !== "ORGANIZATION" || scopeId !== ownerId) {
      throw fail("PROMO_NOT_OWNED");
    }
    return;
  }

  if (scope === "HUMAN") {
    // HUMAN is the seller-wide "self" scope for direct sellers: only a HUMAN
    // owner may hold it, and its scopeId must be that human.
    if (ownerType !== "HUMAN" || scopeId !== ownerId) {
      throw fail("PROMO_NOT_OWNED");
    }
    return;
  }

  if (scope === "EVENT") {
    const event = await repos.events.getById(scopeId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    // Payee precedence: orgId wins over humanId everywhere money is
    // concerned (see deriveChargebackTermsRiskOwner). A HUMAN owner may
    // only claim EVENT scope on truly personal events (orgId = null) —
    // being listed as humanId on an org-owned event is not ownership.
    const eventOwnerId =
      ownerType === "ORGANIZATION"
        ? event.orgId
        : event.orgId == null
          ? event.humanId
          : null;
    if (eventOwnerId !== ownerId) {
      throw fail("PROMO_NOT_OWNED");
    }
    return;
  }

  if (scope === "TICKET_TYPE") {
    throw fail("TICKET_TYPE_SCOPE_UNSUPPORTED");
  }

  throw fail("PROMO_NOT_OWNED");
}

import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import { fail } from "@th/errors";
import { parseInput } from "../../lib/io";
import { ORG_FINANCE_ROLES, requireOwnerAccess } from "../../lib/rbac";
import { isClaimDeskStaff, requireClaimDeskStaff } from "./claim-desk-staff";
import {
  claimantClaimRecordSchema,
  claimRecordSchema,
  loadRefundedOrderIds,
  respondentClaimRecordSchema,
  serializeClaimantClaimRecord,
  serializeClaimRecord,
  serializeRespondentClaimRecord,
} from "./get-claim";

// ── Schemas ────────────────────────────────────────────────────────────────

export const listClaimsInputSchema = z.object({
  /** Injected by the transport from the session — never client-supplied. */
  actorHumanId: z.string().uuid(),
  eventId: z.string().uuid().optional(),
  claimantId: z.string().uuid().optional(),
  /**
   * Narrows the `claimantId` branch to one of the buyer's orders (the order
   * page). Only valid together with `claimantId` (and not with `eventId` /
   * `respondentId`, which take priority); refused as `invalid_input`
   * otherwise. The `claimantId` branch's own authorization still applies.
   */
  orderId: z.string().uuid().optional(),
  respondentId: z.string().uuid().optional(),
  status: z
    .array(z.enum(["open", "under_review", "approved", "denied", "expired"]))
    .optional(),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(100).default(25),
});

/**
 * `full` for claim-desk staff and the event owner's finance roles; the buyer
 * listing their own claims gets the `claimant` view (no seller or staff
 * identity, no raw evidence).
 */
export const listClaimsOutputSchema = z.object({
  items: z.array(
    z.discriminatedUnion("view", [claimRecordSchema, claimantClaimRecordSchema]),
  ),
  total: z.number().int().nonnegative(),
});

export type ListClaimsInput = z.infer<typeof listClaimsInputSchema>;
export type ListClaimsOutput = z.infer<typeof listClaimsOutputSchema>;

/** The seller's own claims (`claims.listMy`): always the respondent view. */
export const listMyClaimsInputSchema = z.object({
  /** Injected by the transport from the session — never client-supplied. */
  actorHumanId: z.string().uuid(),
  status: listClaimsInputSchema.shape.status,
  offset: listClaimsInputSchema.shape.offset,
  limit: listClaimsInputSchema.shape.limit,
});

export const listMyClaimsOutputSchema = z.object({
  items: z.array(respondentClaimRecordSchema),
  total: z.number().int().nonnegative(),
});

export type ListMyClaimsInput = z.infer<typeof listMyClaimsInputSchema>;
export type ListMyClaimsOutput = z.infer<typeof listMyClaimsOutputSchema>;

export type ListMyClaimsDeps = {
  repos: Pick<Repos, "claims">;
};

export type ListClaimsDeps = {
  repos: Pick<Repos, "claims" | "events" | "authz">;
  authz: Pick<AuthZPort, "hasStaffRole">;
};

// ── Use case ───────────────────────────────────────────────────────────────

/**
 * List resale claims. Authorization is decided per filter branch, INSIDE the
 * use case (the gate lives with the data — `claims.*` is mounted at the root
 * router, not under `platform.*`, so nothing upstream checks a role):
 *
 *  - no filter (platform-wide, `listAll`)  → claim-desk staff only.
 *  - `eventId`                             → claim-desk staff, OR an
 *    edit/finance member of the event's owning org (a human-owned event: that
 *    human). This is the org admin's "Claims" tab on `/admin/[slug]/resale`.
 *  - `claimantId` (+ optional `orderId`)    → that human themself (claimant
 *    view unless they are staff), OR claim-desk staff (full view).
 *  - `respondentId`                         → claim-desk staff only. A seller
 *    reads their own claims through {@link listMyClaims} (`claims.listMy`),
 *    which returns the respondent view without the buyer's identity.
 *
 * Every refused path throws BEFORE any claims repo method is called.
 */
export async function listClaims(
  deps: ListClaimsDeps,
  rawInput: unknown,
): Promise<ListClaimsOutput> {
  const input = parseInput(listClaimsInputSchema, rawInput);

  if (
    input.orderId &&
    (!input.claimantId || input.eventId || input.respondentId)
  ) {
    throw {
      code: "invalid_input",
      message: "orderId is only valid with claimantId",
    } as const;
  }

  let result;
  let claimantView = false;
  if (input.eventId) {
    await requireEventClaimsAccess(deps, input.actorHumanId, input.eventId);
    result = await deps.repos.claims.listByEvent({
      eventId: input.eventId,
      status: input.status,
      limit: input.limit,
      offset: input.offset,
    });
  } else if (input.respondentId) {
    // Staff only, even for the seller's own id: this path returns the FULL
    // record (buyer identity, raw evidence). Sellers use listMyClaims.
    await requireClaimDeskStaff(deps, input.actorHumanId);
    result = await deps.repos.claims.listByRespondent(input.respondentId, {
      status: input.status,
      limit: input.limit,
      offset: input.offset,
    });
  } else if (input.claimantId) {
    if (input.claimantId !== input.actorHumanId) {
      await requireClaimDeskStaff(deps, input.actorHumanId);
    } else {
      // The buyer's own list: the claimant view unless they are staff.
      claimantView = !(await isClaimDeskStaff(deps, input.actorHumanId));
    }
    result = await deps.repos.claims.listByClaimant(input.claimantId, {
      orderId: input.orderId,
      limit: input.limit,
      offset: input.offset,
    });
  } else {
    // Platform-wide: every claim on the platform (the /platform/claims desk).
    await requireClaimDeskStaff(deps, input.actorHumanId);
    result = await deps.repos.claims.listAll({
      status: input.status,
      limit: input.limit,
      offset: input.offset,
    });
  }

  const refundedOrderIds = await loadRefundedOrderIds(
    deps.repos.claims,
    result.items,
  );
  return {
    items: result.items.map((claim) =>
      claimantView
        ? serializeClaimantClaimRecord(claim, refundedOrderIds)
        : serializeClaimRecord(claim, refundedOrderIds),
    ),
    total: result.pageInfo.total,
  };
}

/**
 * The session actor's claims as seller (respondent), in the respondent view:
 * no buyer identity, no buyer order ids, no raw evidence. Self-scoped by
 * construction (the respondent IS the actor), so no role check.
 */
export async function listMyClaims(
  deps: ListMyClaimsDeps,
  rawInput: unknown,
): Promise<ListMyClaimsOutput> {
  const input = parseInput(listMyClaimsInputSchema, rawInput);
  const result = await deps.repos.claims.listByRespondent(input.actorHumanId, {
    status: input.status,
    limit: input.limit,
    offset: input.offset,
  });
  const refundedOrderIds = await loadRefundedOrderIds(
    deps.repos.claims,
    result.items,
  );
  return {
    items: result.items.map((claim) =>
      serializeRespondentClaimRecord(claim, refundedOrderIds),
    ),
    total: result.pageInfo.total,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Staff first (no org lookup needed), else the event owner's FINANCE roles
 * (OWNER / ADMIN / FINANCE) — a claim row is a buyer-vs-seller money dispute
 * (amounts, evidence, resolution) that the org can only read, never act on,
 * so it sits with the org's other money reads (`orgQuoteItemRefund`, payouts)
 * rather than with the door list an EDITOR runs. Owner resolution mirrors
 * `attendee-reviews/list-event-feedback.ts`: org wins over a direct human
 * owner; an ownerless (community) event has nobody who may read its claims.
 */
async function requireEventClaimsAccess(
  deps: ListClaimsDeps,
  actorHumanId: string,
  eventId: string,
): Promise<void> {
  if (await isClaimDeskStaff(deps, actorHumanId)) {
    return;
  }

  const event = await deps.repos.events.getById(eventId);
  if (!event) {
    throw fail("EVENT_NOT_FOUND");
  }

  if (event.orgId) {
    await requireOwnerAccess({
      repos: deps.repos,
      ownerType: "ORGANIZATION",
      ownerId: event.orgId,
      actorHumanId,
      roles: ORG_FINANCE_ROLES,
    });
  } else if (event.humanId) {
    await requireOwnerAccess({
      repos: deps.repos,
      ownerType: "HUMAN",
      ownerId: event.humanId,
      actorHumanId,
      roles: ORG_FINANCE_ROLES,
    });
  } else {
    throw fail("NOT_RESOURCE_OWNER");
  }
}

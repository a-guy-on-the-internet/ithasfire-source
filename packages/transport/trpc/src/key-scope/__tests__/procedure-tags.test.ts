import { describe, expect, it } from "vitest";

import {
  apiKeyGateNoActor,
  apiKeyGateWithActor,
  authedProcedure,
  optionalProcedure,
  proc,
  publicProcedure,
  requireAuth,
  router,
} from "../../init";
import { appRouter } from "../../router";
import {
  KEY_DENYLISTED_PATHS,
  KEY_DENYLISTED_PREFIXES,
  isKeyDenylisted,
} from "../denylist";
import { KEY_GUARDED_INPUT_FIELDS } from "../input-guard";
import { keyTagProblems, type KeyProcedureTag, type ProcedureMeta } from "../meta";

// NFR-002: every tRPC procedure, enumerated. Fails when a procedure tagged for
// keys sits on the FR-008 denylist (apiKeys.renewSelf aside), when a mutation
// is tagged read-level, when a tag is malformed, and when a procedure is
// built outside the gated chains.

type ProcDef = {
  _def: {
    type: "query" | "mutation" | "subscription";
    meta?: ProcedureMeta;
    middlewares: unknown[];
    inputs?: unknown[];
  };
};

const proceduresOf = (r: { _def: { procedures: object } }) =>
  Object.entries(r._def.procedures as Record<string, ProcDef>);

/** Every key-tag problem in a router, one line per problem. */
function auditKeyTags(r: { _def: { procedures: object } }): string[] {
  return proceduresOf(r).flatMap(([path, p]) =>
    keyTagProblems({
      path,
      type: p._def.type,
      tag: p._def.meta?.key,
      isDenylisted: isKeyDenylisted,
    }),
  );
}

const GATE_FNS = [
  ...(apiKeyGateNoActor as unknown as { _middlewares: unknown[] })._middlewares,
  ...(apiKeyGateWithActor as unknown as { _middlewares: unknown[] })._middlewares,
];
const isGated = (p: ProcDef) =>
  p._def.middlewares.some((mw) => GATE_FNS.includes(mw));
const REQUIRE_AUTH_FNS = (requireAuth as unknown as { _middlewares: unknown[] })
  ._middlewares;
/** Built on `authedProcedure` (requires an actor; PLATFORM_WIDE has none). */
const isAuthed = (p: ProcDef) =>
  p._def.middlewares.some((mw) => REQUIRE_AUTH_FNS.includes(mw));

/**
 * Built on the bare `proc`, so the key gate never runs: a key reaches them as
 * no credential at all. Each reads no identity. Adding to this list needs a
 * reviewer: a procedure here is outside default deny.
 */
const UNGATED_ALLOWLIST = new Set(["health", "features.getFeatureGates"]);

/**
 * Names that look like FR-008's classes (money, credentials, members and
 * roles, deletion) but were READ and judged not denylisted on 2026-10-13.
 * A new procedure whose name matches SENSITIVE_NAME must land here or on the
 * denylist, so the list cannot silently go stale. Default deny still applies:
 * being here does not make a procedure callable by keys.
 */
const SENSITIVE_NAME =
  /refund|payout|stripe|cash|debt|credit|password|passkey|apikey|secondfactor|totp|twofactor|authaccount|role|delegate|ownership|deleteorg|deletemyaccount|deletehuman|member|invitation|feewaiver|settle|portalsession|connectiontoken|feedtoken|scantoken|webhook|dispute|chargeback|transfer|payment|checkout|grant|coordinator|moderator|reader|sale|cancel|claim|verification|pushdevice|createorg|deal|agreement|resale|sheet|split|payee|payoutterms|migrate|promo|\bcomp\b|price|tickettype|discount|tax|reward|benefit|tier/i;

const REVIEWED_NOT_DENYLISTED = new Set([
  // Event gate passwords (a visitor unlocking an event), not account credentials.
  "events.validatePassword",
  "events.recordSignedPasswordUnlock",
  // Reads of money: quotes, eligibility, statements, summaries. Nothing moves.
  "agreements.getDefaultPayoutTerms",
  "orders.quoteFullRefund",
  "orders.getRefundEligibility",
  "orders.quoteItemRefund",
  "orders.orgQuoteItemRefund",
  "orders.getOwnerPayoutSummary",
  "settlements.get",
  "settlements.listForOrg",
  "platform.listSettlements",
  "platform.listFeeWaivers",
  "platform.listMembershipStandings",
  "platform.listPayoutHistory",
  "platform.listUpcomingPayouts",
  "platform.listPayeeDebtPositions",
  "platform.listUnrecoveredCashDebts",
  "platform.listMembershipPositions",
  "platform.listWebhookDlq",
  "credits.listMine",
  "pos.cashTillReport",
  "pos.eventCashSales",
  "payoutTerms.getPayoutLineForAck",
  "deals.getEventSettlement",
  "deals.exportEventSettlementCsv",
  // freeze-the-deal FR-007: the history of a frozen deal's changes (a read).
  "deals.listDealChanges",
  // Reads of members and invitations (no change to membership).
  "orgs.listMembers",
  "orgs.previewInvitation",
  "orgs.listInvitations",
  // A place ownership dispute is a claim filed with staff, not a chargeback.
  "places.filePlaceOwnershipDispute",
  // Volunteer shift roles (jobs at an event), not access roles.
  "volunteer.roles.create",
  "volunteer.roles.createFromTemplates",
  "volunteer.roles.update",
  "volunteer.roles.delete",
  "volunteer.roles.list",
  "volunteer.publicRoles.list",
  "volunteer.publicRoles.waiver",
  "volunteer.askRoles.add",
  "volunteer.askRoles.update",
  // Booking holds settle DATES on a calendar, not money.
  "bookingHolds.settle",
  // Membership reads. Tier and benefit writes are prices and discounts (R33)
  // and starting, cancelling and the billing portal move money: all
  // denylisted.
  "embeds.getMembershipWidget",
  "memberships.tiers.list",
  "memberships.tiers.listPublic",
  "memberships.mine.list",
  "memberships.memberBlocks",
  // ── Added 2026-10-13 with the wider SENSITIVE_NAME ──
  // Price, fee and tax reads for a checkout; no order is created.
  "events.getCheckoutFeeRates",
  "events.estimateCheckoutTax",
  "orgs.getOrganizationResalePolicy",
  "resale.listMyListings",
  "resale.listEventListings",
  "resale.getListing",
  "resale.estimateListing",
  // Transfer reads (who can receive, what is pending). The transfers
  // themselves are denylisted (R32).
  "humans.searchTransferRecipients",
  "tickets.getPendingTransfers",
  // Place verification and claims: submitting evidence, the staff workflow
  // around it, and reads. The DECISION that hands a place to an org
  // (`*.reviewPlaceVerification`, `platform.updatePlaceVerificationStatus`)
  // is denylisted, and so is `places.submitPlaceClaim` (R34c: it can
  // auto-verify). `submitPlaceVerification` only moves the place to PENDING
  // for staff. `confirmClaimEmailChallenge` only marks the emailed code
  // verified (evidence for the claim), it grants nothing.
  "places.requestVerificationDocUpload",
  "places.submitPlaceVerification",
  "places.getVerificationDocumentUrl",
  "places.acknowledgePlaceVerification",
  "places.withdrawPlaceVerification",
  "places.releasePlaceVerification",
  "places.getPlatformVerificationQueue",
  "places.requestClaimDocUpload",
  "places.requestClaimEmailChallenge",
  "places.confirmClaimEmailChallenge",
  "places.getPlaceClaimEligibility",
  "places.listMyPlaceClaims",
  "platform.getVerificationRequest",
  // Community listings carry no tickets: calling off a date and RSVPs move
  // no money. Applying to moderate is a request; the grant is denylisted.
  "community.cancelEventDate",
  "community.cancelDateRsvp",
  "community.cancelRsvp",
  "community.applyToBeModerator",
  "community.checkModeratorAccess",
  "moderatorApplications.list",
  // Resale claims: filing, responding and reads. Upholding one refunds and
  // is denylisted (`claims.review`).
  "claims.create",
  "claims.respond",
  "claims.list",
  "claims.listMy",
  "claims.get",
  // Volunteer shift scheduling and the roster read.
  "volunteer.roster.coordinator",
  "volunteer.schedule.cancelOccurrence",
  "volunteer.schedule.claim",
  "volunteer.schedule.withdrawClaim",
  // Door-sale reads and the reader list (no reader is changed).
  "pos.listReaders",
  "pos.listSellableItems",
  "pos.quoteCart",
  // Claiming an open booking request for one's own calendar.
  "bookingRequests.claim",
  // Deal and agreement reads and projections (nothing agreed). Minting the
  // event from an agreement finalizes it and is denylisted (R32).
  "bookingAgreements.get",
  "bookingAgreements.listMine",
  // ── Added 2026-10-13 with R33 (price writes) and the payout-split names ──
  // Price, ticket-type, split, promo, comp and reward reads; nothing changes.
  "events.listTicketTypesForEdit",
  "events.listEventSeatPriceOverridesForEdit",
  "events.listEventTicketTypes",
  "events.ticketTiersForCard",
  "events.getEventSplits",
  "ticketTypeTemplates.listTicketTypeTemplates",
  "splits.listForOrder",
  "search.tieredPopularEvents",
  "platform.taxNexusRollup",
  "platform.listPromos",
  "promos.list",
  "promos.preview",
  "comp.list",
  "volunteer.rewards.ledger",
  "volunteer.rewards.list",
  // Ticket-type templates: a saved price list that sells nothing until it is
  // APPLIED to an event, and applying is denylisted (R33). Orchestrator
  // reading, 10-13: the owner may move these onto the denylist too.
  "ticketTypeTemplates.createTicketTypeTemplate",
  "ticketTypeTemplates.archiveTicketTypeTemplate",
  "ticketTypeTemplates.forkPlatformTemplate",
  "deals.getAgreementDeal",
  "deals.projectAgreementDeal",
  "deals.getTermsDeal",
  "deals.projectTermsDeal",
  "deals.getResaleClause",
]);


/**
 * Every procedure tagged for ORG, PERSONAL or STAFF keys, with HOW its use
 * case authorises the caller. The gate narrows the authz port and
 * `repos.authz` (and every `repos.tx`); it cannot narrow an authorisation
 * made any other way. Before adding a row, read the procedure AND its use
 * case and check each item:
 *
 * - Org and staff roles are read only through `ctx.authz` or `repos.authz`
 *   (rbac.ts helpers included), never `Human.roles` or another repo.
 * - Owner equality (`requireOwnerAccess`'s HUMAN branch,
 *   `actorHumanId === ownerId`) is a PERSONAL-subject check: an ORG or STAFF
 *   tag on such a procedure lets the key act on the holder's personal
 *   resources too.
 * - Exclusion probes: a refused answer turns an exclude-if-role check
 *   ("staff may not apply to moderate") into a pass. Never tag a procedure
 *   whose role probe EXCLUDES the caller.
 * - `canEditEvent` / `canManagePlace` are refused under ORG keys (their org
 *   is resolved out of the wrapper's sight): such a procedure fails closed
 *   for ORG keys until the port reports the org it resolved.
 * - Delegations and place booking grants are PERSONAL-subject authority.
 *   The gate refuses `humanDelegates.getDelegation` /
 *   `listPrincipalsForDelegate` under every key and
 *   `placeBookingGrants.findActiveForActor` / `listActiveForActor` under
 *   every key but PERSONAL (`resolve-ask-ownership.ts`, `place-access.ts`
 *   `findPlaceBookerGrant` / `listPlaceBookerGrants`). A procedure whose ONLY path is a
 *   delegation fails closed for keys; check it does not then fall through to
 *   a weaker check.
 * - Actor equality the gate cannot narrow: `getPlaceAccessContext()
 *   .verifiedHumanOwnerIds.includes(actor)` (`ensure-place-owner-access.ts`),
 *   `place.humanIdsWithAccess` (`place-access.ts`), the HUMAN branch of
 *   `resolveAskOwnership` (`actorHumanId === subjectId`), and the group
 *   coordinator leg (`require-coordinator-or-owner.ts`: the actor IS the
 *   assigned coordinator). All of these are PERSONAL-subject checks; an ORG
 *   or STAFF tag on such a procedure lets the key reach the holder's own
 *   places, asks and groups.
 * - Repo SQL that scopes by JOINING membership (a list "for this human"
 *   whose query joins `OrgMembership` / `PlaceOwnership`, rather than taking
 *   an org id the wrapper checked) returns every org the holder belongs to.
 *   An ORG tag needs the org filtered to `key.orgId` in the use case first.
 * - The key's holder id must come from ctx, never from input.
 *
 * Empty until plan step 5 tags the first procedure.
 */
const TAGGED_AUTHORIZATION: Record<string, string> = {};

describe("NFR-002: key tags across every procedure", () => {
  const all = proceduresOf(appRouter);

  it("enumerates the whole app router", () => {
    expect(all.length).toBeGreaterThan(700);
  });

  it("has no key-tag problem anywhere (denylist, read-level mutation, malformed tag)", () => {
    expect(auditKeyTags(appRouter)).toEqual([]);
  });

  it("runs the key gate on every procedure outside the bare-proc allowlist", () => {
    const ungated = all
      .filter(([, p]) => !isGated(p))
      .map(([path]) => path)
      .sort();
    expect(ungated).toEqual([...UNGATED_ALLOWLIST].sort());
  });

  it("tags nothing on the bare-proc allowlist", () => {
    for (const [path, p] of all) {
      if (UNGATED_ALLOWLIST.has(path)) expect(p._def.meta?.key).toBeUndefined();
    }
  });

  it("names only procedures that exist on the denylist (no stale entries)", () => {
    const paths = new Set(all.map(([path]) => path));
    expect([...KEY_DENYLISTED_PATHS].filter((p) => !paths.has(p))).toEqual([]);
    for (const prefix of KEY_DENYLISTED_PREFIXES) {
      expect(
        all.some(([path]) => path.startsWith(prefix)),
        `prefix ${prefix} matches nothing`,
      ).toBe(true);
    }
  });

  it("classifies every sensitive-looking procedure: denylisted or reviewed", () => {
    const unclassified = all
      .map(([path]) => path)
      .filter(
        (path) =>
          SENSITIVE_NAME.test(path) &&
          !isKeyDenylisted(path) &&
          !REVIEWED_NOT_DENYLISTED.has(path),
      );
    expect(unclassified).toEqual([]);
    const paths = new Set(all.map(([path]) => path));
    expect([...REVIEWED_NOT_DENYLISTED].filter((p) => !paths.has(p))).toEqual([]);
    expect([...REVIEWED_NOT_DENYLISTED].filter(isKeyDenylisted)).toEqual([]);
  });

  it("records how every ORG / PERSONAL / STAFF-tagged procedure authorises", () => {
    const needsRow = all
      .filter(([, p]) => {
        const tag = p._def.meta?.key;
        return (
          !!tag &&
          !("selfRenewal" in tag) &&
          tag.subjects.some((s) => s !== "PLATFORM_WIDE")
        );
      })
      .map(([path]) => path);
    expect(needsRow.filter((path) => !(path in TAGGED_AUTHORIZATION))).toEqual([]);
    // No stale rows.
    expect(
      Object.keys(TAGGED_AUTHORIZATION).filter((p) => !needsRow.includes(p)),
    ).toEqual([]);
  });

  it("tags PLATFORM_WIDE only on public or optional procedures (it has no actor)", () => {
    const bad = all
      .filter(([, p]) => {
        const tag = p._def.meta?.key;
        return (
          !!tag &&
          !("selfRenewal" in tag) &&
          tag.subjects.includes("PLATFORM_WIDE") &&
          isAuthed(p)
        );
      })
      .map(([path]) => path);
    expect(bad).toEqual([]);
  });

  it("puts the selfRenewal tag only on a procedure that needs no session actor", () => {
    const bad = all
      .filter(([, p]) => {
        const tag = p._def.meta?.key;
        return !!tag && "selfRenewal" in tag && isAuthed(p);
      })
      .map(([path]) => path);
    expect(bad).toEqual([]);
  });

  it("guards input fields only on live, non-denylisted procedures that accept them (R34a)", () => {
    const byPath = new Map(all);
    const problems = Object.entries(KEY_GUARDED_INPUT_FIELDS).flatMap(
      ([path, fields]) => {
        const proc = byPath.get(path);
        if (!proc) return [`${path}: no such procedure`];
        if (isKeyDenylisted(path)) return [`${path}: denylisted whole, drop it here`];
        // The field must be a key of the procedure's (object) input schema,
        // or the guard watches a name the procedure never reads.
        const shapes = (proc._def.inputs ?? []).map(
          (i) => (i as { shape?: Record<string, unknown> }).shape ?? {},
        );
        return fields
          .filter((f) => !shapes.some((shape) => Object.hasOwn(shape, f)))
          .map((f) => `${path}: input has no field ${f}`);
      },
    );
    expect(problems).toEqual([]);
  });

  it("reports how many procedures accept keys today", () => {
    const tagged = all.filter(([, p]) => p._def.meta?.key).map(([path]) => path);
    // Step 4 tags nothing: every scoped key is refused everywhere until step 5
    // tags the MCP's procedures. Update this when tagging starts.
    expect(tagged).toEqual([]);
  });
});

describe("NFR-002: the audit fails where it must", () => {
  const tag = (t: KeyProcedureTag) => ({ key: t });

  it("flags a denylisted procedure that carries a key tag", () => {
    const r = router({
      orgs: router({
        deleteOrg: authedProcedure
          .meta(tag({ permission: "orgs.deleteOrg", subjects: ["ORG"], level: "READ_WRITE" }))
          .mutation(() => null),
      }),
      payouts: router({
        getOverview: authedProcedure
          .meta(tag({ permission: "payouts.getOverview", subjects: ["ORG"], level: "READ" }))
          .query(() => null),
      }),
    });
    expect(auditKeyTags(r)).toEqual([
      "orgs.deleteOrg: denylisted (FR-008) but tagged for keys",
      "payouts.getOverview: denylisted (FR-008) but tagged for keys",
    ]);
  });

  it("flags a mutation tagged read-level, a write tag on PLATFORM_WIDE, and a bad permission", () => {
    const r = router({
      orders: router({
        cancel: authedProcedure
          .meta(tag({ permission: "orders.cancel", subjects: ["ORG"], level: "READ" }))
          .mutation(() => null),
        note: authedProcedure
          .meta(
            tag({
              permission: "orders.note",
              subjects: ["PLATFORM_WIDE"],
              level: "READ_WRITE",
            }),
          )
          .mutation(() => null),
        list: authedProcedure
          .meta(tag({ permission: "list", subjects: ["ORG"], level: "READ" }))
          .query(() => null),
      }),
    });
    expect(auditKeyTags(r)).toEqual([
      "orders.cancel: a mutation tagged READ; needs READ_WRITE",
      "orders.note: PLATFORM_WIDE is read-only (R19)",
      'orders.list: permission must look like "router.action" (NFR-005)',
    ]);
  });

  it("flags selfRenewal anywhere but apiKeys.renewSelf, and allows it there", () => {
    const r = router({
      apiKeys: router({
        renewSelf: authedProcedure.meta(tag({ selfRenewal: true })).mutation(() => null),
        collect: authedProcedure.meta(tag({ selfRenewal: true })).mutation(() => null),
      }),
    });
    expect(auditKeyTags(r)).toEqual([
      "apiKeys.collect: only apiKeys.renewSelf may carry selfRenewal",
    ]);
  });

  it("tells an authed procedure from a public or optional one", () => {
    const r = router({
      x: router({
        a: authedProcedure.query(() => null),
        o: optionalProcedure.query(() => null),
        p: publicProcedure.query(() => null),
      }),
    });
    const authed = proceduresOf(r)
      .filter(([, p]) => isAuthed(p))
      .map(([path]) => path);
    expect(authed).toEqual(["x.a"]);
  });

  it("sees a procedure built on the bare proc as ungated", () => {
    const r = router({
      x: router({
        bare: proc.query(() => null),
        gated: publicProcedure.query(() => null),
      }),
    });
    const ungated = proceduresOf(r)
      .filter(([, p]) => !isGated(p))
      .map(([path]) => path);
    expect(ungated).toEqual(["x.bare"]);
  });
});

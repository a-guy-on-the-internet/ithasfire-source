import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PlaceRecord } from "@th/ports/repos/places";

import {
  planAgreementMint,
  type PlanAgreementMintArgs,
} from "../_shared/agreement-mint-plan";
import { assertBookingPreflight } from "../_shared/booking-preflight";
import { createFakePlaceBookingGrantsRepo } from "../../booking-holds/__tests__/fakes";
import {
  buildBookingRequestRecord,
  buildPlaceRecord,
} from "../../booking-requests/__tests__/helpers";
import { buildAgreementRecord } from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// planAgreementMint — the ONE place every refusal of the agreement mint lives
// (booking-the-night review round 6). The mint executes the plan; every
// booking path runs it read-only before it takes a line. Pinned here directly,
// rule by rule, not only through its callers.
// ─────────────────────────────────────────────────────────────────────────────

const PLACE = "33333333-3333-4333-8333-333333333333";
const VENUE_ORG = "22222222-2222-4222-8222-222222222222";
const STAFF = "23232323-2323-4323-8323-232323232323"; // ADMIN of VENUE_ORG
const OWNER = "31313131-3131-4131-8131-313131313131"; // direct owner of the place
const CO_OWNER = "32323232-3232-4323-8323-323232323232"; // a second direct owner
const STRANGER = "99999999-9999-4999-8999-999999999999";
const GRANTEE = "17171717-1717-4171-8171-171717171717";
const ACT = "11111111-1111-4111-8111-111111111111";
const ACT_ORG = "26262626-2626-4262-8262-262626262626";
const AGREEMENT = "55555555-5555-4555-8555-555555555555";
const OTHER_AGREEMENT = "5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b";
const ORIGIN = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
const DRAFT = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
const FINAL = "f1f1f1f1-f1f1-4f1f-8f1f-f1f1f1f1f1f1";
const CALENDAR = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TZ = "America/Chicago";
const NIGHT = "2026-07-17";
/** 20:00 CDT on NIGHT. */
const ON_NIGHT = new Date("2026-07-18T01:00:00.000Z");
const NEXT_DAY = new Date("2026-07-19T01:00:00.000Z");
const NOW = new Date("2026-07-01T12:00:00.000Z");
const UNLIMITED = { limitValue: BigInt("9007199254740991"), currentUsage: 0n };

type EventRow = { id: string; status: string; startsAt: Date; orgId?: string | null; humanId?: string | null };

function harness(options: { events?: EventRow[]; place?: Partial<PlaceRecord> } = {}) {
  const events = new Map((options.events ?? []).map((e) => [e.id, { orgId: null, humanId: ACT, ...e }]));
  const linkedByEvent = new Map<string, { id: string }>();
  const grants = createFakePlaceBookingGrantsRepo();
  const memberships: Record<string, string> = { [`${VENUE_ORG}:${STAFF}`]: "ADMIN" };
  const repos = {
    events: { getById: vi.fn(async (id: string) => events.get(id) ?? null) },
    authz: {
      getOrgMembership: vi.fn(async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
        const role = memberships[`${orgId}:${humanId}`];
        return role ? { orgId, humanId, role } : null;
      }),
      getOrgMemberships: vi.fn(async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        orgIds.map((orgId) => ({ orgId, humanId, role: memberships[`${orgId}:${humanId}`] })).filter((m) => m.role),
      ),
    },
    placeBookingGrants: grants,
    resourceQuotas: {
      getEffectiveQuota: vi.fn(async () => UNLIMITED),
      hasPendingExpansionRequest: vi.fn(async () => false),
    },
    agreements: { getByEventId: vi.fn(async (eventId: string) => linkedByEvent.get(eventId) ?? null) },
    humans: { getById: vi.fn(async (id: string) => ({ id })) },
    organizations: { getById: vi.fn(async (id: string) => ({ id })) },
  };
  const place = buildPlaceRecord({
    id: PLACE,
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [OWNER, CO_OWNER],
    timezone: TZ,
    ...options.place,
  });
  return { repos, place, grants, linkedByEvent, events };
}

function request(over: Partial<BookingRequestRecord> = {}): BookingRequestRecord {
  return buildBookingRequestRecord({
    placeId: PLACE,
    calendarId: CALENDAR,
    performerOwnerType: "human",
    performerOwnerId: ACT,
    status: "ACCEPTED",
    agreementId: AGREEMENT,
    preferredDates: [NIGHT],
    ...over,
  } as Partial<BookingRequestRecord>);
}

function terms(over: Partial<AgreementRecord> = {}): AgreementRecord {
  return buildAgreementRecord({
    id: AGREEMENT,
    status: "ACCEPTED",
    counterpartyType: "organization",
    counterpartyId: VENUE_ORG,
    proposedDate: ON_NIGHT,
    ...over,
  });
}

function plan(
  h: ReturnType<typeof harness>,
  over: Partial<PlanAgreementMintArgs> = {},
) {
  return planAgreementMint(h.repos as never, {
    mode: "manual",
    agreement: terms(),
    request: request(),
    place: h.place,
    calendarId: CALENDAR,
    nightDate: NIGHT,
    placeTz: TZ,
    side: "venue",
    ownerOverride: null,
    startNamed: true,
    actor: { humanId: STAFF, now: NOW },
    ...over,
  });
}

describe("planAgreementMint — the terms' status (review round 6 BLOCKING)", () => {
  it.each([["CANCELLED"], ["DECLINED"]])(
    "hold path, event-first: %s terms never LINK the origin → INVALID_STATUS agreement_terminal",
    async (status) => {
      const h = harness({ events: [{ id: ORIGIN, status: "DRAFT", startsAt: ON_NIGHT }] });
      await expect(
        plan(h, { mode: "hold", agreement: terms({ status: status as never }), request: request({ originEventId: ORIGIN }) }),
      ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "agreement_terminal", meta: { agreementId: AGREEMENT, status } });
    },
  );

  it("hold path: CANCELLED terms never hand back their live draft either (cancel calls it an orphan, never re-linked)", async () => {
    const h = harness({ events: [{ id: DRAFT, status: "DRAFT", startsAt: ON_NIGHT }] });
    await expect(
      plan(h, { mode: "hold", agreement: terms({ status: "CANCELLED", draftEventId: DRAFT }) }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "agreement_terminal" });
  });

  it.each([["DRAFT"], ["PROPOSED"], ["ACCEPTED"]])("hold path: %s terms link the origin", async (status) => {
    const h = harness({ events: [{ id: ORIGIN, status: "DRAFT", startsAt: ON_NIGHT }] });
    const result = await plan(h, {
      mode: "hold",
      agreement: terms({ status: status as never }),
      request: request({ originEventId: ORIGIN }),
    });
    expect(result).toMatchObject({ outcome: "link", finalize: false, event: { id: ORIGIN } });
  });

  it.each([["manual"], ["night"]] as const)("%s path: terms that are not ACCEPTED → AGREEMENT_NOT_ACCEPTED", async (mode) => {
    const h = harness();
    await expect(plan(h, { mode, agreement: terms({ status: "PROPOSED" }) })).rejects.toMatchObject({
      code: "AGREEMENT_NOT_ACCEPTED",
    });
  });

  it("a FINALIZED link is handed back whatever the terms' status (FULFILLED)", async () => {
    const h = harness({ events: [{ id: FINAL, status: "PUBLISHED", startsAt: ON_NIGHT, orgId: VENUE_ORG }] });
    const result = await plan(h, { agreement: terms({ status: "FULFILLED", eventId: FINAL }) });
    expect(result).toMatchObject({ outcome: "finalized", event: { id: FINAL } });
  });
});

describe("planAgreementMint — the request and its event", () => {
  it("an organizer-bound request → INVALID_STATUS organizer_agreement_event_creation_unsupported; no place → PLACE_NOT_FOUND", async () => {
    const h = harness();
    await expect(
      plan(h, { request: request({ direction: "TO_PERFORMER" } as never) }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", message: "organizer_agreement_event_creation_unsupported" });
    await expect(plan(h, { place: null })).rejects.toMatchObject({ code: "PLACE_NOT_FOUND" });
  });

  it("a dead origin refuses even beside a live draft: venue INVALID_STATUS event_first_origin_not_live; sender EVENT_FIRST_ORIGIN_GONE, no meta", async () => {
    const h = harness({
      events: [
        { id: ORIGIN, status: "CANCELLED", startsAt: ON_NIGHT },
        { id: DRAFT, status: "DRAFT", startsAt: ON_NIGHT },
      ],
    });
    const args = { agreement: terms({ draftEventId: DRAFT }), request: request({ originEventId: ORIGIN }) };
    await expect(plan(h, args)).rejects.toMatchObject({
      code: "INVALID_STATUS",
      message: "event_first_origin_not_live",
      meta: { eventId: ORIGIN },
    });
    const sender = await plan(h, { ...args, side: "sender", actor: null }).catch((e: unknown) => e);
    expect(sender).toMatchObject({ code: "EVENT_FIRST_ORIGIN_GONE" });
    expect((sender as { meta?: unknown }).meta).toBeUndefined();
  });

  it("a finalized link to a dead event → INVALID_STATUS linked_event_not_live (sender: LINKED_EVENT_NOT_LIVE)", async () => {
    const h = harness({ events: [{ id: FINAL, status: "ARCHIVED", startsAt: ON_NIGHT }] });
    await expect(plan(h, { agreement: terms({ eventId: FINAL }) })).rejects.toMatchObject({
      code: "INVALID_STATUS",
      message: "linked_event_not_live",
    });
    await expect(
      plan(h, { agreement: terms({ eventId: FINAL }), side: "sender", actor: null }),
    ).rejects.toMatchObject({ code: "LINKED_EVENT_NOT_LIVE" });
  });

  it("a live draft on another day than the night → HOLD_DATE_MISMATCHES_EVENT; with no night known, only liveness is asked", async () => {
    const h = harness({ events: [{ id: DRAFT, status: "DRAFT", startsAt: NEXT_DAY, orgId: VENUE_ORG }] });
    await expect(plan(h, { agreement: terms({ draftEventId: DRAFT }) })).rejects.toMatchObject({
      code: "HOLD_DATE_MISMATCHES_EVENT",
      meta: { eventId: DRAFT, eventDate: "2026-07-18", holdDate: NIGHT },
    });
    await expect(plan(h, { agreement: terms({ draftEventId: DRAFT }), nightDate: null })).resolves.toMatchObject({
      outcome: "draft",
    });
  });

  it("a dead (non-origin) draft anchor is passed over: a fresh save replaces it", async () => {
    const h = harness({ events: [{ id: DRAFT, status: "CANCELLED", startsAt: ON_NIGHT }] });
    await expect(plan(h, { agreement: terms({ draftEventId: DRAFT }) })).resolves.toMatchObject({
      outcome: "mint",
      deadDraftEventId: DRAFT,
    });
  });
});

describe("planAgreementMint — the owner side is the handed-back event's REAL owner (review round 5 W2)", () => {
  it("intent RENT, but the live draft is the VENUE's → venue-owned, finalized, so the counterparty gates apply", async () => {
    const h = harness({ events: [{ id: DRAFT, status: "DRAFT", startsAt: ON_NIGHT, orgId: VENUE_ORG, humanId: null }] });
    const result = await plan(h, { agreement: terms({ draftEventId: DRAFT }), request: request({ intent: "RENT" }) });
    expect(result).toMatchObject({ outcome: "draft", ownerSide: "place", finalize: true });
    await expect(
      plan(h, { agreement: terms({ draftEventId: DRAFT }), request: request({ intent: "RENT" }), actor: { humanId: OWNER, now: NOW } }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("intent PERFORM, but the live draft is the REQUESTER's → not finalized, and a co-owner who is not the counterparty is not refused", async () => {
    const h = harness({ events: [{ id: DRAFT, status: "DRAFT", startsAt: ON_NIGHT, orgId: null, humanId: ACT }] });
    const result = await plan(h, {
      agreement: terms({ draftEventId: DRAFT, counterpartyType: "human", counterpartyId: OWNER }),
      actor: { humanId: CO_OWNER, now: NOW },
    });
    expect(result).toMatchObject({ outcome: "draft", ownerSide: "requester", finalize: false });
  });
});

describe("planAgreementMint — the actor's gates", () => {
  it("no staff authority at the place → NOT_RESOURCE_OWNER, before the event is read", async () => {
    const h = harness();
    await expect(plan(h, { actor: { humanId: STRANGER, now: NOW } })).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(h.repos.events.getById).not.toHaveBeenCalled();
  });

  // holds-without-a-request FR-002: the staff gate has no grant arm. Was: a
  // grantee passed it, was refused only the venue-owned saves / links /
  // bookings (grant_cannot_mint_venue_owned), and could LINK a
  // requester-owned origin or replay a booked night. Every shape is now
  // refused at step 2, before the event is read.
  it("a booking grantee is refused at the staff gate whatever it would mint, link or hand back", async () => {
    const h = harness({
      events: [
        { id: ORIGIN, status: "DRAFT", startsAt: ON_NIGHT, orgId: null, humanId: ACT },
        { id: FINAL, status: "PUBLISHED", startsAt: ON_NIGHT, orgId: VENUE_ORG, humanId: null },
        { id: DRAFT, status: "DRAFT", startsAt: ON_NIGHT, orgId: VENUE_ORG, humanId: null },
      ],
    });
    h.grants.seed({ placeId: PLACE, humanId: GRANTEE });
    const grantee = { humanId: GRANTEE, now: NOW };
    const cases: Partial<PlanAgreementMintArgs>[] = [
      { actor: grantee },
      { request: request({ originEventId: ORIGIN }), actor: grantee },
      { mode: "hold", agreement: terms({ eventId: FINAL }), actor: grantee },
      { mode: "hold", agreement: terms({ status: "DRAFT", draftEventId: DRAFT }), actor: grantee },
    ];
    for (const over of cases) {
      await expect(plan(h, over)).rejects.toMatchObject({
        code: "NOT_RESOURCE_OWNER",
        meta: { entity: "place" },
      });
    }
    expect(h.repos.events.getById).not.toHaveBeenCalled();
  });

  it("a fallback day (date-less, nothing booked) is NOT a night a handed-back draft is checked against; it only anchors a fresh save", async () => {
    const h = harness({ events: [{ id: DRAFT, status: "DRAFT", startsAt: NEXT_DAY, orgId: VENUE_ORG }] });
    const dateless = terms({ proposedDate: null });
    await expect(
      plan(h, { agreement: { ...dateless, draftEventId: DRAFT }, nightDate: null, fallbackDay: NIGHT, startNamed: false }),
    ).resolves.toMatchObject({ outcome: "draft", event: { id: DRAFT } });
    await expect(
      plan(h, { agreement: dateless, nightDate: null, fallbackDay: NIGHT, startNamed: false }),
    ).resolves.toMatchObject({ outcome: "mint", defaultStartEntry: NIGHT });
  });

  it("a human venue counterparty who is not the actor → NOT_RESOURCE_OWNER agreement_counterparty (the save runs as the actor)", async () => {
    const h = harness();
    await expect(
      plan(h, {
        agreement: terms({ counterpartyType: "human", counterpartyId: OWNER }),
        actor: { humanId: CO_OWNER, now: NOW },
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER", meta: { entity: "agreement_counterparty", counterpartyId: OWNER } });
  });

  it("finalize's own gates: terms without payout terms → AGREEMENT_MISSING_PAYOUT_TERMS; a draft another agreement owns → event_already_has_agreement", async () => {
    const h = harness({ events: [{ id: DRAFT, status: "DRAFT", startsAt: ON_NIGHT, orgId: VENUE_ORG, humanId: null }] });
    await expect(plan(h, { agreement: terms({ payoutTermsId: null }) })).rejects.toMatchObject({
      code: "AGREEMENT_MISSING_PAYOUT_TERMS",
    });
    h.linkedByEvent.set(DRAFT, { id: OTHER_AGREEMENT });
    await expect(plan(h, { agreement: terms({ draftEventId: DRAFT }) })).rejects.toMatchObject({
      code: "event_already_has_agreement",
    });
  });

  it("the hold path never finalizes, so finalize's gates do not run there", async () => {
    const h = harness();
    await expect(plan(h, { mode: "hold", agreement: terms({ status: "DRAFT", payoutTermsId: null }) })).resolves.toMatchObject({
      outcome: "mint",
      finalize: false,
    });
  });

  it("the owning org's event quota: venue org at its limit → forbidden quota_exceeded; a requester org → quota_exceeded_for_requester", async () => {
    const h = harness();
    h.repos.resourceQuotas.getEffectiveQuota.mockResolvedValue({ limitValue: 2n, currentUsage: 2n });
    await expect(plan(h)).rejects.toMatchObject({ code: "forbidden", message: "quota_exceeded", meta: { subjectId: VENUE_ORG } });
    await expect(
      plan(h, {
        request: request({ intent: "RENT", performerOwnerType: "organization", performerOwnerId: ACT_ORG } as never),
      }),
    ).rejects.toMatchObject({ code: "forbidden", message: "quota_exceeded_for_requester", meta: { subjectId: ACT_ORG } });
  });

  it("a requester-owned save whose owner row is gone → HUMAN_NOT_FOUND", async () => {
    const h = harness();
    h.repos.humans.getById.mockResolvedValue(null as never);
    await expect(plan(h, { request: request({ intent: "USE" }) })).rejects.toMatchObject({ code: "HUMAN_NOT_FOUND" });
  });

  it("WITHOUT an actor (the agree's pre-flight) the actor's gates and the quota are not asked", async () => {
    const h = harness();
    h.repos.resourceQuotas.getEffectiveQuota.mockResolvedValue({ limitValue: 2n, currentUsage: 2n });
    await expect(plan(h, { mode: "night", actor: null })).resolves.toMatchObject({ outcome: "mint", authority: null });
    expect(h.repos.authz.getOrgMemberships).not.toHaveBeenCalled();
    expect(h.repos.resourceQuotas.getEffectiveQuota).not.toHaveBeenCalled();
  });
});

describe("planAgreementMint — a fresh save", () => {
  it("a suspended place takes no new event → PLACE_NOT_ACTIVE (a link saves nothing, so the plan alone lets it through)", async () => {
    const h = harness({
      place: { status: "SUSPENDED" } as never,
      events: [{ id: ORIGIN, status: "DRAFT", startsAt: ON_NIGHT }],
    });
    await expect(plan(h)).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
    await expect(plan(h, { request: request({ originEventId: ORIGIN }) })).resolves.toMatchObject({ outcome: "link" });
  });

  it("nothing names the start: the booked night's named slot, else the first preferred date — and none / an impossible day refuses", async () => {
    const h = harness();
    const dateless = terms({ proposedDate: null });
    await expect(
      plan(h, { agreement: dateless, startNamed: false, request: request({ preferredDates: ["2026-07-10", `${NIGHT}T21:30`] }) }),
    ).resolves.toMatchObject({ defaultStartEntry: `${NIGHT}T21:30` });
    await expect(
      plan(h, { agreement: dateless, startNamed: false, nightDate: null }),
    ).resolves.toMatchObject({ defaultStartEntry: NIGHT });
    await expect(
      plan(h, { agreement: dateless, startNamed: false, nightDate: null, request: request({ preferredDates: [] }) }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", meta: { reason: "booking_request_missing_preferred_dates" } });
    await expect(
      plan(h, { agreement: dateless, startNamed: false, nightDate: null, request: request({ preferredDates: ["2026-02-30"] }) }),
    ).rejects.toMatchObject({ code: "INVALID_STATUS", meta: { reason: "booking_request_invalid_preferred_date" } });
  });
});

describe("assertBookingPreflight — the plan plus the place rule a booking adds", () => {
  it("a suspended place books no night even when the mint would only link: venue PLACE_NOT_ACTIVE, sender PLACE_NOT_TAKING_BOOKINGS (no meta)", async () => {
    const h = harness({
      place: { status: "SUSPENDED" } as never,
      events: [{ id: ORIGIN, status: "DRAFT", startsAt: ON_NIGHT }],
    });
    const args: PlanAgreementMintArgs = {
      mode: "hold",
      agreement: terms(),
      request: request({ originEventId: ORIGIN }),
      place: h.place,
      calendarId: CALENDAR,
      nightDate: NIGHT,
      placeTz: TZ,
      side: "venue",
      ownerOverride: null,
      startNamed: true,
      actor: { humanId: STAFF, now: NOW },
    };
    await expect(assertBookingPreflight(h.repos as never, args)).rejects.toMatchObject({ code: "PLACE_NOT_ACTIVE" });
    const sender = await assertBookingPreflight(h.repos as never, { ...args, side: "sender", actor: null }).catch((e: unknown) => e);
    expect(sender).toMatchObject({ code: "PLACE_NOT_TAKING_BOOKINGS" });
    expect((sender as { meta?: unknown }).meta).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";

import { createTestLogger } from "@th/test-utils/fakes/logger";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { OrgMemberRecord } from "@th/types/repos/organizations";

import { renderNotification } from "../../comms/renderers";
import {
  buildBookingRequestRecord,
  buildPlaceRecord,
  PLACE_ID,
  REQUEST_ID,
} from "../../booking-requests/__tests__/helpers";
import type {
  BookingHoldNotificationIntent,
  BookingHoldStaffRecipientHint,
} from "../_shared/booking-hold-intents";
import {
  BOOKING_HOLD_VARIANTS,
  buildIdempotencyKey,
  dispatchBookingHoldIntents,
  type DispatchBookingHoldIntentsDeps,
} from "../notify-booking-hold-intents";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ACT_HUMAN_ID = "a0000000-0000-4000-8000-000000000001";
const ACT_ORG_ID = "a0000000-0000-4000-8000-000000000002";
const ACT_ORG_EDITOR_ID = "a0000000-0000-4000-8000-000000000003";
const ACT_ORG_VIEWER_ID = "a0000000-0000-4000-8000-000000000004";
const VENUE_ORG_ID = "b0000000-0000-4000-8000-000000000001";
const ASSIGNEE_ID = "b0000000-0000-4000-8000-000000000002";
const PLACER_ID = "b0000000-0000-4000-8000-000000000003";
const OTHER_EDITOR_ID = "b0000000-0000-4000-8000-000000000004";
const VENUE_VIEWER_ID = "b0000000-0000-4000-8000-000000000005";
const OUTSIDER_ID = "b0000000-0000-4000-8000-000000000006";
const HUMAN_OWNER_ID = "b0000000-0000-4000-8000-000000000007";
const OTHER_REQUEST_ID = "c0000000-0000-4000-8000-000000000001";
const HOLD_ID = "d0000000-0000-4000-8000-000000000001";
const OTHER_HOLD_ID = "d0000000-0000-4000-8000-000000000002";
const PUBLIC_APP_URL = "https://ithasfire.test/";
const RESPOND_BY = new Date("2026-08-06T23:00:00.000Z");

function member(humanId: string, role: OrgMemberRecord["role"]): OrgMemberRecord {
  return { humanId, name: null, email: null, role, joinedAt: new Date("2026-01-01T00:00:00.000Z") };
}

const VENUE_MEMBERS = [
  member(ASSIGNEE_ID, "ADMIN"),
  member(PLACER_ID, "EDITOR"),
  member(OTHER_EDITOR_ID, "EDITOR"),
  member(VENUE_VIEWER_ID, "VIEWER"),
];

function humanRequest(overrides: Partial<BookingRequestRecord> = {}): BookingRequestRecord {
  return buildBookingRequestRecord({
    performerOwnerType: "human",
    performerOwnerId: ACT_HUMAN_ID,
    actName: "The Fake Band",
    ...overrides,
  } as Partial<BookingRequestRecord>);
}

function orgRequest(id = REQUEST_ID): BookingRequestRecord {
  return buildBookingRequestRecord({
    id,
    performerOwnerType: "org",
    performerOwnerId: ACT_ORG_ID,
  } as Partial<BookingRequestRecord>);
}

function anonymousRequest(id = REQUEST_ID): BookingRequestRecord {
  return buildBookingRequestRecord({
    id,
    performerOwnerType: null,
    performerOwnerId: null,
    contactName: "Sam Torres",
    contactEmail: "sam@example.com",
    actName: null,
  } as unknown as Partial<BookingRequestRecord>);
}

function hint(overrides: Partial<BookingHoldStaffRecipientHint> = {}): BookingHoldStaffRecipientHint {
  return {
    assigneeHumanId: ASSIGNEE_ID,
    placedByHumanId: PLACER_ID,
    orgId: VENUE_ORG_ID,
    placeId: PLACE_ID,
    ...overrides,
  };
}

function intent(overrides: Partial<BookingHoldNotificationIntent> & Pick<BookingHoldNotificationIntent, "kind" | "audience">): BookingHoldNotificationIntent {
  return {
    bookingRequestId: REQUEST_ID,
    holdId: HOLD_ID,
    date: "2026-08-14",
    ...overrides,
  };
}

const staffOf = (assignee: string | null, placedBy = PLACER_ID) => ({
  assigneeHumanId: assignee,
  placedByHumanId: placedBy,
});

type BuildOptions = {
  requests?: Record<string, BookingRequestRecord | null>;
  membersByOrg?: Record<string, OrgMemberRecord[]>;
  place?: ReturnType<typeof buildPlaceRecord> | null;
  notifyImpl?: (input: unknown) => Promise<unknown>;
  publicAppUrl?: string | null;
  /** Event trace (repo lookups vs notify calls) for the ordering test. */
  trace?: string[];
};

function buildDeps(options: BuildOptions = {}) {
  const trace = options.trace ?? [];
  const mark = (label: string) => trace.push(label);
  const notify = vi.fn(async (input: unknown) => {
    mark("notify");
    return options.notifyImpl ? options.notifyImpl(input) : { ok: true };
  });
  const reportError = vi.fn();
  const place =
    options.place === undefined
      ? buildPlaceRecord({ name: "The Corner Stage", timezone: "America/Chicago", orgIdsWithAccess: [VENUE_ORG_ID], humanIdsWithAccess: [] })
      : options.place;
  const requests = options.requests ?? { [REQUEST_ID]: humanRequest() };
  const membersByOrg = options.membersByOrg ?? {
    [VENUE_ORG_ID]: VENUE_MEMBERS,
    [ACT_ORG_ID]: [member(ACT_ORG_EDITOR_ID, "EDITOR"), member(ACT_ORG_VIEWER_ID, "VIEWER")],
  };

  const repos = {
    bookingRequests: {
      getById: vi.fn(async (id: string) => {
        mark("repo");
        return requests[id] ?? null;
      }),
    },
    places: {
      getById: vi.fn(async (id: string) => {
        mark("repo");
        return place && id === place.id ? place : null;
      }),
    },
    organizations: {
      getById: vi.fn(async (id: string) => {
        mark("repo");
        return { id, name: id === ACT_ORG_ID ? "Band Org" : "Corner Collective", slug: id === ACT_ORG_ID ? "band-org" : "corner-collective" };
      }),
      listMembers: vi.fn(async ({ orgId, offset }: { orgId: string; offset: number }) => {
        mark("repo");
        const members = membersByOrg[orgId] ?? [];
        return { items: offset === 0 ? members : [], total: members.length };
      }),
    },
    humans: {
      getByIdWithIdentity: vi.fn(async (id: string) => {
        mark("repo");
        return { human: { id, name: "Owner" }, identity: { username: id === HUMAN_OWNER_ID ? "owner" : null } };
      }),
      getById: vi.fn(async (id: string) => {
        mark("repo");
        return { id, name: "Alice Act" };
      }),
    },
    entityPages: {
      getByOwner: vi.fn(async () => {
        mark("repo");
        return null;
      }),
    },
    performerBookingDefaults: {
      getByOwner: vi.fn(async () => {
        mark("repo");
        return { actName: "Band Org Live" };
      }),
    },
  } as unknown as DispatchBookingHoldIntentsDeps["repos"];

  const deps: DispatchBookingHoldIntentsDeps = {
    repos,
    notify: notify as unknown as DispatchBookingHoldIntentsDeps["notify"],
    logger: createTestLogger(),
    reportError,
    publicAppUrl: options.publicAppUrl === undefined ? PUBLIC_APP_URL : options.publicAppUrl,
  };
  return { deps, notify, reportError, trace };
}

type Call = { humanId: string; variant: string; idempotencyKey: string; payload: Record<string, unknown>; channels: Record<string, { enabled?: boolean }> };
const callsOf = (notify: ReturnType<typeof vi.fn>): Call[] =>
  notify.mock.calls.map((c) => c[0] as Call);

/** Every dispatched payload must render through the real registry. */
function expectRenderable(call: Call) {
  expect(() => renderNotification(call.variant, call.payload, { now: new Date() })).not.toThrow();
}

// ─────────────────────────────────────────────────────────────────────────────
// Act routing
// ─────────────────────────────────────────────────────────────────────────────

describe("dispatchBookingHoldIntents — act routing", () => {
  it("human-owned act → that human, with the sent-request link and a renderable payload", async () => {
    const { deps, notify } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [intent({ kind: "hold.placed", audience: "act", position: 2 })],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });

    const calls = callsOf(notify);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      humanId: ACT_HUMAN_ID,
      variant: BOOKING_HOLD_VARIANTS.placed,
      idempotencyKey: `booking-hold:${HOLD_ID}:hold.placed:act:${ACT_HUMAN_ID}`,
      channels: { sms: { enabled: false } },
    });
    expect(calls[0]!.payload).toEqual({
      bookingRequestId: REQUEST_ID,
      holdId: HOLD_ID,
      placeName: "The Corner Stage",
      date: "2026-08-14",
      timezone: "America/Chicago",
      targetUrl: "https://ithasfire.test/account/settings/booking-requests",
      position: 2,
    });
    expectRenderable(calls[0]!);
  });

  it("a batch digest is ONE send for the whole run — email + in-app, keyed on the hold SET", async () => {
    const { deps, notify } = buildDeps();
    const holdIds = [HOLD_ID, OTHER_HOLD_ID];
    await dispatchBookingHoldIntents(deps, {
      intents: [
        intent({
          kind: "hold.placed_batch",
          audience: "act",
          holdIds,
          dates: [
            { date: "2026-08-14", position: 1 },
            { date: "2026-08-21", position: 2 },
          ],
        }),
      ],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });

    const calls = callsOf(notify);
    // Two holds, ONE notification — the whole point of the digest.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      humanId: ACT_HUMAN_ID,
      variant: BOOKING_HOLD_VARIANTS.placedBatch,
      // Email stays on (only sms is disabled), same as `placed`.
      channels: { sms: { enabled: false } },
    });
    expect(calls[0]!.payload).toEqual({
      bookingRequestId: REQUEST_ID,
      holdId: HOLD_ID,
      placeName: "The Corner Stage",
      date: "2026-08-14",
      timezone: "America/Chicago",
      targetUrl: "https://ithasfire.test/account/settings/booking-requests",
      dates: [
        { date: "2026-08-14", position: 1 },
        { date: "2026-08-21", position: 2 },
      ],
    });
    // Hash over the sorted set, NOT the anchor hold id.
    expect(calls[0]!.idempotencyKey).toBe(
      buildIdempotencyKey(
        { holdId: OTHER_HOLD_ID, kind: "hold.placed_batch", audience: "act", holdIds: [...holdIds].reverse() },
        ACT_HUMAN_ID,
      ),
    );
    expectRenderable(calls[0]!);
  });

  it("a digest with fewer than two dates is dropped and reported — it has nothing to digest", async () => {
    const { deps, notify, reportError } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [
        intent({
          kind: "hold.placed_batch",
          audience: "act",
          holdIds: [HOLD_ID],
          dates: [{ date: "2026-08-14", position: 1 }],
        }),
      ],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalled();
  });

  it("a batch digest never reaches staff (act-only copy)", async () => {
    const { deps, notify } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [
        intent({
          kind: "hold.placed_batch",
          audience: "staff",
          staff: staffOf(ASSIGNEE_ID),
          holdIds: [HOLD_ID, OTHER_HOLD_ID],
          dates: [
            { date: "2026-08-14", position: 1 },
            { date: "2026-08-21", position: 2 },
          ],
        }),
      ],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("org-owned act → every edit-role member (viewer excluded) with the org bookings link", async () => {
    const { deps, notify } = buildDeps({ requests: { [REQUEST_ID]: orgRequest() } });
    await dispatchBookingHoldIntents(deps, {
      intents: [intent({ kind: "hold.confirmed", audience: "act" })],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });

    const calls = callsOf(notify);
    expect(calls.map((c) => c.humanId)).toEqual([ACT_ORG_EDITOR_ID]);
    expect(calls[0]!.payload.targetUrl).toBe("https://ithasfire.test/admin/band-org/bookings");
    expect(calls[0]!.variant).toBe(BOOKING_HOLD_VARIANTS.confirmed);
    expectRenderable(calls[0]!);
  });

  it("anonymous / unclaimed sender → skipped, nothing reported", async () => {
    const { deps, notify, reportError } = buildDeps({ requests: { [REQUEST_ID]: anonymousRequest() } });
    await dispatchBookingHoldIntents(deps, {
      intents: [intent({ kind: "hold.placed", audience: "act", position: 1 })],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });

  it("intents across several requests (confirm losers) resolve each request's own act", async () => {
    const { deps, notify } = buildDeps({
      requests: { [REQUEST_ID]: humanRequest(), [OTHER_REQUEST_ID]: orgRequest(OTHER_REQUEST_ID) },
    });
    await dispatchBookingHoldIntents(deps, {
      intents: [
        intent({ kind: "hold.confirmed", audience: "act" }),
        intent({ kind: "hold.lost_date", audience: "act", bookingRequestId: OTHER_REQUEST_ID, holdId: OTHER_HOLD_ID, reason: "CONFIRMED_OTHER" }),
      ],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });

    const calls = callsOf(notify);
    expect(calls.map((c) => [c.humanId, c.variant])).toEqual([
      [ACT_HUMAN_ID, BOOKING_HOLD_VARIANTS.confirmed],
      [ACT_ORG_EDITOR_ID, BOOKING_HOLD_VARIANTS.lostDate],
    ]);
    // The loser learns nothing about the winner.
    expect(JSON.stringify(calls[1]!.payload)).not.toContain(REQUEST_ID);
    expect(JSON.stringify(calls[1]!.payload)).not.toContain("Fake Band");
    calls.forEach(expectRenderable);
  });

  it("a request that vanished is logged and skipped; the others still go out", async () => {
    const { deps, notify } = buildDeps({
      requests: { [REQUEST_ID]: humanRequest(), [OTHER_REQUEST_ID]: null },
    });
    await dispatchBookingHoldIntents(deps, {
      intents: [
        intent({ kind: "hold.position_changed", audience: "act", bookingRequestId: OTHER_REQUEST_ID, holdId: OTHER_HOLD_ID, position: 1 }),
        intent({ kind: "hold.confirmed", audience: "act" }),
      ],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    expect(callsOf(notify).map((c) => c.variant)).toEqual([BOOKING_HOLD_VARIANTS.confirmed]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Staff routing (FR-016: assignee → placedBy → every edit-role member)
// ─────────────────────────────────────────────────────────────────────────────

describe("dispatchBookingHoldIntents — staff routing", () => {
  const staffIntent = (staff: BookingHoldNotificationIntent["staff"]) =>
    intent({ kind: "hold.expired", audience: "staff", staff });

  it("assignee wins when still an edit-role member", async () => {
    const { deps, notify } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [staffIntent(staffOf(ASSIGNEE_ID))],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    const calls = callsOf(notify);
    expect(calls.map((c) => c.humanId)).toEqual([ASSIGNEE_ID]);
    expect(calls[0]!.payload).toMatchObject({
      audience: "staff",
      actName: "The Fake Band",
      targetUrl: `https://ithasfire.test/admin/corner-collective/places/${PLACE_ID}/bookings`,
    });
    expectRenderable(calls[0]!);
  });

  it("falls back to placedBy when there is no assignee", async () => {
    const { deps, notify } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [staffIntent(staffOf(null))],
      hint: hint({ assigneeHumanId: null }),
      bookingRequestId: REQUEST_ID,
    });
    expect(callsOf(notify).map((c) => c.humanId)).toEqual([PLACER_ID]);
  });

  it("skips an assignee who left the org and a placer who is now a viewer", async () => {
    const { deps, notify } = buildDeps({
      membersByOrg: {
        [VENUE_ORG_ID]: [member(PLACER_ID, "VIEWER"), member(OTHER_EDITOR_ID, "EDITOR"), member(ASSIGNEE_ID, "ADMIN")],
      },
    });
    await dispatchBookingHoldIntents(deps, {
      intents: [staffIntent(staffOf(OUTSIDER_ID, PLACER_ID))],
      hint: hint({ assigneeHumanId: OUTSIDER_ID }),
      bookingRequestId: REQUEST_ID,
    });
    expect(callsOf(notify).map((c) => c.humanId).sort()).toEqual([ASSIGNEE_ID, OTHER_EDITOR_ID].sort());
  });

  it("every edit-role member when neither assignee nor placer is eligible (viewer excluded)", async () => {
    const { deps, notify } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [staffIntent(staffOf(null, OUTSIDER_ID))],
      hint: hint({ assigneeHumanId: null, placedByHumanId: OUTSIDER_ID }),
      bookingRequestId: REQUEST_ID,
    });
    expect(callsOf(notify).map((c) => c.humanId).sort()).toEqual([ASSIGNEE_ID, PLACER_ID, OTHER_EDITOR_ID].sort());
  });

  it("human-owned venue (orgId null): direct owners, with the @username admin slug", async () => {
    const { deps, notify } = buildDeps({
      place: buildPlaceRecord({ name: "Basement", humanIdsWithAccess: [HUMAN_OWNER_ID], orgIdsWithAccess: [] }),
    });
    await dispatchBookingHoldIntents(deps, {
      intents: [staffIntent(staffOf(null, HUMAN_OWNER_ID))],
      hint: hint({ assigneeHumanId: null, placedByHumanId: HUMAN_OWNER_ID, orgId: null }),
      bookingRequestId: REQUEST_ID,
    });
    const calls = callsOf(notify);
    expect(calls.map((c) => c.humanId)).toEqual([HUMAN_OWNER_ID]);
    expect(calls[0]!.payload.targetUrl).toBe(`https://ithasfire.test/admin/@owner/places/${PLACE_ID}/bookings`);
    expect(calls[0]!.payload.placeName).toBe("Basement");
  });

  it("zero staff recipients is reported (the venue side must never go silent)", async () => {
    const { deps, notify, reportError } = buildDeps({ membersByOrg: { [VENUE_ORG_ID]: [] } });
    await dispatchBookingHoldIntents(deps, {
      intents: [staffIntent(staffOf(null))],
      hint: hint({ assigneeHumanId: null }),
      bookingRequestId: REQUEST_ID,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a staff intent missing its routing hint is skipped, not thrown", async () => {
    const { deps, notify } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [intent({ kind: "hold.kept", audience: "staff" })],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it("staff act name falls back to the performer-name resolver for org acts, and the contact name for anonymous ones", async () => {
    const { deps, notify } = buildDeps({
      requests: { [REQUEST_ID]: orgRequest(), [OTHER_REQUEST_ID]: anonymousRequest(OTHER_REQUEST_ID) },
    });
    await dispatchBookingHoldIntents(deps, {
      intents: [
        staffIntent(staffOf(ASSIGNEE_ID)),
        intent({ kind: "hold.expired", audience: "staff", bookingRequestId: OTHER_REQUEST_ID, holdId: OTHER_HOLD_ID, staff: staffOf(ASSIGNEE_ID) }),
      ],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    const calls = callsOf(notify);
    expect(calls.map((c) => c.payload.actName)).toEqual(["Band Org Live", "Sam Torres"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Channel matrix
// ─────────────────────────────────────────────────────────────────────────────

describe("dispatchBookingHoldIntents — channel matrix", () => {
  const EMAIL_ON = { sms: { enabled: false } };
  const EMAIL_OFF = { sms: { enabled: false }, email: { enabled: false } };

  const cases: Array<[string, BookingHoldNotificationIntent, string, Record<string, unknown>]> = [
    ["act placed", intent({ kind: "hold.placed", audience: "act", position: 1 }), BOOKING_HOLD_VARIANTS.placed, EMAIL_ON],
    ["act moved to 1st", intent({ kind: "hold.position_changed", audience: "act", position: 1 }), BOOKING_HOLD_VARIANTS.positionChanged, EMAIL_ON],
    ["act moved to 3rd", intent({ kind: "hold.position_changed", audience: "act", position: 3 }), BOOKING_HOLD_VARIANTS.positionChanged, EMAIL_OFF],
    ["act challenged", intent({ kind: "hold.challenged", audience: "act", position: 1, respondBy: RESPOND_BY }), BOOKING_HOLD_VARIANTS.challenged, EMAIL_ON],
    ["act 2nd told of challenge", intent({ kind: "hold.challenged", audience: "act", position: 2, respondBy: RESPOND_BY }), BOOKING_HOLD_VARIANTS.challenged, EMAIL_ON],
    ["act extended", intent({ kind: "hold.challenge_extended", audience: "act", position: 1, respondBy: RESPOND_BY }), BOOKING_HOLD_VARIANTS.challengeExtended, EMAIL_ON],
    ["act 2nd told first stands", intent({ kind: "hold.kept", audience: "act", position: 2 }), BOOKING_HOLD_VARIANTS.challengeAnswered, EMAIL_OFF],
    ["act released (staff manual)", intent({ kind: "hold.released", audience: "act", reason: "MANUAL" }), BOOKING_HOLD_VARIANTS.released, EMAIL_ON],
    ["act released (request closed)", intent({ kind: "hold.released", audience: "act", reason: "REQUEST_CLOSED" }), BOOKING_HOLD_VARIANTS.released, EMAIL_ON],
    ["act released (event scheduled, FR-018)", intent({ kind: "hold.released", audience: "act", reason: "EVENT_SCHEDULED" }), BOOKING_HOLD_VARIANTS.released, EMAIL_ON],
    ["act lost date", intent({ kind: "hold.lost_date", audience: "act", reason: "CONFIRMED_OTHER" }), BOOKING_HOLD_VARIANTS.lostDate, EMAIL_ON],
    ["act confirmed", intent({ kind: "hold.confirmed", audience: "act" }), BOOKING_HOLD_VARIANTS.confirmed, EMAIL_ON],
    ["act expired", intent({ kind: "hold.expired", audience: "act" }), BOOKING_HOLD_VARIANTS.expired, EMAIL_ON],
    ["staff challenged", intent({ kind: "hold.challenged", audience: "staff", position: 1, respondBy: RESPOND_BY, staff: staffOf(ASSIGNEE_ID) }), BOOKING_HOLD_VARIANTS.challenged, EMAIL_OFF],
    ["staff kept", intent({ kind: "hold.kept", audience: "staff", position: 1, staff: staffOf(ASSIGNEE_ID) }), BOOKING_HOLD_VARIANTS.challengeAnswered, EMAIL_ON],
    ["staff released by act", intent({ kind: "hold.released", audience: "staff", reason: "MANUAL", staff: staffOf(ASSIGNEE_ID) }), BOOKING_HOLD_VARIANTS.challengeAnswered, EMAIL_ON],
    ["staff expired", intent({ kind: "hold.expired", audience: "staff", staff: staffOf(ASSIGNEE_ID) }), BOOKING_HOLD_VARIANTS.expired, EMAIL_ON],
    ["staff released (event scheduled, FR-018): in-app only", intent({ kind: "hold.released", audience: "staff", reason: "EVENT_SCHEDULED", staff: staffOf(ASSIGNEE_ID) }), BOOKING_HOLD_VARIANTS.released, EMAIL_OFF],
    // ── booking-the-night P2d-2 ── Keep = commit (FR-014).
    ["act challenged, Keep books", intent({ kind: "hold.challenged", audience: "act", position: 1, respondBy: RESPOND_BY, keepWill: "book_now" }), BOOKING_HOLD_VARIANTS.challenged, EMAIL_ON],
    ["staff kept, awaiting terms", intent({ kind: "hold.kept", audience: "staff", position: 1, respondBy: RESPOND_BY, awaitingTerms: true, staff: staffOf(ASSIGNEE_ID) }), BOOKING_HOLD_VARIANTS.challengeAnswered, EMAIL_ON],
    // Review W2: the keeper's own deadline notice — in-app + push only.
    ["act keeper, awaiting terms", intent({ kind: "hold.kept", audience: "act", position: 1, respondBy: RESPOND_BY, awaitingTerms: true }), BOOKING_HOLD_VARIANTS.challengeAnswered, EMAIL_OFF],
  ];

  it.each(cases)("%s", async (_label, one, variant, channels) => {
    const { deps, notify } = buildDeps();
    await dispatchBookingHoldIntents(deps, { intents: [one], hint: hint(), bookingRequestId: REQUEST_ID });
    const calls = callsOf(notify);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.variant).toBe(variant);
    expect(calls[0]!.channels).toEqual(channels);
    expectRenderable(calls[0]!);
    // Acts never receive a name (theirs or anyone else's) in the payload.
    if (one.audience === "act") expect("actName" in calls[0]!.payload).toBe(false);
  });

  it("staff-only kinds addressed to staff that have no staff copy are dropped (placed / confirmed / lost_date / position_changed)", async () => {
    const { deps, notify } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [
        intent({ kind: "hold.placed", audience: "staff", position: 1, staff: staffOf(ASSIGNEE_ID) }),
        intent({ kind: "hold.confirmed", audience: "staff", staff: staffOf(ASSIGNEE_ID) }),
        intent({ kind: "hold.lost_date", audience: "staff", staff: staffOf(ASSIGNEE_ID) }),
        intent({ kind: "hold.position_changed", audience: "staff", position: 1, staff: staffOf(ASSIGNEE_ID) }),
      ],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency keys
// ─────────────────────────────────────────────────────────────────────────────

// ── booking-the-night P2d-2 ──
describe("dispatchBookingHoldIntents — Keep = commit payloads (FR-014)", () => {
  it("the challenged act's payload carries keepWill; the position-2 act's never does", async () => {
    const { deps, notify } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [
        intent({ kind: "hold.challenged", audience: "act", position: 1, respondBy: RESPOND_BY, keepWill: "ask_for_terms" }),
        intent({ kind: "hold.challenged", audience: "act", position: 2, respondBy: RESPOND_BY, keepWill: "book_now" }),
      ],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    const calls = callsOf(notify as unknown as Parameters<typeof callsOf>[0]);
    expect(calls[0]!.payload).toMatchObject({ position: 1, keepWill: "ask_for_terms" });
    expect("keepWill" in calls[1]!.payload).toBe(false);
  });

  it("the staff 'kept — send terms' payload carries the act's deadline; a later challenge's keep is its own send", async () => {
    const { deps, notify } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [intent({ kind: "hold.kept", audience: "staff", position: 1, respondBy: RESPOND_BY, awaitingTerms: true, staff: staffOf(ASSIGNEE_ID) })],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    expect(callsOf(notify as unknown as Parameters<typeof callsOf>[0])[0]!.payload).toMatchObject({
      awaitingTerms: true,
      respondByISO: RESPOND_BY.toISOString(),
    });
    // The keeper's own notice carries the same absolute deadline; the
    // position-2 act's "first hold stands" carries none.
    const keeper = buildDeps();
    await dispatchBookingHoldIntents(keeper.deps, {
      intents: [
        intent({ kind: "hold.kept", audience: "act", position: 1, respondBy: RESPOND_BY, awaitingTerms: true }),
        intent({ kind: "hold.kept", audience: "act", position: 2, holdId: OTHER_HOLD_ID }),
      ],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    const keeperCalls = callsOf(keeper.notify as unknown as Parameters<typeof callsOf>[0]);
    expect(keeperCalls[0]!.payload).toMatchObject({ audience: "act", awaitingTerms: true, respondByISO: RESPOND_BY.toISOString() });
    expect("respondByISO" in keeperCalls[1]!.payload).toBe(false);
    const later = new Date(RESPOND_BY.getTime() + 86_400_000);
    expect(buildIdempotencyKey({ holdId: HOLD_ID, kind: "hold.kept", audience: "staff", respondBy: RESPOND_BY }, ASSIGNEE_ID)).not.toBe(
      buildIdempotencyKey({ holdId: HOLD_ID, kind: "hold.kept", audience: "staff", respondBy: later }, ASSIGNEE_ID),
    );
  });
});

describe("buildIdempotencyKey", () => {
  it("is {holdId}:{kind}:{audience}:{recipient} by default", () => {
    expect(buildIdempotencyKey({ holdId: HOLD_ID, kind: "hold.confirmed", audience: "act" }, ACT_HUMAN_ID)).toBe(
      `booking-hold:${HOLD_ID}:hold.confirmed:act:${ACT_HUMAN_ID}`,
    );
  });

  it("keeps the act and staff copies apart for a human who is both", () => {
    const act = buildIdempotencyKey({ holdId: HOLD_ID, kind: "hold.expired", audience: "act" }, ACT_HUMAN_ID);
    const staff = buildIdempotencyKey({ holdId: HOLD_ID, kind: "hold.expired", audience: "staff" }, ACT_HUMAN_ID);
    expect(act).not.toBe(staff);
    expect(staff).toBe(`booking-hold:${HOLD_ID}:hold.expired:staff:${ACT_HUMAN_ID}`);
  });

  it("appends the new position for position_changed", () => {
    expect(buildIdempotencyKey({ holdId: HOLD_ID, kind: "hold.position_changed", audience: "act", position: 2 }, ACT_HUMAN_ID)).toBe(
      `booking-hold:${HOLD_ID}:hold.position_changed:act:${ACT_HUMAN_ID}:2`,
    );
  });

  it("appends the deadline for challenged / extended so a re-challenge or second extension is a new send", () => {
    const later = new Date(RESPOND_BY.getTime() + 3_600_000);
    const first = buildIdempotencyKey({ holdId: HOLD_ID, kind: "hold.challenge_extended", audience: "act", respondBy: RESPOND_BY }, ACT_HUMAN_ID);
    const second = buildIdempotencyKey({ holdId: HOLD_ID, kind: "hold.challenge_extended", audience: "act", respondBy: later }, ACT_HUMAN_ID);
    expect(first).toBe(`booking-hold:${HOLD_ID}:hold.challenge_extended:act:${ACT_HUMAN_ID}:${RESPOND_BY.getTime()}`);
    expect(second).not.toBe(first);
    expect(buildIdempotencyKey({ holdId: HOLD_ID, kind: "hold.challenged", audience: "act", respondBy: RESPOND_BY }, ACT_HUMAN_ID)).toContain(
      `:${RESPOND_BY.getTime()}`,
    );
  });

  it("the dispatcher uses it per recipient", async () => {
    const { deps, notify } = buildDeps({ requests: { [REQUEST_ID]: orgRequest() } });
    await dispatchBookingHoldIntents(deps, {
      intents: [intent({ kind: "hold.position_changed", audience: "act", position: 1 })],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    expect(callsOf(notify)[0]!.idempotencyKey).toBe(
      `booking-hold:${HOLD_ID}:hold.position_changed:act:${ACT_ORG_EDITOR_ID}:1`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Failure posture
// ─────────────────────────────────────────────────────────────────────────────

describe("dispatchBookingHoldIntents — failure posture", () => {
  it("isolates a failing recipient: the rest still go out, the failure is logged + reported", async () => {
    let n = 0;
    const { deps, notify, reportError } = buildDeps({
      notifyImpl: async () => {
        n += 1;
        if (n === 1) throw new Error("mailer down");
        return { ok: true };
      },
    });
    await expect(
      dispatchBookingHoldIntents(deps, {
        intents: [
          intent({ kind: "hold.expired", audience: "act" }),
          intent({ kind: "hold.expired", audience: "staff", staff: staffOf(null, OUTSIDER_ID) }),
        ],
        hint: hint({ assigneeHumanId: null, placedByHumanId: OUTSIDER_ID }),
        bookingRequestId: REQUEST_ID,
      }),
    ).resolves.toBeUndefined();

    // 1 act + 3 staff (everyone) = 4 attempts despite the first throwing.
    expect(notify).toHaveBeenCalledTimes(4);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "dispatchBookingHoldIntents", variant: BOOKING_HOLD_VARIANTS.expired },
      extra: { humanId: ACT_HUMAN_ID },
    });
  });

  it("resolves every lookup BEFORE the first notify() call", async () => {
    const trace: string[] = [];
    const { deps, notify } = buildDeps({
      trace,
      requests: { [REQUEST_ID]: humanRequest(), [OTHER_REQUEST_ID]: orgRequest(OTHER_REQUEST_ID) },
    });
    await dispatchBookingHoldIntents(deps, {
      intents: [
        intent({ kind: "hold.confirmed", audience: "act" }),
        intent({ kind: "hold.expired", audience: "staff", staff: staffOf(ASSIGNEE_ID) }),
        intent({ kind: "hold.lost_date", audience: "act", bookingRequestId: OTHER_REQUEST_ID, holdId: OTHER_HOLD_ID }),
      ],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    expect(notify).toHaveBeenCalledTimes(3);
    const firstNotify = trace.indexOf("notify");
    expect(firstNotify).toBeGreaterThan(0);
    expect(trace.slice(firstNotify)).not.toContain("repo");
  });

  it("throws (for the caller's swallow) when publicAppUrl is missing", async () => {
    const { deps } = buildDeps({ publicAppUrl: "  " });
    await expect(
      dispatchBookingHoldIntents(deps, {
        intents: [intent({ kind: "hold.confirmed", audience: "act" })],
        hint: hint(),
        bookingRequestId: REQUEST_ID,
      }),
    ).rejects.toThrow(/publicAppUrl/);
  });

  it("a challenge intent without respondBy is reported, not silently dropped", async () => {
    const { deps, notify, reportError } = buildDeps();
    await dispatchBookingHoldIntents(deps, {
      intents: [intent({ kind: "hold.challenged", audience: "act", position: 1 })],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    expect(notify).not.toHaveBeenCalled();
    expect(reportError).toHaveBeenCalledTimes(1);
    expect((reportError.mock.calls[0]![0] as Error).message).toBe("booking_hold_notify_respond_by_missing");
  });

  it("no intents → no lookups, no sends, and no publicAppUrl complaint", async () => {
    const bare = buildDeps({ publicAppUrl: null });
    await expect(
      dispatchBookingHoldIntents(bare.deps, { intents: [], hint: hint(), bookingRequestId: REQUEST_ID }),
    ).resolves.toBeUndefined();
    const { deps, notify, trace } = buildDeps();
    await dispatchBookingHoldIntents(deps, { intents: [], hint: hint(), bookingRequestId: REQUEST_ID });
    expect(notify).not.toHaveBeenCalled();
    expect(trace).toEqual([]);
  });

  it("a missing place row degrades to the fallback name and platform zone", async () => {
    const { deps, notify } = buildDeps({ place: null });
    await dispatchBookingHoldIntents(deps, {
      intents: [intent({ kind: "hold.confirmed", audience: "act" })],
      hint: hint(),
      bookingRequestId: REQUEST_ID,
    });
    const call = callsOf(notify)[0]!;
    expect(call.payload.placeName).toBe("The place");
    expect(call.payload.timezone).toBe("America/Chicago");
    expectRenderable(call);
  });
});

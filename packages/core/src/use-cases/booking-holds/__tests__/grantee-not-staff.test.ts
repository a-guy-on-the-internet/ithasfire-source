import { describe, expect, it } from "vitest";

import { findPlaceBookerGrant } from "../../booking-requests/_shared/place-access";
import { bookNightWithoutTerms } from "../book-night-without-terms";
import { confirmBookingHold } from "../confirm-booking-hold";
import { extendBookingHoldChallenge } from "../extend-booking-hold-challenge";
import { placeBookingHold } from "../place-booking-hold";
import { releaseBookingHold } from "../release-booking-hold";
import { reorderBookingHold } from "../reorder-booking-hold";
import { settleBookingHolds } from "../settle-booking-holds";
import {
  ASSIGNEE_ID,
  CALENDAR_ID,
  DATE,
  NOW,
  ORG_ID,
  PLACE_ID,
  REQUEST_A,
  REQUEST_B,
  STAFF_ID,
  VIEWER_ID,
  buildHoldTestContext,
} from "./hold-test-context";

// ─────────────────────────────────────────────────────────────────────────────
// holds-without-a-request FR-002: the grant arm left the staff gate. Before,
// an active grant passed `requirePlaceBookingAuthority` as `via: "grant"`, so
// a grantee could reorder, extend, release ANOTHER's hold, place holds for an
// act's request, settle, confirm and book an act's night at the whole place.
// Every one of those is staff-only now. Each case below runs for the three
// ways an actor acts under a grant (H2): the person grantee, an edit-role
// delegate of that person, an edit-role member of a grantee org. Each fixture
// is first shown to be a REAL booker (the booker gate finds the grant), so a
// refusal is the staff gate's, not a broken fixture's.
// ─────────────────────────────────────────────────────────────────────────────

const BOOKER_ID = "15151515-1515-4151-8151-151515151515";
const DELEGATE_ID = "16161616-1616-4161-8161-161616161616";
const GRANTEE_ORG_ID = "23232323-2323-4232-8232-232323232323";
const GRANTEE_ORG_EDITOR_ID = "18181818-1818-4181-8181-181818181818";

type Grantee = "person" | "delegate" | "org member";
const GRANTEES: Grantee[] = ["person", "delegate", "org member"];

function build(grantee: Grantee) {
  const ctx = buildHoldTestContext({
    memberships: [
      { orgId: ORG_ID, humanId: STAFF_ID, role: "EDITOR" },
      { orgId: ORG_ID, humanId: ASSIGNEE_ID, role: "ADMIN" },
      { orgId: ORG_ID, humanId: VIEWER_ID, role: "VIEWER" },
      { orgId: GRANTEE_ORG_ID, humanId: GRANTEE_ORG_EDITOR_ID, role: "EDITOR" },
    ],
    delegations: [
      { principalId: BOOKER_ID, delegateId: DELEGATE_ID, role: "EDITOR" },
    ],
  });
  if (grantee === "org member") {
    ctx.placeBookingGrants.seed({
      placeId: PLACE_ID,
      grantee: { kind: "org", orgId: GRANTEE_ORG_ID },
    });
  } else {
    ctx.placeBookingGrants.seed({ placeId: PLACE_ID, humanId: BOOKER_ID });
  }
  const actor =
    grantee === "person"
      ? BOOKER_ID
      : grantee === "delegate"
        ? DELEGATE_ID
        : GRANTEE_ORG_EDITOR_ID;
  return { ctx, actor };
}

async function expectRealBooker(
  ctx: ReturnType<typeof buildHoldTestContext>,
  actor: string,
) {
  const found = await findPlaceBookerGrant(
    ctx.repos as never,
    ctx.place,
    actor,
    { calendarId: CALENDAR_ID, now: NOW },
  );
  expect(found).not.toBeNull();
}

const snapshot = (ctx: ReturnType<typeof buildHoldTestContext>) =>
  JSON.stringify([...ctx.bookingHolds.rows.values()]);

describe.each(GRANTEES)("a booking grantee (%s) is not staff", (grantee) => {
  it("is refused placing a hold for an act's request; nothing written", async () => {
    const { ctx, actor } = build(grantee);
    await expectRealBooker(ctx, actor);
    await expect(
      placeBookingHold(ctx.deps, {
        actorHumanId: actor,
        bookingRequestId: REQUEST_A,
        calendarId: CALENDAR_ID,
        date: DATE,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(ctx.bookingHolds.rows.size).toBe(0);
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("is refused reordering; the line is unchanged", async () => {
    const { ctx, actor } = build(grantee);
    await expectRealBooker(ctx, actor);
    ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);
    const before = snapshot(ctx);
    await expect(
      reorderBookingHold(ctx.deps, {
        actorHumanId: actor,
        holdId: b.id,
        toPosition: 1,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(snapshot(ctx)).toBe(before);
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("is refused extending a challenge", async () => {
    const { ctx, actor } = build(grantee);
    await expectRealBooker(ctx, actor);
    const respondBy = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    const a = ctx.seedHold(REQUEST_A, { status: "CHALLENGED", respondBy });
    ctx.seedHold(REQUEST_B);
    const before = snapshot(ctx);
    await expect(
      extendBookingHoldChallenge(ctx.deps, {
        actorHumanId: actor,
        holdId: a.id,
        respondBy: new Date(respondBy.getTime() + 60 * 60 * 1000),
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(snapshot(ctx)).toBe(before);
  });

  it("is refused releasing ANOTHER's hold (an act's, and a place hold)", async () => {
    const { ctx, actor } = build(grantee);
    await expectRealBooker(ctx, actor);
    const actHold = ctx.seedHold(REQUEST_A);
    const placeHold = ctx.bookingHolds.seed({
      ownerKind: "PLACE",
      holder: null,
      calendarId: CALENDAR_ID,
      date: DATE,
      placedByHumanId: STAFF_ID,
    });
    const before = snapshot(ctx);
    for (const holdId of [actHold.id, placeHold.id]) {
      await expect(
        releaseBookingHold(ctx.deps, { actorHumanId: actor, holdId }),
      ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    }
    expect(snapshot(ctx)).toBe(before);
    expect(ctx.audit.log).not.toHaveBeenCalled();
  });

  it("is refused settling a request's holds", async () => {
    const { ctx, actor } = build(grantee);
    await expectRealBooker(ctx, actor);
    ctx.seedHold(REQUEST_A);
    await expect(
      settleBookingHolds(ctx.deps, {
        actorHumanId: actor,
        bookingRequestId: REQUEST_A,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("is refused confirming an act's hold (the gate runs before the retirement)", async () => {
    const { ctx, actor } = build(grantee);
    await expectRealBooker(ctx, actor);
    const a = ctx.seedHold(REQUEST_A);
    await expect(
      confirmBookingHold(ctx.deps, { actorHumanId: actor, holdId: a.id }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("is refused booking an act's night (book without terms → the accept mint); nothing written", async () => {
    const { ctx, actor } = build(grantee);
    await expectRealBooker(ctx, actor);
    const a = ctx.seedHold(REQUEST_A);
    const before = snapshot(ctx);
    await expect(
      bookNightWithoutTerms(ctx.deps as never, {
        actorHumanId: actor,
        bookingRequestId: REQUEST_A,
        holdId: a.id,
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
    expect(snapshot(ctx)).toBe(before);
    expect(ctx.events.size).toBe(0);
  });
});

describe("staff still pass the same gates", () => {
  it("an owning-org EDITOR reorders and releases", async () => {
    const { ctx } = build("person");
    ctx.seedHold(REQUEST_A);
    const b = ctx.seedHold(REQUEST_B);
    const moved = await reorderBookingHold(ctx.deps, {
      actorHumanId: STAFF_ID,
      holdId: b.id,
      toPosition: 1,
    });
    expect(moved.line[0]?.id).toBe(b.id);
    const released = await releaseBookingHold(ctx.deps, {
      actorHumanId: STAFF_ID,
      holdId: b.id,
    });
    expect(released.hold.status).toBe("RELEASED");
  });
});

import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";
import type {
  BookingRequestRecord,
  SetBookingRequestActConfirmationInput,
} from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";

import {
  confirmBookingRequestAct,
  declineBookingRequestAct,
  judgeActAnswer,
  type AnswerBookingRequestActDeps,
} from "../answer-booking-request-act";
import { getBookingRequestActInvite } from "../get-booking-request-act-invite";
import { listBookingLineupSuggestions } from "../../event-humans/list-booking-lineup-suggestions";
import type { ListBookingLineupSuggestionsDeps } from "../../event-humans/list-booking-lineup-suggestions";
import { listBookingRequestMessages } from "../messages/list-messages";
import type { ListBookingRequestMessagesDeps } from "../messages/list-messages";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  EVENT_ID,
  NOW,
  OTHER_HUMAN_ID,
  PLACE_ID,
  REQUEST_ID,
  buildAgreementRecord,
  buildBookingRequestRecord,
  buildPlaceRecord,
  buildStageEventRecord,
  systemEntriesFor,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// A tagged artist answers their spot on a bill (lineup v2, FR-003), and reads
// their invite. ACTOR_ID is the SENDER (a human, performer pair on the
// request); OTHER_HUMAN_ID is the TAGGED artist answering.
// ─────────────────────────────────────────────────────────────────────────────

const ARTIST_ID = OTHER_HUMAN_ID;
const SECOND_ARTIST_ID = "16161616-1616-4161-8161-161616161616";
const THIRD_ARTIST_ID = "17171717-1717-4171-8171-171717171717";
const STRANGER_ID = "18181818-1818-4181-8181-181818181818";
const VENUE_OWNER_ID = "13131313-1313-4131-8131-131313131313";
const VENUE_ORG_ID = "19191919-1919-4191-8191-191919191919";

type BuildOptions = {
  request?: BookingRequestRecord | null;
  agreement?: AgreementRecord | null;
  events?: EventRecord[];
};

function buildDeps(options: BuildOptions = {}) {
  let request =
    options.request === undefined
      ? buildBookingRequestRecord()
      : options.request;
  const agreement = options.agreement ?? null;
  const events = options.events ?? [];

  const bookingRequests = {
    getById: vi.fn(async (id: string) =>
      request && id === request.id ? request : null,
    ),
    // The event → booking link the suggestions read walks.
    findByAgreementId: vi.fn(async (id: string) =>
      request && request.agreementId === id ? request : null,
    ),
  };
  const agreements = {
    getById: vi.fn(async (id: string) =>
      agreement && agreement.id === id ? agreement : null,
    ),
    findByLinkedEventId: vi.fn(async (eventId: string) =>
      agreement &&
      (agreement.eventId === eventId || agreement.draftEventId === eventId)
        ? agreement
        : null,
    ),
  };
  const eventsRepo = {
    getById: vi.fn(
      async (id: string) => events.find((event) => event.id === id) ?? null,
    ),
  };
  const humans = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({
        id,
        name:
          id === ARTIST_ID
            ? "Artie Artist"
            : id === SECOND_ARTIST_ID
              ? "Second Artist"
              : id === THIRD_ARTIST_ID
                ? "Third Artist"
                : "Sam Sender",
        status: "ACTIVE",
      })),
    ),
  };
  const organizations = { getByIds: vi.fn(async () => []) };
  // PUBLIC pages for the sender and SECOND_ARTIST only (the links).
  const publicPages: Record<string, string> = {
    [ACTOR_ID]: "sam-sender",
    [SECOND_ARTIST_ID]: "second-artist",
  };
  const entityPages = {
    getByOwners: vi.fn(async (ownerType: string, ids: string[]) =>
      ownerType !== "HUMAN"
        ? []
        : ids
            .filter((id) => publicPages[id])
            .map((id) => ({
              id: `page-${id}`,
              ownerType: "HUMAN",
              ownerId: id,
              slug: publicPages[id],
              displayName: null,
              visibility: "PUBLIC",
            })),
    ),
    getByOwner: vi.fn(async () => null),
  };
  // The minted event's lineup. An answer never attaches (`attach` stays
  // uncalled); tests put a human ON it to model the mint / the editor.
  const lineup: Array<{ id: string; eventId: string; humanId: string | null }> = [];
  const eventHumans = {
    listByEvent: vi.fn(async (eventId: string) =>
      lineup.filter((row) => row.eventId === eventId),
    ),
    attach: vi.fn(),
  };
  const audit = { log: vi.fn(async () => {}) };

  // Venue-side reader gate plumbing (list-messages as VENUE).
  const place = buildPlaceRecord({ humanIdsWithAccess: [VENUE_OWNER_ID] });
  const places = {
    getById: vi.fn(async (id: string) => (id === PLACE_ID ? place : null)),
  };
  const authz = {
    getPlaceAccessContext: vi.fn(async () => ({
      owningOrgIds: [],
      verifiedHumanOwnerIds: [VENUE_OWNER_ID],
    })),
    // The venue owner edits the minted event's lineup (suggestions gate).
    getOrgMembership: vi.fn(
      async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
        orgId === VENUE_ORG_ID && humanId === VENUE_OWNER_ID
          ? { orgId, humanId, role: "ADMIN" }
          : null,
    ),
    getOrgMemberships: vi.fn(async () => []),
  };

  const repos = withTx({
    bookingRequests,
    agreements,
    eventHumans,
    events: eventsRepo,
    humans,
    organizations,
    entityPages,
    audit,
    places,
    authz,
  });

  const deps = {
    repos: repos as unknown as AnswerBookingRequestActDeps["repos"],
    clock: { now: () => NOW },
  } satisfies AnswerBookingRequestActDeps;

  return {
    deps,
    repos,
    audit,
    eventHumans,
    acts: repos.bookingRequests as unknown as AnswerBookingRequestActDeps["repos"]["bookingRequests"],
    setRequest: (next: BookingRequestRecord) => {
      request = next;
    },
    /** Model the mint (or the editor) putting a human on the event lineup. */
    putOnLineup: (humanId: string) => {
      lineup.push({ id: crypto.randomUUID(), eventId: EVENT_ID, humanId });
    },
    /** Model the editor taking a human off the lineup. */
    takeOffLineup: (humanId: string) => {
      const index = lineup.findIndex((row) => row.humanId === humanId);
      if (index >= 0) lineup.splice(index, 1);
    },
  };
}

/** SELF (the sender) + the artist TAGGED at 1 (+ optional extra rows). */
async function seedBill(
  acts: AnswerBookingRequestActDeps["repos"]["bookingRequests"],
  extra: Parameters<typeof acts.addActs>[1] = [],
) {
  return acts.addActs(REQUEST_ID, [
    { source: "SELF", sortOrder: 0 },
    {
      source: "TAGGED",
      actOwnerType: "human",
      actOwnerId: ARTIST_ID,
      sortOrder: 1,
      invitedAt: NOW,
    },
    ...extra,
  ]);
}

const input = (overrides: Record<string, unknown> = {}) => ({
  actorHumanId: ARTIST_ID,
  bookingRequestId: REQUEST_ID,
  ...overrides,
});

const actOf = async (
  acts: AnswerBookingRequestActDeps["repos"]["bookingRequests"],
  humanId: string,
) =>
  acts.getActForOwner({
    bookingRequestId: REQUEST_ID,
    actOwnerType: "human",
    actOwnerId: humanId,
  });

/**
 * An accepted request whose agreement anchors a LIVE draft event that has
 * already STARTED (before NOW): a join then attaches nothing by itself — the
 * v2 behaviour these tests pin. The v3 late join onto an UPCOMING event
 * (FR-010) has its own suite, `answer-booking-request-act-late-join.test.ts`.
 */
function mintedFixture(status: EventRecord["status"] = "DRAFT") {
  return {
    request: buildBookingRequestRecord({
      status: "ACCEPTED",
      agreementId: AGREEMENT_ID,
    }),
    agreement: buildAgreementRecord({ draftEventId: EVENT_ID }),
    events: [
      buildStageEventRecord({
        id: EVENT_ID,
        status,
        orgId: VENUE_ORG_ID,
        humanId: null,
        startsAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The transition table
// ─────────────────────────────────────────────────────────────────────────────

describe("judgeActAnswer", () => {
  const open = { requestStatus: "PENDING" as const, actOnEventLineup: false };

  it("repeating an answer is a no-op", () => {
    expect(judgeActAnswer("CONFIRMED", "CONFIRMED", open)).toEqual({ kind: "noop" });
    expect(judgeActAnswer("DECLINED", "DECLINED", open)).toEqual({ kind: "noop" });
  });

  it("confirm needs a live request (minted or not); never after a decline", () => {
    expect(judgeActAnswer("PENDING", "CONFIRMED", open)).toEqual({
      kind: "write",
      expectedFrom: "PENDING",
    });
    for (const requestStatus of ["VIEWED", "ACCEPTED"] as const) {
      expect(
        judgeActAnswer("PENDING", "CONFIRMED", { requestStatus, actOnEventLineup: false }).kind,
      ).toBe("write");
    }
    for (const requestStatus of ["DECLINED", "WITHDRAWN", "EXPIRED"] as const) {
      expect(
        judgeActAnswer("PENDING", "CONFIRMED", { requestStatus, actOnEventLineup: false }),
      ).toMatchObject({ kind: "refuse", code: "INVALID_STATUS", reason: "request_closed" });
    }
    // A minted event does NOT block a pending act's yes (it attaches nothing).
    expect(
      judgeActAnswer("PENDING", "CONFIRMED", { requestStatus: "ACCEPTED", actOnEventLineup: false }),
    ).toEqual({ kind: "write", expectedFrom: "PENDING" });
    expect(judgeActAnswer("DECLINED", "CONFIRMED", open)).toMatchObject({
      kind: "refuse",
      code: "ACT_ALREADY_DECLINED",
    });
  });

  it("a pending act may always decline; a confirmed one unless it is ON the event lineup", () => {
    for (const requestStatus of ["PENDING", "ACCEPTED", "EXPIRED"] as const) {
      expect(
        judgeActAnswer("PENDING", "DECLINED", { requestStatus, actOnEventLineup: true }),
      ).toEqual({ kind: "write", expectedFrom: "PENDING" });
    }
    expect(judgeActAnswer("CONFIRMED", "DECLINED", open)).toEqual({
      kind: "write",
      expectedFrom: "CONFIRMED",
    });
    expect(
      judgeActAnswer("CONFIRMED", "DECLINED", { requestStatus: "ACCEPTED", actOnEventLineup: true }),
    ).toMatchObject({ kind: "refuse", code: "INVALID_STATUS", reason: "on_lineup" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// confirm / decline
// ─────────────────────────────────────────────────────────────────────────────

describe("confirmBookingRequestAct", () => {
  it("PENDING → CONFIRMED: CAS + ledger entry + audit, in one tx under the bill lock", async () => {
    const { deps, repos, audit, acts } = buildDeps();
    await seedBill(acts);
    const lockSpy = vi.spyOn(acts, "lockBill");

    const result = await confirmBookingRequestAct(deps, input());

    expect(result).toMatchObject({
      bookingRequestId: REQUEST_ID,
      confirmation: "CONFIRMED",
      respondedAt: NOW,
      changed: true,
    });
    expect(repos.tx).toHaveBeenCalledTimes(1);
    expect(lockSpy).toHaveBeenCalledWith(REQUEST_ID);
    expect(await actOf(acts, ARTIST_ID)).toMatchObject({
      confirmation: "CONFIRMED",
      respondedAt: NOW,
    });

    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      {
        systemKind: "booking_request.act_confirmed",
        systemData: { actId: result.actId, actName: "Artie Artist" },
        authorHumanId: ARTIST_ID,
        authorSide: "SYSTEM",
      },
    ]);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "booking_request_act",
        entityId: result.actId,
        action: "booking_request.act_confirmed",
        data: expect.objectContaining({ from: "PENDING", to: "CONFIRMED" }),
      }),
    );
  });

  it("is idempotent: a second confirm writes nothing and opens no tx", async () => {
    const { deps, repos, audit, acts } = buildDeps();
    await seedBill(acts);
    await confirmBookingRequestAct(deps, input());
    vi.mocked(repos.tx).mockClear();
    audit.log.mockClear();

    const again = await confirmBookingRequestAct(deps, input());

    expect(again).toMatchObject({ confirmation: "CONFIRMED", changed: false });
    expect(repos.tx).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(systemEntriesFor(repos, REQUEST_ID)).toHaveLength(1);
  });

  it("DECLINED → confirm is refused (terminal on the request)", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    await declineBookingRequestAct(deps, input());

    await expect(confirmBookingRequestAct(deps, input())).rejects.toMatchObject({
      code: "ACT_ALREADY_DECLINED",
    });
    expect(await actOf(acts, ARTIST_ID)).toMatchObject({ confirmation: "DECLINED" });
  });

  it("refuses on a closed request", async () => {
    const closed = buildDeps({
      request: buildBookingRequestRecord({ status: "WITHDRAWN" }),
    });
    await seedBill(closed.acts);
    await expect(confirmBookingRequestAct(closed.deps, input())).rejects.toMatchObject({
      code: "INVALID_STATUS",
      meta: { reason: "request_closed" },
    });
    expect(await actOf(closed.acts, ARTIST_ID)).toMatchObject({ confirmation: "PENDING" });
  });

  it("after the mint, once the event has STARTED, a pending act's join attaches NOTHING — the editor sees a joined suggestion", async () => {
    const { deps, repos, acts, eventHumans } = buildDeps(mintedFixture());
    await seedBill(acts);

    await expect(confirmBookingRequestAct(deps, input())).resolves.toMatchObject({
      confirmation: "CONFIRMED",
      changed: true,
    });
    expect(eventHumans.attach).not.toHaveBeenCalled();

    const suggestions = await listBookingLineupSuggestions(
      {
        repos: repos as unknown as ListBookingLineupSuggestionsDeps["repos"],
        authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
      } as unknown as ListBookingLineupSuggestionsDeps,
      { actorHumanId: VENUE_OWNER_ID, eventId: EVENT_ID },
    );
    expect(suggestions.suggestions).toEqual([
      expect.objectContaining({ humanId: ARTIST_ID, confirmation: "CONFIRMED" }),
    ]);

    // They were never on the lineup, so they may still say no — and the
    // editor stops being offered them.
    await expect(declineBookingRequestAct(deps, input())).resolves.toMatchObject({
      confirmation: "DECLINED",
      changed: true,
    });
    const after = await listBookingLineupSuggestions(
      {
        repos: repos as unknown as ListBookingLineupSuggestionsDeps["repos"],
        authz: { hasStaffRole: vi.fn(async () => ({ allowed: false })) },
      } as unknown as ListBookingLineupSuggestionsDeps,
      { actorHumanId: VENUE_OWNER_ID, eventId: EVENT_ID },
    );
    expect(after.suggestions).toEqual([]);
  });

  it("an ACCEPTED request whose draft event is dead (cancelled) still confirms", async () => {
    const { deps, acts } = buildDeps(mintedFixture("CANCELLED"));
    await seedBill(acts);

    await expect(confirmBookingRequestAct(deps, input())).resolves.toMatchObject({
      confirmation: "CONFIRMED",
      changed: true,
    });
  });

  it("the same not-found for a stranger, the sender's own SELF row, and a missing request", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);

    // Not tagged on this request.
    await expect(
      confirmBookingRequestAct(deps, input({ actorHumanId: STRANGER_ID })),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
    // The sender owns the SELF row — not an invitation.
    await expect(
      confirmBookingRequestAct(deps, input({ actorHumanId: ACTOR_ID })),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
    // No such request.
    const missing = await confirmBookingRequestAct(
      deps,
      input({ bookingRequestId: "99999999-9999-4999-8999-999999999990" }),
    ).catch((error: unknown) => error);
    expect(missing).toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
    // No meta that could tell the cases apart.
    expect((missing as { meta?: unknown }).meta).toBeUndefined();
  });

  it("a lost CAS race to the same answer resolves to the idempotent result", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    const original = acts.setActConfirmation.bind(acts);
    // A concurrent confirm (a writer that skipped the lock) lands first.
    acts.setActConfirmation = vi.fn(async (args: SetBookingRequestActConfirmationInput) => {
      await original({ ...args, to: "CONFIRMED" });
      return original(args); // PENDING no longer matches → conflict
    });

    await expect(confirmBookingRequestAct(deps, input())).resolves.toMatchObject({
      confirmation: "CONFIRMED",
      changed: false,
    });
  });

  it("a confirm that loses the race to a decline surfaces ACT_ALREADY_DECLINED", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    const original = acts.setActConfirmation.bind(acts);
    acts.setActConfirmation = vi.fn(async (args: SetBookingRequestActConfirmationInput) => {
      await original({ ...args, to: "DECLINED" });
      return original(args);
    });

    await expect(confirmBookingRequestAct(deps, input())).rejects.toMatchObject({
      code: "ACT_ALREADY_DECLINED",
    });
  });
});

describe("declineBookingRequestAct", () => {
  it("PENDING → DECLINED with a sanitized reason; the entry is SENDER-ONLY", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);

    const result = await declineBookingRequestAct(
      deps,
      input({ declineReason: "  <b>Booked</b> that night  " }),
    );

    expect(result).toMatchObject({ confirmation: "DECLINED", changed: true });
    const row = await actOf(acts, ARTIST_ID);
    expect(row).toMatchObject({ confirmation: "DECLINED", respondedAt: NOW });
    // Sanitized at the boundary: tags stripped, whitespace collapsed.
    expect(row?.declineReason).toBe("Booked that night");
    // v3 L19: the pass reason rides on the (sender-only) entry, so the
    // sender reads it in the thread. Not a leave (`left` absent).
    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([
      expect.objectContaining({
        systemKind: "booking_request.act_declined",
        systemData: {
          actId: result.actId,
          actName: "Artie Artist",
          reason: "Booked that night",
        },
        authorHumanId: ARTIST_ID,
      }),
    ]);

    // The venue never learns an act declined; the sender does.
    const listDeps = {
      repos: repos as unknown as ListBookingRequestMessagesDeps["repos"],
    };
    const venue = await listBookingRequestMessages(listDeps, {
      actorHumanId: VENUE_OWNER_ID,
      bookingRequestId: REQUEST_ID,
      side: "VENUE",
    });
    expect(venue.items.map((row) => row.systemKind)).not.toContain(
      "booking_request.act_declined",
    );
    const sender = await listBookingRequestMessages(listDeps, {
      actorHumanId: ACTOR_ID,
      bookingRequestId: REQUEST_ID,
      side: "PERFORMER",
    });
    expect(sender.items.map((row) => row.systemKind)).toContain(
      "booking_request.act_declined",
    );
  });

  it("is idempotent and keeps the FIRST reason", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);
    await declineBookingRequestAct(deps, input({ declineReason: "first" }));

    const again = await declineBookingRequestAct(deps, input({ declineReason: "second" }));

    expect(again).toMatchObject({ confirmation: "DECLINED", changed: false });
    expect((await actOf(acts, ARTIST_ID))?.declineReason).toBe("first");
    expect(systemEntriesFor(repos, REQUEST_ID)).toHaveLength(1);
  });

  it("CONFIRMED → DECLINED (consent withdrawn) is allowed before the mint", async () => {
    const { deps, audit, acts } = buildDeps();
    await seedBill(acts);
    await confirmBookingRequestAct(deps, input());

    const result = await declineBookingRequestAct(deps, input());

    expect(result).toMatchObject({ confirmation: "DECLINED", changed: true });
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: "booking_request.act_declined",
        data: expect.objectContaining({ from: "CONFIRMED", to: "DECLINED" }),
      }),
    );
  });

  it("CONFIRMED → DECLINED is refused once the mint put the artist ON the lineup — the editor's call", async () => {
    const fixture = mintedFixture();
    const { deps, acts, setRequest, putOnLineup } = buildDeps({
      ...fixture,
      // Confirm while the booking is still pre-mint…
      request: buildBookingRequestRecord({ status: "ACCEPTED" }),
    });
    await seedBill(acts);
    await confirmBookingRequestAct(deps, input());
    // …then the venue mints the event, which attaches the confirmed act.
    setRequest(fixture.request);
    putOnLineup(ARTIST_ID);

    await expect(declineBookingRequestAct(deps, input())).rejects.toMatchObject({
      code: "INVALID_STATUS",
      meta: { reason: "on_lineup" },
    });
    expect(await actOf(acts, ARTIST_ID)).toMatchObject({ confirmation: "CONFIRMED" });
  });

  it("attached at the mint, then REMOVED by the editor → the withdrawal goes through", async () => {
    const fixture = mintedFixture();
    const { deps, acts, setRequest, putOnLineup, takeOffLineup } = buildDeps({
      ...fixture,
      request: buildBookingRequestRecord({ status: "ACCEPTED" }),
    });
    await seedBill(acts);
    await confirmBookingRequestAct(deps, input());
    setRequest(fixture.request);
    putOnLineup(ARTIST_ID);
    takeOffLineup(ARTIST_ID);

    await expect(declineBookingRequestAct(deps, input())).resolves.toMatchObject({
      confirmation: "DECLINED",
      changed: true,
    });
  });

  it("another human on the lineup does not block THIS artist's withdrawal", async () => {
    const { deps, acts, putOnLineup } = buildDeps(mintedFixture());
    await seedBill(acts);
    await confirmBookingRequestAct(deps, input());
    putOnLineup(SECOND_ARTIST_ID);

    await expect(declineBookingRequestAct(deps, input())).resolves.toMatchObject({
      confirmation: "DECLINED",
    });
  });

  it("a PENDING act may still decline after the mint (it was never attached)", async () => {
    const { deps, acts } = buildDeps(mintedFixture());
    await seedBill(acts);

    await expect(declineBookingRequestAct(deps, input())).resolves.toMatchObject({
      confirmation: "DECLINED",
      changed: true,
    });
  });

  it("the decision is re-made UNDER the lock: a mint that commits after the pre-flight wins", async () => {
    const fixture = mintedFixture();
    const { deps, acts, setRequest, putOnLineup } = buildDeps({
      ...fixture,
      request: buildBookingRequestRecord({ status: "ACCEPTED" }),
    });
    await seedBill(acts);
    await confirmBookingRequestAct(deps, input());
    // The mint (anchor + lineup attach) commits between the pre-flight read
    // and the lock.
    const lock = acts.lockBill.bind(acts);
    acts.lockBill = vi.fn(async (id: string) => {
      setRequest(fixture.request);
      putOnLineup(ARTIST_ID);
      return lock(id);
    });

    await expect(declineBookingRequestAct(deps, input())).rejects.toMatchObject({
      code: "INVALID_STATUS",
      meta: { reason: "on_lineup" },
    });
    expect(await actOf(acts, ARTIST_ID)).toMatchObject({ confirmation: "CONFIRMED" });
  });

  it("a WITHDRAWN confirmation disappears from the venue's thread and other acts'; the sender keeps both entries", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: SECOND_ARTIST_ID, sortOrder: 2 },
    ]);
    await confirmBookingRequestAct(deps, input({ actorHumanId: SECOND_ARTIST_ID }));
    await confirmBookingRequestAct(deps, input());
    await declineBookingRequestAct(deps, input()); // ARTIST withdraws

    const listDeps = {
      repos: repos as unknown as ListBookingRequestMessagesDeps["repos"],
    };
    const namesOf = async (actorHumanId: string, side: "VENUE" | "ACT" | "PERFORMER") =>
      (
        await listBookingRequestMessages(listDeps, {
          actorHumanId,
          bookingRequestId: REQUEST_ID,
          side,
        })
      ).items.map((row) => `${row.systemKind}:${String(row.systemData?.actName)}`);

    const venue = await namesOf(VENUE_OWNER_ID, "VENUE");
    expect(venue).toEqual(["booking_request.act_confirmed:Second Artist"]);
    expect(venue.join()).not.toContain("Artie Artist");

    const otherAct = await namesOf(SECOND_ARTIST_ID, "ACT");
    expect(otherAct).toEqual(["booking_request.act_confirmed:Second Artist"]);

    // The sender keeps the whole history: Artie confirmed, then declined.
    expect(await namesOf(ACTOR_ID, "PERFORMER")).toEqual([
      "booking_request.act_confirmed:Second Artist",
      "booking_request.act_confirmed:Artie Artist",
      "booking_request.act_declined:Artie Artist",
    ]);
  });

  it("takes the bill lock on the TX bag (never the root bag), BEFORE the reads it decides on", async () => {
    const { deps, repos, acts } = buildDeps();
    await seedBill(acts);
    await confirmBookingRequestAct(deps, input()); // CONFIRMED — now withdraw

    const order: string[] = [];
    const rootLock = vi.fn(async () => {
      order.push("root:lockBill");
    });
    (repos.bookingRequests as unknown as { lockBill: unknown }).lockBill = rootLock;
    const root = repos.bookingRequests as unknown as AnswerBookingRequestActDeps["repos"]["bookingRequests"];
    // A DISTINCT bag for the transaction: every call on it is recorded.
    const txBag = {
      ...repos,
      bookingRequests: {
        ...root,
        lockBill: vi.fn(async () => {
          order.push("tx:lockBill");
        }),
        getActForOwner: vi.fn(async (key: Parameters<typeof root.getActForOwner>[0]) => {
          order.push("tx:getActForOwner");
          return root.getActForOwner(key);
        }),
        getById: vi.fn(async (id: string) => {
          order.push("tx:getById");
          return root.getById(id);
        }),
        setActConfirmation: vi.fn(async (args: SetBookingRequestActConfirmationInput) => {
          order.push("tx:setActConfirmation");
          return root.setActConfirmation(args);
        }),
      },
    };
    deps.repos = {
      ...deps.repos,
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txBag)),
    } as unknown as AnswerBookingRequestActDeps["repos"];

    await expect(declineBookingRequestAct(deps, input())).resolves.toMatchObject({
      confirmation: "DECLINED",
      changed: true,
    });
    expect(rootLock).not.toHaveBeenCalled();
    expect(order).toEqual([
      "tx:lockBill",
      "tx:getActForOwner",
      "tx:getById",
      "tx:setActConfirmation",
    ]);
  });

  it("rejects an over-long reason at the boundary", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);
    await expect(
      declineBookingRequestAct(deps, input({ declineReason: "x".repeat(241) })),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The invite read
// ─────────────────────────────────────────────────────────────────────────────

describe("getBookingRequestActInvite", () => {
  it("shows the tagged artist their spot and ONLY the other acts that said yes", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts, [
      { source: "EXTERNAL", externalName: "The Weeds", externalUrl: "https://weeds.example", sortOrder: 2 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: SECOND_ARTIST_ID, sortOrder: 3 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: THIRD_ARTIST_ID, sortOrder: 4 },
    ]);
    // SECOND confirmed, THIRD declined — the viewer may only see SECOND.
    await confirmBookingRequestAct(deps, input({ actorHumanId: SECOND_ARTIST_ID }));
    await declineBookingRequestAct(deps, input({ actorHumanId: THIRD_ARTIST_ID }));

    const invite = await getBookingRequestActInvite(deps, input());

    expect(invite).toMatchObject({
      bookingRequestId: REQUEST_ID,
      status: "PENDING",
      intent: "PERFORM",
      venue: { placeId: PLACE_ID, name: "Test Venue", pageSlug: null },
      sender: { displayName: "Sam Sender", href: "/humans/sam-sender" },
      preferredDates: ["2026-07-10"],
      myAct: { confirmation: "PENDING", sortOrder: 1, role: "PERFORMER", respondedAt: null },
      eventMinted: false,
      canConfirm: true,
      canDecline: true,
      confirmBlockedReason: null,
      declineBlockedReason: null,
    });
    expect(invite.otherActs).toEqual([
      { source: "SELF", displayName: "Sam Sender", href: "/humans/sam-sender", role: "PERFORMER", customRoleLabel: null, sortOrder: 0 },
      // A typed URL never becomes a link.
      { source: "EXTERNAL", displayName: "The Weeds", href: null, role: "PERFORMER", customRoleLabel: null, sortOrder: 2 },
      { source: "TAGGED", displayName: "Second Artist", href: "/humans/second-artist", role: "PERFORMER", customRoleLabel: null, sortOrder: 3 },
    ]);
  });

  it("a PENDING other act is hidden until it confirms", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: SECOND_ARTIST_ID, sortOrder: 2 },
    ]);

    const invite = await getBookingRequestActInvite(deps, input());
    expect(invite.otherActs.map((act) => act.source)).toEqual(["SELF"]);
  });

  it("any confirmation state may read it; the buttons and blocked reasons follow the server's rule", async () => {
    // DECLINED: confirm refused (terminal); decline is already the answer.
    const declined = buildDeps(mintedFixture());
    await seedBill(declined.acts);
    await declineBookingRequestAct(declined.deps, input());
    expect(await getBookingRequestActInvite(declined.deps, input())).toMatchObject({
      myAct: { confirmation: "DECLINED", respondedAt: NOW },
      eventMinted: true,
      canConfirm: false,
      confirmBlockedReason: "act_declined",
      canDecline: false,
      declineBlockedReason: null,
    });

    // CONFIRMED after the mint, NOT on the lineup: may still withdraw.
    const confirmed = buildDeps(mintedFixture());
    await seedBill(confirmed.acts);
    await confirmBookingRequestAct(confirmed.deps, input());
    expect(await getBookingRequestActInvite(confirmed.deps, input())).toMatchObject({
      eventMinted: true,
      canConfirm: false,
      confirmBlockedReason: null,
      canDecline: true,
      declineBlockedReason: null,
    });
    // …ON the lineup: withdrawing is the event editor's call now.
    confirmed.putOnLineup(ARTIST_ID);
    expect(await getBookingRequestActInvite(confirmed.deps, input())).toMatchObject({
      canDecline: false,
      declineBlockedReason: "on_lineup",
    });

    // PENDING on a closed request: no yes, but no is always open.
    const closed = buildDeps({ request: buildBookingRequestRecord({ status: "EXPIRED" }) });
    await seedBill(closed.acts);
    expect(await getBookingRequestActInvite(closed.deps, input())).toMatchObject({
      canConfirm: false,
      confirmBlockedReason: "request_closed",
      canDecline: true,
      declineBlockedReason: null,
    });
  });

  it("only the tagged human: a stranger and the sender get the same not-found", async () => {
    const { deps, acts } = buildDeps();
    await seedBill(acts);

    for (const actorHumanId of [STRANGER_ID, ACTOR_ID]) {
      await expect(
        getBookingRequestActInvite(deps, input({ actorHumanId })),
      ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
    }
  });
});

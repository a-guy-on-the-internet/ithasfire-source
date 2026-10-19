import { describe, expect, it, vi } from "vitest";

import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import { createFakeBookingRequestActs } from "@th/test-utils/fakes/booking-request-acts";
import { createFakeBookingRequestMessagesRepo } from "@th/test-utils/fakes/venue-hierarchy";

import type { Ctx } from "../../context";
import { eventHumansRouter } from "../event-humans";
import { eventsRouter } from "../events";
import { createCaller } from "./test-helpers";

// ─────────────────────────────────────────────────────────────────────────────
// Lineup self-service (owner ruling "option A", 2026-09-30): the person on a
// lineup can see every lineup they are on (`listMine`) and take themselves
// off (`leave`); `attach` now tells a person it puts on a PUBLISHED lineup.
// These run the REAL router, schemas and use cases over fake repos.
// ─────────────────────────────────────────────────────────────────────────────

const ME = "11111111-1111-4111-8111-111111111111";
const EDITOR = "30303030-3030-4303-8303-303030303030";
const OTHER = "40404040-4040-4404-8404-404040404040";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "e1e1e1e1-e1e1-4e1e-8e1e-e1e1e1e1e1e1";
const MY_ROW = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const NOW = new Date("2024-01-01T00:00:00.000Z");

function lineupRow(id: string, humanId: string | null) {
  return {
    id,
    eventId: EVENT_ID,
    humanId,
    externalName: null,
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    profileSlug: null,
    humanDisplayName: null,
  };
}

function buildRepos(status: "DRAFT" | "PUBLISHED" = "PUBLISHED") {
  const rows = new Map<string, ReturnType<typeof lineupRow>>([
    [MY_ROW, lineupRow(MY_ROW, ME)],
  ]);
  const event = {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Friday Night Sessions",
    status,
    stewardship: "OWNED",
    startsAt: new Date("2024-02-01T02:00:00.000Z"),
    endsAt: new Date("2024-02-01T05:00:00.000Z"),
    timezone: "America/Chicago",
  };
  const eventHumans = {
    getByEventAndHuman: vi.fn(
      async ({ humanId }: { eventId: string; humanId: string }) =>
        [...rows.values()].find((r) => r.humanId === humanId) ?? null,
    ),
    getById: vi.fn(async (id: string) => rows.get(id) ?? null),
    listByEvent: vi.fn(async () => [...rows.values()]),
    detach: vi.fn(async (id: string) => {
      rows.delete(id);
    }),
    attach: vi.fn(async (input: { id?: string; humanId?: string | null; role: string }) => {
      const created = { ...lineupRow(input.id ?? "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2", input.humanId ?? null), role: input.role };
      rows.set(created.id, created);
      return created;
    }),
    listLineupsByHuman: vi.fn(async (input: { when: string; humanId: string }) =>
      input.when === "past"
        ? [
            {
              eventHumanId: MY_ROW,
              eventId: EVENT_ID,
              role: "PERFORMER",
              customRoleLabel: null,
              eventTitle: "Friday Night Sessions",
              startsAt: new Date("2023-12-01T02:00:00.000Z"),
              endsAt: new Date("2023-12-01T05:00:00.000Z"),
              timezone: "America/Chicago",
              status: "PUBLISHED",
              visibility: "PUBLIC",
              stewardship: "OWNED",
              slug: "friday-night-sessions",
              orgName: "Acme",
              ownerHumanName: null,
              ownerOrgId: ORG_ID,
              ownerHumanId: null,
            },
          ]
        : [],
    ),
  };
  const volunteering = {
    listSignupsByHuman: vi.fn(async () => [] as any[]),
    getSignup: vi.fn(async () => null as any),
    updateSignupStatus: vi.fn(async (id: string, patch: any) => ({ id, ...patch })),
    withdrawFutureClaimsBySignup: vi.fn(async () => 0),
    countPendingSignups: vi.fn(async () => 0),
    listGrantsBySignup: vi.fn(async () => []),
  };
  const tx = {
    events: {
      getById: vi.fn(async () => event),
      listTicketTypes: vi.fn(async () => []),
      // The leave's act pass re-judges "upcoming" under a share lock on the
      // event row (declineBookingRequestAct's onlyWhileEventUpcoming).
      lockRows: vi.fn(async (_input: { ids: string[]; mode: "share" | "update" }) => {}),
    },
    eventHumans,
    volunteering,
    organizations: {
      getById: vi.fn(async () => ({ id: ORG_ID, name: "Acme", slug: "acme" })),
      listMembers: vi.fn(async () => ({
        items: [{ humanId: EDITOR, role: "OWNER" }],
        total: 1,
      })),
    },
    audit: { log: vi.fn(async () => undefined) },
    authz: {
      getOrgMembership: vi.fn(async ({ humanId }: { humanId: string }) =>
        humanId === EDITOR ? { orgId: ORG_ID, humanId, role: "OWNER" } : null,
      ),
    },
    // Open calls (FR-017): the leave looks for a pick behind the row; no
    // call covers this event, so there is nothing to settle.
    eventApplications: { getOpenCall: vi.fn(async () => null) },
    seriesOccurrences: { getCalendarInfoForEventIds: vi.fn(async () => []) },
    // Inert stand-ins for tx repos a concurrent workstream writes here.
    entityPages: { getByOwner: vi.fn(async () => null) },
    entityEventNotices: { enqueue: vi.fn() },
    // No booking behind this show unless a suite seeds one (`withBooking`).
    agreements: {
      findByLinkedEventId: vi.fn(async (_eventId: string) => null as any),
      getById: vi.fn(async (_id: string) => null as any),
    },
    bookingRequests: {
      findByAgreementId: vi.fn(async (_id: string) => null as any),
    } as Record<string, any>,
  };
  const repos = {
    tx: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    events: tx.events,
    authz: tx.authz,
    eventHumans,
    volunteering,
    humans: {
      getById: vi.fn(async (id: string) => ({
        id,
        name: id === EDITOR ? "Sam Rivera" : "The Sundowners",
      })),
      // The self-service procedures need a verified email (B2): the person
      // on the lineup has proved their inbox; everyone else has no identity
      // row here, as before.
      getByIdWithIdentity: vi.fn(async (id: string) =>
        id === ME || id === OTHER
          ? { human: { id }, identity: { emailVerified: true } }
          : null,
      ),
      listAuthAccounts: vi.fn(async () => []),
    },
    organizations: tx.organizations,
    entityPages: { getByOwner: vi.fn(async () => null) },
    agreements: tx.agreements,
    bookingRequests: tx.bookingRequests,
  };
  return { repos: repos as unknown as Ctx["repos"], raw: repos, tx, rows };
}

describe("eventHumans.leave", () => {
  it("rejects an unauthenticated caller before touching the lineup", async () => {
    const { repos, tx } = buildRepos();
    const { caller } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: null,
      auth: null,
      authToken: null,
    });
    await expect(caller.leave({ eventId: EVENT_ID })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(tx.eventHumans.detach).not.toHaveBeenCalled();
  });

  it("removes the caller's own row, tells the editors, and is rate-limited per person", async () => {
    const { repos, tx, rows } = buildRepos();
    const notifyWithEmail = vi.fn(async (_input: any) => ({ ok: true, email: { status: "sent" } }));
    const { caller, ctx } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: ME,
      notifyWithEmail: notifyWithEmail as unknown as Ctx["notify"],
      publicAppUrl: "https://ithasfire.com",
    });

    await expect(caller.leave({ eventId: EVENT_ID })).resolves.toEqual({
      eventId: EVENT_ID,
      eventHumanId: MY_ROW,
      withdrawnVolunteerSignupId: null,
    });
    expect(tx.eventHumans.detach).toHaveBeenCalledWith(MY_ROW);
    expect(rows.has(MY_ROW)).toBe(false);
    expect(notifyWithEmail).toHaveBeenCalledTimes(1);
    expect(notifyWithEmail.mock.calls[0]![0]).toMatchObject({
      humanId: EDITOR,
      variant: "event.lineup-left",
    });
    const keys = (ctx.rateLimit.consume as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: unknown[]) => c[0],
    );
    expect(keys).toContain(`eventHumans:leave:${ME}`);
  });

  it("does not let the client aim at a row or pose as someone else (strict input)", async () => {
    const { repos, tx } = buildRepos();
    const { caller } = createCaller(eventHumansRouter, { repos, actorHumanId: ME });
    await expect(
      caller.leave({ eventId: EVENT_ID, eventHumanId: MY_ROW }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      caller.leave({ eventId: EVENT_ID, actorHumanId: OTHER }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(tx.eventHumans.detach).not.toHaveBeenCalled();
  });

  it("maps 'not on this lineup' to NOT_FOUND", async () => {
    const { repos } = buildRepos();
    const { caller } = createCaller(eventHumansRouter, { repos, actorHumanId: OTHER });
    await expect(caller.leave({ eventId: EVENT_ID })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses when the per-person limit is spent", async () => {
    const { repos, tx } = buildRepos();
    const consume = vi.fn(async (key: string) =>
      key.startsWith("eventHumans:leave:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 60 }
        : { allowed: true, remaining: 99, retryAfterSeconds: 0 },
    );
    const { caller } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: ME,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    await expect(caller.leave({ eventId: EVENT_ID })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    expect(tx.eventHumans.detach).not.toHaveBeenCalled();
  });
});

describe("eventHumans.leave — a VOLUNTEER row with a signup (REAL withdrawVolunteerSignup)", () => {
  const SIGNUP = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
  const ROLE = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";

  function setup(pendingBehindSeat: number) {
    const built = buildRepos();
    built.rows.set(MY_ROW, { ...built.rows.get(MY_ROW)!, role: "VOLUNTEER" });
    const signup = () => ({
      id: SIGNUP,
      eventId: EVENT_ID,
      humanId: ME,
      status: "APPROVED",
      shiftId: null,
      roleId: ROLE,
    });
    built.raw.volunteering.listSignupsByHuman.mockResolvedValue([signup()]);
    built.raw.volunteering.getSignup.mockResolvedValue(signup());
    built.raw.volunteering.countPendingSignups.mockResolvedValue(pendingBehindSeat);
    const notifyWithEmail = vi.fn(async (_input: any) => ({ ok: true }));
    const notify = vi.fn(async (_input: any) => ({ ok: true }));
    const { caller } = createCaller(eventHumansRouter, {
      repos: built.repos,
      actorHumanId: ME,
      notify: notify as unknown as Ctx["notify"],
      notifyWithEmail: notifyWithEmail as unknown as Ctx["notify"],
      publicAppUrl: "https://ithasfire.com",
    });
    return { ...built, caller, notify, notifyWithEmail };
  }

  it("APPROVED + no waitlist: signup WITHDRAWN, row detached once, editors get lineup-left", async () => {
    const h = setup(0);
    await expect(h.caller.leave({ eventId: EVENT_ID })).resolves.toEqual({
      eventId: EVENT_ID,
      eventHumanId: MY_ROW,
      withdrawnVolunteerSignupId: SIGNUP,
    });
    expect(h.raw.volunteering.updateSignupStatus).toHaveBeenCalledWith(SIGNUP, {
      status: "WITHDRAWN",
    });
    expect(h.tx.eventHumans.detach).toHaveBeenCalledTimes(1);
    expect(h.rows.has(MY_ROW)).toBe(false);
    // The withdraw sent nothing (no waitlist), so lineup-left is the notice.
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.notifyWithEmail).toHaveBeenCalledTimes(1);
    expect(h.notifyWithEmail.mock.calls[0]![0]).toMatchObject({
      humanId: EDITOR,
      variant: "event.lineup-left",
    });
  });

  it("APPROVED + a waitlist: the withdraw's spot-opened goes out and lineup-left does NOT", async () => {
    const h = setup(2);
    (h.tx.volunteering as any).getEventRole = vi.fn(async () => ({ id: ROLE, name: "Door" }));
    (h.tx.volunteering as any).getShift = vi.fn(async () => null);
    await h.caller.leave({ eventId: EVENT_ID });
    const variants = [
      ...h.notify.mock.calls.map((c) => c[0].variant),
      ...h.notifyWithEmail.mock.calls.map((c) => c[0].variant),
    ];
    expect(variants).toEqual(["volunteer.spot-opened"]);
    expect(h.notify.mock.calls[0]![0].humanId).toBe(EDITOR);
  });
});

describe("eventHumans.leave — a tagged act on the booking this show came from", () => {
  const SENDER = "50505050-5050-4505-8505-505050505050";
  const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
  const AGREEMENT_ID = "55555555-5555-4555-8555-555555555555";

  /** The show was minted from a TO_VENUE request on which ME JOINED the bill. */
  async function withBooking() {
    const built = buildRepos();
    const request = {
      id: REQUEST_ID,
      direction: "TO_VENUE",
      status: "ACCEPTED",
      agreementId: AGREEMENT_ID,
      originEventId: null,
      placeName: "Test Venue",
      performerOwnerType: "human",
      performerOwnerId: SENDER,
      contactName: null,
      contactEmail: null,
      claimedAt: null,
    };
    const agreement = { id: AGREEMENT_ID, eventId: EVENT_ID, draftEventId: null };
    const acts = createFakeBookingRequestActs({
      senderOf: (id) => (id === REQUEST_ID ? { ownerType: "human", ownerId: SENDER } : undefined),
    });
    await acts.addActs(REQUEST_ID, [
      { source: "SELF", sortOrder: 0 },
      { source: "TAGGED", actOwnerType: "human", actOwnerId: ME, sortOrder: 1 },
    ]);
    await acts.setActConfirmation({
      bookingRequestId: REQUEST_ID,
      actOwnerType: "human",
      actOwnerId: ME,
      expectedFrom: "PENDING",
      to: "CONFIRMED",
      respondedAt: NOW,
    });
    Object.assign(built.tx.agreements, {
      findByLinkedEventId: vi.fn(async (eventId: string) => (eventId === EVENT_ID ? agreement : null)),
      getById: vi.fn(async (id: string) => (id === AGREEMENT_ID ? agreement : null)),
    });
    Object.assign(built.tx.bookingRequests, {
      findByAgreementId: vi.fn(async (id: string) => (id === AGREEMENT_ID ? request : null)),
      getById: vi.fn(async (id: string) => (id === REQUEST_ID ? request : null)),
      getActForOwner: acts.getActForOwner,
      setActConfirmation: vi.fn(acts.setActConfirmation),
      lockBill: vi.fn(acts.lockBill),
      listActsForRequests: acts.listActsForRequests,
      touchLastMessageAt: vi.fn(async () => {}),
    });
    const messages = createFakeBookingRequestMessagesRepo();
    Object.assign(built.tx, { bookingRequestMessages: messages });
    Object.assign(built.raw.humans, {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: id === ME ? "The Sundowners" : "Sam Sender", status: "ACTIVE" })),
      ),
    });
    Object.assign(built.tx, { humans: built.raw.humans });
    Object.assign(built.tx.organizations, { getByIds: vi.fn(async () => []) });
    Object.assign(built.raw.entityPages, { getByOwners: vi.fn(async () => []) });
    Object.assign(built.tx.entityPages, { getByOwners: vi.fn(async () => []) });
    const notify = vi.fn(async (_input: any) => ({ ok: true }));
    const notifyWithEmail = vi.fn(async (_input: any) => ({ ok: true, email: { status: "sent" } }));
    const reportError = vi.fn();
    const { caller } = createCaller(eventHumansRouter, {
      repos: built.repos,
      actorHumanId: ME,
      notify: notify as unknown as Ctx["notify"],
      notifyWithEmail: notifyWithEmail as unknown as Ctx["notify"],
      publicAppUrl: "https://ithasfire.com",
      reportError,
    });
    return { ...built, caller, acts, messages, notify, notifyWithEmail, reportError };
  }

  it("leaving passes the act (REAL transition, the passAct deps): DECLINED, sender told in-app, editors told once", async () => {
    const h = await withBooking();

    await h.caller.leave({ eventId: EVENT_ID });

    expect(h.rows.has(MY_ROW)).toBe(false);
    expect(
      await h.acts.getActForOwner({ bookingRequestId: REQUEST_ID, actOwnerType: "human", actOwnerId: ME }),
    ).toMatchObject({ confirmation: "DECLINED" });
    expect(h.tx.bookingRequests.lockBill).toHaveBeenCalledWith(REQUEST_ID);
    // The pass re-checked the show under a share lock on its event row,
    // taken BEFORE the bill lock (event row → bill lock, the mint's order).
    expect(h.tx.events.lockRows).toHaveBeenCalledWith({ ids: [EVENT_ID], mode: "share" });
    expect(h.tx.events.lockRows.mock.invocationCallOrder[0]!).toBeLessThan(
      h.tx.bookingRequests.lockBill.mock.invocationCallOrder[0]!,
    );
    // The sender hears "left" through the booking flow's own notice …
    expect(h.notify.mock.calls.map((c) => [c[0].variant, c[0].humanId, c[0].payload?.answer])).toEqual([
      ["booking.lineup-answered", SENDER, "left"],
    ]);
    // … and the event's editor through lineup-left — one notice each.
    expect(h.notifyWithEmail.mock.calls.map((c) => [c[0].variant, c[0].humanId])).toEqual([
      ["event.lineup-left", EDITOR],
    ]);
    expect(h.reportError).not.toHaveBeenCalled();
  });
});

describe("eventHumans.listMine", () => {
  it("rejects an unauthenticated caller", async () => {
    const { repos } = buildRepos();
    const { caller } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: null,
      auth: null,
      authToken: null,
    });
    await expect(caller.listMine({})).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("lists the caller's own lineups, scoped to the session's human", async () => {
    const { repos, raw } = buildRepos();
    const { caller } = createCaller(eventHumansRouter, { repos, actorHumanId: ME });
    const out = await caller.listMine({ limit: 10 });
    expect(out).toEqual({
      items: [
        expect.objectContaining({
          eventHumanId: MY_ROW,
          eventTitle: "Friday Night Sessions",
          roleLabel: "Performer",
          organiserName: "Acme",
          slug: "friday-night-sessions",
          isPast: true,
          organiserWillBeTold: true,
          hasVolunteerSignup: false,
        }),
      ],
      nextCursor: null,
    });
    for (const [input] of raw.eventHumans.listLineupsByHuman.mock.calls) {
      expect(input.humanId).toBe(ME);
    }
  });

  it("accepts the `direction` useInfiniteQuery injects, and does not forward it", async () => {
    const { repos, raw } = buildRepos();
    const { caller } = createCaller(eventHumansRouter, { repos, actorHumanId: ME });
    await expect(
      caller.listMine({ limit: 20, direction: "forward" }),
    ).resolves.toMatchObject({ nextCursor: null });
    for (const [input] of raw.eventHumans.listLineupsByHuman.mock.calls) {
      expect(input).not.toHaveProperty("direction");
    }
  });

  it("maps a forged cursor to BAD_REQUEST", async () => {
    const { repos } = buildRepos();
    const { caller } = createCaller(eventHumansRouter, { repos, actorHumanId: ME });
    await expect(caller.listMine({ cursor: "garbage" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("per-actor rate limits", () => {
  it("attach charges 120/hour per actor ONLY for adding someone else (free-text is free)", async () => {
    const { repos } = buildRepos("DRAFT");
    const consume = vi.fn(async () => ({ allowed: true, remaining: 1, retryAfterSeconds: 0 }));
    const { caller } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: EDITOR,
      idempotency: createFakeIdempotencyPort(),
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    const key = `eventHumans:attach:actor:${EDITOR}`;
    await caller.attach({ eventId: EVENT_ID, externalName: "Free Text", role: "PERFORMER" });
    expect(consume.mock.calls.filter((c: unknown[]) => c[0] === key)).toHaveLength(0);
    await caller.attach({ eventId: EVENT_ID, humanId: OTHER, role: "DJ" });
    expect(consume).toHaveBeenCalledWith(key, 120, 3600);
  });

  it("a non-editor's attach is refused before any probe or charge (no lineup-membership oracle)", async () => {
    const { repos, raw } = buildRepos("PUBLISHED");
    // The attach budget is spent (the oracle precondition); the default floor
    // is not.
    const consume = vi.fn(async (key: string) =>
      key.startsWith("eventHumans:attach:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 60 }
        : { allowed: true, remaining: 99, retryAfterSeconds: 0 },
    );
    const { caller } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: OTHER,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    // ME is on the lineup; OTHER is a stranger to the org. Either way: FORBIDDEN.
    await expect(
      caller.attach({ eventId: EVENT_ID, humanId: ME, role: "DJ" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      caller.attach({ eventId: EVENT_ID, humanId: EDITOR, role: "DJ" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(raw.eventHumans.getByEventAndHuman).not.toHaveBeenCalled();
    expect(consume.mock.calls.filter((c: any) => String(c[0]).startsWith("eventHumans:attach:"))).toHaveLength(0);
  });

  it("attach maps a spent budget to TOO_MANY_REQUESTS", async () => {
    const { repos, tx } = buildRepos("DRAFT");
    const consume = vi.fn(async (key: string) =>
      key.startsWith("eventHumans:attach:actor:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 60 }
        : { allowed: true, remaining: 99, retryAfterSeconds: 0 },
    );
    const { caller } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: EDITOR,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    await expect(
      caller.attach({ eventId: EVENT_ID, humanId: OTHER, role: "DJ" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(tx.eventHumans.attach).not.toHaveBeenCalled();
  });

  it("inviteLineupHumanToRegister is limited per actor like orgs:invite:actor (20/hour)", async () => {
    const consume = vi.fn(async (key: string) =>
      key.startsWith("events:inviteLineup:actor:")
        ? { allowed: false, remaining: 0, retryAfterSeconds: 60 }
        : { allowed: true, remaining: 99, retryAfterSeconds: 0 },
    );
    const { repos, raw } = buildRepos();
    const { caller } = createCaller(eventsRouter, {
      repos,
      actorHumanId: EDITOR,
      rateLimit: { consume } as unknown as Ctx["rateLimit"],
    });
    await expect(
      caller.inviteLineupHumanToRegister({ eventHumanId: MY_ROW, email: "band@example.org" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(consume).toHaveBeenCalledWith(`events:inviteLineup:actor:${EDITOR}`, 20, 3600);
    expect(raw.eventHumans.getById).not.toHaveBeenCalled();
  });
});

describe("eventHumans.attach — tells the person", () => {
  it("wires the lineup notice: a new person on a PUBLISHED lineup is notified with email bound", async () => {
    const { repos } = buildRepos("PUBLISHED");
    const notifyWithEmail = vi.fn(async (_input: any) => ({ ok: true, email: { status: "sent" } }));
    const { caller } = createCaller(eventHumansRouter, {
      repos,
      actorHumanId: EDITOR,
      idempotency: createFakeIdempotencyPort(),
      notifyWithEmail: notifyWithEmail as unknown as Ctx["notify"],
      publicAppUrl: "https://ithasfire.com",
    });
    await caller.attach({ eventId: EVENT_ID, humanId: OTHER, role: "DJ" });
    expect(notifyWithEmail).toHaveBeenCalledTimes(1);
    expect(notifyWithEmail.mock.calls[0]![0]).toMatchObject({
      humanId: OTHER,
      variant: "event.lineup-added",
      payload: {
        roleLabel: "DJ",
        addedByName: "Sam Rivera",
        lineupsUrl: "https://ithasfire.com/my-lineups",
      },
    });
  });
});

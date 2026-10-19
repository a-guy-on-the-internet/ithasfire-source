import { describe, expect, it, vi } from "vitest";

import { isAppError } from "@th/errors";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import { leaveEventLineup, type LeaveEventLineupDeps } from "../leave-event-lineup";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const PERSON = "40000000-0000-4000-8000-000000000004";
const OTHER_PERSON = "50000000-0000-4000-8000-000000000005";
const ROW = "a0000000-0000-4000-8000-00000000000a";
const OTHER_ROW = "b0000000-0000-4000-8000-00000000000b";
const OWNER = "60000000-0000-4000-8000-000000000006";
const EDITOR = "70000000-0000-4000-8000-000000000007";
const VIEWER = "80000000-0000-4000-8000-000000000008";
const now = new Date("2026-09-30T12:00:00.000Z");
const BOOKING_REQUEST = "c0000000-0000-4000-8000-00000000000c";
const AGREEMENT = "d0000000-0000-4000-8000-00000000000d";
const ACT = "e0000000-0000-4000-8000-00000000000e";
const SENDER = "90000000-0000-4000-8000-000000000009";

function lineupRow(id: string, humanId: string) {
  return {
    id,
    eventId: EVENT_ID,
    humanId,
    externalName: null,
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
    profileSlug: null,
    humanDisplayName: null,
  };
}

function makeHarness(options: {
  event?: { orgId: string | null; humanId: string | null };
  notify?: boolean;
  members?: Array<{ humanId: string; role: string }>;
  myRole?: string;
  signups?: Array<{
    id: string;
    eventId: string | null;
    status: string;
    shiftId?: string | null;
    roleId?: string;
  }>;
  pendingBehindSeat?: number;
  eventStatus?: string;
  /** Default 2026-10-04 — upcoming against `now` (2026-09-30). */
  startsAt?: Date;
  withdraw?: "wired" | "none";
  /**
   * The event came out of a booking: the request (TO_VENUE unless set) and
   * the person's own act on its bill (null = hand-attached, no act).
   */
  bill?: {
    request?: Record<string, unknown>;
    act: { source: string; confirmation: string } | null;
  };
  /** The injected pass: "none" = unwired; a function overrides the default. */
  passAct?:
    | "none"
    | ((
        input: { actorHumanId: string; bookingRequestId: string },
        options: {
          skipSenderNoticeFor?: readonly string[];
          onlyWhileEventUpcoming?: { eventId: string };
        },
      ) => Promise<any>);
} = {}) {
  const rows = new Map([
    [ROW, { ...lineupRow(ROW, PERSON), role: options.myRole ?? "PERFORMER" }],
    [OTHER_ROW, lineupRow(OTHER_ROW, OTHER_PERSON)],
  ]);
  const event = {
    id: EVENT_ID,
    orgId: options.event ? options.event.orgId : ORG_ID,
    humanId: options.event ? options.event.humanId : null,
    title: "Friday Night Sessions",
    status: options.eventStatus ?? "DRAFT",
    visibility: "PUBLIC",
    startsAt: options.startsAt ?? new Date("2026-10-04T22:00:00.000Z"),
    timezone: "America/Chicago",
  };
  const eventHumans = {
    getByEventAndHuman: vi.fn(
      async ({ eventId, humanId }: { eventId: string; humanId: string }) =>
        [...rows.values()].find(
          (r) => r.eventId === eventId && r.humanId === humanId,
        ) ?? null,
    ),
    detach: vi.fn(async (id: string) => {
      rows.delete(id);
    }),
  };
  const tx = {
    events: { getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)) },
    eventHumans,
    audit: { log: vi.fn(async () => undefined) },
    // Open calls (FR-017): no call covers this event, so no pick to settle.
    eventApplications: { getOpenCall: vi.fn(async () => null) },
    seriesOccurrences: { getCalendarInfoForEventIds: vi.fn(async () => []) },
  };
  const signups = options.signups ?? [];
  // Stand-in for the REAL withdraw flow's observable contract: an APPROVED
  // signup's VOLUNTEER EventHuman is detached by the withdraw itself.
  const withdrawVolunteerSignup = vi.fn(
    async ({ signupId }: { actorHumanId: string; signupId: string }) => {
      const signup = signups.find((x) => x.id === signupId)!;
      if (signup.status === "APPROVED") {
        const vrow = [...rows.values()].find(
          (r) => r.humanId === PERSON && r.role === "VOLUNTEER",
        );
        if (vrow) rows.delete(vrow.id);
      }
      // The real flow reads and writes its OWN copy; never the caller's.
      return { ...signup, status: "WITHDRAWN" };
    },
  );
  const members = options.members ?? [
    { humanId: OWNER, role: "OWNER" },
    { humanId: EDITOR, role: "EDITOR" },
    { humanId: VIEWER, role: "VIEWER" },
    // The leaver is also an org editor: never told about themselves.
    { humanId: PERSON, role: "ADMIN" },
  ];
  const notify = vi.fn(async () => ({ ok: true, email: { status: "sent" } })) as any;
  const reportError = vi.fn();
  const clearCooldown = vi.fn(async () => undefined);
  const bill = options.bill;
  const request = bill
    ? {
        id: BOOKING_REQUEST,
        direction: "TO_VENUE",
        agreementId: AGREEMENT,
        originEventId: null,
        // A HUMAN sender (the performer pair) unless the test sets one.
        performerOwnerType: "human",
        performerOwnerId: SENDER,
        claimedAt: null,
        contactName: null,
        contactEmail: null,
        ...bill.request,
      }
    : null;
  const agreements = {
    findByLinkedEventId: vi.fn(async (eventId: string) =>
      request && eventId === EVENT_ID ? { id: AGREEMENT } : null,
    ),
  };
  const bookingRequests = {
    findByAgreementId: vi.fn(async () => request),
    getActForOwner: vi.fn(async (key: { actOwnerType: string; actOwnerId: string }) =>
      bill?.act && key.actOwnerType === "human" && key.actOwnerId === PERSON
        ? { id: ACT, ...bill.act }
        : null,
    ),
  };
  const passBookingRequestAct = vi.fn(
    typeof options.passAct === "function"
      ? options.passAct
      : async () => ({ changed: true, confirmation: "DECLINED" }),
  );
  const deps: LeaveEventLineupDeps = {
    repos: {
      tx: vi.fn(async (fn: any) => fn(tx)),
      agreements,
      bookingRequests,
      eventHumans,
      volunteering: {
        listSignupsByHuman: vi.fn(async () => signups),
        countPendingSignups: vi.fn(async () => options.pendingBehindSeat ?? 0),
      },
      humans: {
        getById: vi.fn(async (id: string) => ({ id, name: "The Sundowners" })),
        getByIdWithIdentity: vi.fn(async () => ({
          human: {},
          identity: { username: "sole-owner" },
        })),
      },
      organizations: {
        getById: vi.fn(async () => ({ id: ORG_ID, name: "Acme", slug: "acme" })),
        listMembers: vi.fn(async () => ({ items: members, total: members.length })),
      },
      entityPages: { getByOwner: vi.fn(async () => null) },
    } as any,
    clock: { now: () => now },
    logger: createTestLogger(),
    ...(options.notify === false ? {} : { notify }),
    publicAppUrl: "https://ithasfire.com",
    reportError,
    ...(options.withdraw === "none" ? {} : { withdrawVolunteerSignup }),
    lineupNotices: { clearCooldown },
    ...(options.passAct === "none" ? {} : { passBookingRequestAct }),
  };
  return {
    deps,
    tx,
    rows,
    notify,
    reportError,
    withdrawVolunteerSignup,
    clearCooldown,
    passBookingRequestAct,
    bookingRequests,
    agreements,
  };
}

describe("leaveEventLineup", () => {
  it("removes the actor's OWN row, audits it as a self-leave, and tells the editors", async () => {
    const h = makeHarness();
    const out = await leaveEventLineup(h.deps, {
      actorHumanId: PERSON,
      eventId: EVENT_ID,
    });

    expect(out).toEqual({
      eventId: EVENT_ID,
      eventHumanId: ROW,
      withdrawnVolunteerSignupId: null,
    });
    expect(h.withdrawVolunteerSignup).not.toHaveBeenCalled();
    expect(h.tx.eventHumans.detach).toHaveBeenCalledWith(ROW);
    expect(h.rows.has(OTHER_ROW)).toBe(true);
    expect(h.tx.audit.log).toHaveBeenCalledWith({
      entity: "event_human",
      entityId: ROW,
      action: "left_lineup",
      data: expect.objectContaining({
        eventId: EVENT_ID,
        humanId: PERSON,
        actorHumanId: PERSON,
        self: true,
      }),
      at: now,
    });

    // Edit-role members only (OWNER/ADMIN/EDITOR), never the leaver.
    const recipients = h.notify.mock.calls.map((c: any) => c[0].humanId);
    expect(recipients.sort()).toEqual([EDITOR, OWNER].sort());
    expect(h.notify.mock.calls[0][0]).toMatchObject({
      variant: "event.lineup-left",
      idempotencyKey: `lineup-left:${ROW}:${h.notify.mock.calls[0][0].humanId}`,
      payload: {
        eventId: EVENT_ID,
        eventHumanId: ROW,
        personName: "The Sundowners",
        lineupUrl: `https://ithasfire.com/admin/acme/events/${EVENT_ID}/edit?section=lineup`,
      },
    });
  });

  it("clears the 7-day re-add cooldown after the commit (owner ruling: a re-add after a self-leave is always told)", async () => {
    const h = makeHarness();
    await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
    expect(h.clearCooldown).toHaveBeenCalledWith({ eventId: EVENT_ID, humanId: PERSON });
    expect(h.clearCooldown.mock.invocationCallOrder[0]).toBeGreaterThan(
      (h.deps.repos.tx as any).mock.invocationCallOrder[0],
    );
  });

  it("a throwing clearCooldown hook never turns the committed leave into an error — it is reported", async () => {
    const h = makeHarness();
    h.clearCooldown.mockRejectedValueOnce(new Error("hook exploded"));
    await expect(
      leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID }),
    ).resolves.toMatchObject({ eventId: EVENT_ID, eventHumanId: ROW });
    expect(h.reportError.mock.calls[0][1].tags.reason).toBe("cooldown_clear_failed");
    // Editors are still told after the swallowed failure.
    expect(h.notify).toHaveBeenCalled();
  });

  it("says 'off the event page' only for a name that was publicly listed", async () => {
    const draft = makeHarness({ eventStatus: "DRAFT" });
    await leaveEventLineup(draft.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
    expect(draft.notify.mock.calls[0][0].payload.wasPubliclyListed).toBe(false);

    const live = makeHarness({ eventStatus: "PUBLISHED" });
    await leaveEventLineup(live.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
    expect(live.notify.mock.calls[0][0].payload.wasPubliclyListed).toBe(true);
  });

  it("a personal event tells its owning human, under their admin slug", async () => {
    const h = makeHarness({ event: { orgId: null, humanId: OWNER } });
    await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0][0]).toMatchObject({
      humanId: OWNER,
      payload: {
        lineupUrl: `https://ithasfire.com/admin/@sole-owner/events/${EVENT_ID}/edit?section=lineup`,
      },
    });
  });

  it("an ownerless community listing has no one to tell — not a failure", async () => {
    const h = makeHarness({ event: { orgId: null, humanId: null } });
    await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
    expect(h.notify).not.toHaveBeenCalled();
    expect(h.reportError).not.toHaveBeenCalled();
  });

  it("cannot target anyone else's row: the input has no row id at all", async () => {
    const h = makeHarness();
    await expect(
      leaveEventLineup(h.deps, {
        actorHumanId: PERSON,
        eventId: EVENT_ID,
        eventHumanId: OTHER_ROW,
      } as any),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(h.tx.eventHumans.detach).not.toHaveBeenCalled();
  });

  it("not on the lineup → EVENT_HUMAN_NOT_FOUND, and nothing changes", async () => {
    const h = makeHarness();
    const err = await leaveEventLineup(h.deps, {
      actorHumanId: EDITOR,
      eventId: EVENT_ID,
    }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe("EVENT_HUMAN_NOT_FOUND");
    expect(h.tx.eventHumans.detach).not.toHaveBeenCalled();
    expect(h.tx.audit.log).not.toHaveBeenCalled();
  });

  it("an unknown event answers the same not-found (no probing)", async () => {
    const h = makeHarness();
    const err = await leaveEventLineup(h.deps, {
      actorHumanId: PERSON,
      eventId: "99999999-0000-4000-8000-000000000009",
    }).catch((e) => e);
    expect(isAppError(err) && err.code).toBe("EVENT_HUMAN_NOT_FOUND");
  });

  it("an editor-notice failure never fails the leave — it is reported", async () => {
    const h = makeHarness();
    h.notify.mockRejectedValue(new Error("notify down"));
    await expect(
      leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID }),
    ).resolves.toMatchObject({ eventId: EVENT_ID, eventHumanId: ROW });
    expect(h.tx.eventHumans.detach).toHaveBeenCalledWith(ROW);
    // One report per failed recipient (OWNER + EDITOR).
    expect(h.reportError).toHaveBeenCalledTimes(2);
    expect(h.reportError.mock.calls[0][1]).toMatchObject({
      tags: { useCase: "leaveEventLineup", reason: "recipient_failed" },
    });
  });

  it("recipient resolution failing is reported too, and a throwing reporter never escapes", async () => {
    const h = makeHarness();
    (h.deps.repos.organizations.listMembers as any).mockRejectedValue(
      new Error("db down"),
    );
    h.reportError.mockImplementation(() => {
      throw new Error("sentry down");
    });
    await expect(
      leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID }),
    ).resolves.toMatchObject({ eventId: EVENT_ID, eventHumanId: ROW });
    expect(h.reportError).toHaveBeenCalledTimes(1);
  });

  it("unwired notify is reported as a wiring bug, the leave still lands", async () => {
    const h = makeHarness({ notify: false });
    await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
    expect(h.tx.eventHumans.detach).toHaveBeenCalledWith(ROW);
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0][1].tags.reason).toBe("not_configured");
  });

  describe("VOLUNTEER rows (owner ruling 2026-09-30)", () => {
    const SIGNUP = "90000000-0000-4000-8000-000000000009";
    const ROLE = "92000000-0000-4000-8000-000000000009";
    const approvedSignup = () => ({ id: SIGNUP, eventId: EVENT_ID, status: "APPROVED", shiftId: null, roleId: ROLE });
    const lineupLeftCalls = (h: ReturnType<typeof makeHarness>) =>
      h.notify.mock.calls.filter((c: any) => c[0].variant === "event.lineup-left");

    it("APPROVED + a waitlist (org event): the withdraw's spot-opened is the notice — no lineup-left on top", async () => {
      const h = makeHarness({
        myRole: "VOLUNTEER",
        signups: [
          { id: "91000000-0000-4000-8000-000000000009", eventId: "other-event", status: "APPROVED", roleId: ROLE },
          approvedSignup(),
        ],
        pendingBehindSeat: 2,
      });
      const out = await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });

      expect(h.withdrawVolunteerSignup).toHaveBeenCalledTimes(1);
      expect(h.withdrawVolunteerSignup).toHaveBeenCalledWith({
        actorHumanId: PERSON,
        signupId: SIGNUP,
      });
      // The withdraw detached the row; this use case did not detach again.
      expect(h.rows.has(ROW)).toBe(false);
      expect(h.tx.eventHumans.detach).not.toHaveBeenCalled();
      expect(out).toEqual({
        eventId: EVENT_ID,
        eventHumanId: ROW,
        withdrawnVolunteerSignupId: SIGNUP,
      });
      expect(h.tx.audit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "left_lineup",
          data: expect.objectContaining({ self: true, withdrawnVolunteerSignupId: SIGNUP }),
        }),
      );
      expect(h.deps.repos.volunteering.countPendingSignups).toHaveBeenCalledWith({ roleId: ROLE });
      expect(lineupLeftCalls(h)).toHaveLength(0);
    });

    it("APPROVED + no waitlist: the withdraw is silent, so lineup-left tells the editors", async () => {
      const h = makeHarness({ myRole: "VOLUNTEER", signups: [approvedSignup()], pendingBehindSeat: 0 });
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(h.withdrawVolunteerSignup).toHaveBeenCalledTimes(1);
      expect(lineupLeftCalls(h).map((c: any) => c[0].humanId).sort()).toEqual([EDITOR, OWNER].sort());
      // Volunteer leaves are self-leaves too: the cooldown is cleared.
      expect(h.clearCooldown).toHaveBeenCalledWith({ eventId: EVENT_ID, humanId: PERSON });
    });

    it("APPROVED on a PERSONAL event (spot-opened never goes there): lineup-left", async () => {
      const h = makeHarness({
        myRole: "VOLUNTEER",
        signups: [approvedSignup()],
        pendingBehindSeat: 5,
        event: { orgId: null, humanId: OWNER },
      });
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(lineupLeftCalls(h)).toHaveLength(1);
    });

    it("PENDING signup next to a hand-attached row: withdraws, removes the row the withdraw left, lineup-left", async () => {
      const h = makeHarness({
        myRole: "VOLUNTEER",
        signups: [{ ...approvedSignup(), status: "PENDING" }],
        pendingBehindSeat: 3,
      });
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(h.withdrawVolunteerSignup).toHaveBeenCalledTimes(1);
      expect(h.tx.eventHumans.detach).toHaveBeenCalledWith(ROW);
      expect(lineupLeftCalls(h)).toHaveLength(2);
    });

    it("hand-attached VOLUNTEER with no live signup: just the lineup removal, lineup-left", async () => {
      const h = makeHarness({
        myRole: "VOLUNTEER",
        signups: [{ ...approvedSignup(), status: "WITHDRAWN" }],
      });
      const out = await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(h.withdrawVolunteerSignup).not.toHaveBeenCalled();
      expect(h.tx.eventHumans.detach).toHaveBeenCalledWith(ROW);
      expect(out.withdrawnVolunteerSignupId).toBeNull();
      expect(lineupLeftCalls(h)).toHaveLength(2);
    });

    it("a failing waitlist probe answers 'not told' (reported) — lineup-left goes out", async () => {
      const h = makeHarness({ myRole: "VOLUNTEER", signups: [approvedSignup()] });
      (h.deps.repos.volunteering.countPendingSignups as any).mockRejectedValue(new Error("db"));
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(lineupLeftCalls(h)).toHaveLength(2);
      expect(h.reportError.mock.calls[0][1].tags.reason).toBe("spot_opened_probe_failed");
    });

    it("refuses (NOT_CONFIGURED) rather than strand an APPROVED signup when the withdraw hook is unwired", async () => {
      const h = makeHarness({ myRole: "VOLUNTEER", signups: [approvedSignup()], withdraw: "none" });
      const err = await leaveEventLineup(h.deps, {
        actorHumanId: PERSON,
        eventId: EVENT_ID,
      }).catch((e) => e);
      expect(isAppError(err) && err.code).toBe("NOT_CONFIGURED");
      expect(h.rows.has(ROW)).toBe(true);
    });

    it("a failing withdraw fails the leave and changes nothing here", async () => {
      const h = makeHarness({ myRole: "VOLUNTEER", signups: [approvedSignup()] });
      h.withdrawVolunteerSignup.mockRejectedValueOnce(new Error("SIGNUP_NOT_WITHDRAWABLE"));
      await expect(
        leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID }),
      ).rejects.toThrow("SIGNUP_NOT_WITHDRAWABLE");
      expect(h.tx.eventHumans.detach).not.toHaveBeenCalled();
      expect(h.tx.audit.log).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    });
  });

  // ── Booking acts (owner rulings 2026-09-30 / 2026-10-01) ─────────────────
  describe("booking acts: leaving an UPCOMING booked show passes the person's act", () => {
    const lineupLeft = (h: ReturnType<typeof makeHarness>) =>
      h.notify.mock.calls
        .map((c: any) => c[0])
        .filter((c: any) => c.variant === "event.lineup-left")
        .map((c: any) => c.humanId)
        .sort();
    const confirmedAct = { act: { source: "TAGGED", confirmation: "CONFIRMED" } };

    it("a CONFIRMED act passes through the injected transition, AFTER the row is gone", async () => {
      const h = makeHarness({ bill: confirmedAct });
      let rowPresentAtPass: boolean | null = null;
      h.passBookingRequestAct.mockImplementationOnce(async () => {
        rowPresentAtPass = h.rows.has(ROW);
        return { changed: true, confirmation: "DECLINED" };
      });

      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });

      expect(h.passBookingRequestAct).toHaveBeenCalledTimes(1);
      expect(h.passBookingRequestAct.mock.calls[0]![0]).toEqual({
        actorHumanId: PERSON,
        bookingRequestId: BOOKING_REQUEST,
      });
      // Post-commit: the transition's `on_lineup` gate sees them off it.
      expect(rowPresentAtPass).toBe(false);
      expect(h.passBookingRequestAct.mock.invocationCallOrder[0]).toBeGreaterThan(
        (h.deps.repos.tx as any).mock.invocationCallOrder[0],
      );
      expect(lineupLeft(h)).toEqual([EDITOR, OWNER].sort());
      expect(h.reportError).not.toHaveBeenCalled();
    });

    it("the bill note skips the leaver and EVERY lineup-left recipient (owner ruling: they get the lineup notice)", async () => {
      const h = makeHarness({ bill: confirmedAct });
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      const skip = h.passBookingRequestAct.mock.calls[0]![1].skipSenderNoticeFor;
      expect([...skip].sort()).toEqual([PERSON, OWNER, EDITOR].sort());
      // …and those recipients DO get lineup-left — exactly the skipped set
      // minus the leaver.
      expect(lineupLeft(h)).toEqual([...skip].filter((id) => id !== PERSON).sort());
    });

    it("nobody gets lineup-left (notify unwired) → the bill note skips only the leaver", async () => {
      const h = makeHarness({ bill: confirmedAct, notify: false });
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(h.passBookingRequestAct.mock.calls[0]![1]).toEqual({
        skipSenderNoticeFor: [PERSON],
        onlyWhileEventUpcoming: { eventId: EVENT_ID },
      });
    });

    it("a PENDING act (an editor attached a suggestion by hand) passes too", async () => {
      const h = makeHarness({ bill: { act: { source: "TAGGED", confirmation: "PENDING" } } });
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(h.passBookingRequestAct).toHaveBeenCalledTimes(1);
    });

    it("owner ruling: a STARTED or past show is lineup credit only — the booking is not even read", async () => {
      for (const startsAt of [now, new Date("2026-09-01T22:00:00.000Z")]) {
        const h = makeHarness({ bill: confirmedAct, startsAt });
        await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
        expect(h.rows.has(ROW)).toBe(false);
        expect(h.agreements.findByLinkedEventId).not.toHaveBeenCalled();
        expect(h.passBookingRequestAct).not.toHaveBeenCalled();
        expect(lineupLeft(h)).toEqual([EDITOR, OWNER].sort());
        expect(h.reportError).not.toHaveBeenCalled();
      }
    });

    it("owner ruling: a CANCELLED or ARCHIVED show leaves the booking untouched", async () => {
      for (const eventStatus of ["CANCELLED", "ARCHIVED"]) {
        const h = makeHarness({ bill: confirmedAct, eventStatus });
        await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
        expect(h.agreements.findByLinkedEventId).not.toHaveBeenCalled();
        expect(h.passBookingRequestAct).not.toHaveBeenCalled();
      }
    });

    it("an upcoming PUBLISHED show passes", async () => {
      const h = makeHarness({ bill: confirmedAct, eventStatus: "PUBLISHED" });
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(h.passBookingRequestAct).toHaveBeenCalledTimes(1);
    });

    it("hand-attached (no act), no booking, SELF row, already passed, TO_PERFORMER: nothing changes on the bill", async () => {
      for (const bill of [
        undefined,
        { act: null },
        { act: { source: "SELF", confirmation: "CONFIRMED" } },
        { act: { source: "TAGGED", confirmation: "DECLINED" } },
        { request: { direction: "TO_PERFORMER" }, ...confirmedAct },
      ]) {
        const h = makeHarness({ bill });
        await expect(
          leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID }),
        ).resolves.toMatchObject({ eventHumanId: ROW });
        expect(h.passBookingRequestAct).not.toHaveBeenCalled();
        expect(lineupLeft(h)).toEqual([EDITOR, OWNER].sort());
        expect(h.reportError).not.toHaveBeenCalled();
      }
    });

    it("only the person's own act is looked up — by owner key, as a person", async () => {
      const h = makeHarness({ bill: confirmedAct });
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(h.bookingRequests.getActForOwner).toHaveBeenCalledWith({
        bookingRequestId: BOOKING_REQUEST,
        actOwnerType: "human",
        actOwnerId: PERSON,
      });
    });

    it("a throwing transition never fails the committed leave — reported, editors still told", async () => {
      const h = makeHarness({
        bill: confirmedAct,
        passAct: async () => {
          throw new Error("bill lock timeout");
        },
      });
      await expect(
        leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID }),
      ).resolves.toMatchObject({ eventHumanId: ROW });
      expect(h.rows.has(ROW)).toBe(false);
      expect(h.reportError).toHaveBeenCalledTimes(1);
      expect(h.reportError.mock.calls[0][1]).toMatchObject({
        tags: { useCase: "leaveEventLineup", reason: "booking_act_pass_failed" },
        extra: { eventId: EVENT_ID },
      });
      expect(lineupLeft(h)).toEqual([EDITOR, OWNER].sort());
    });

    it("a failing bill lookup is reported the same way", async () => {
      const h = makeHarness({ bill: confirmedAct });
      h.bookingRequests.getActForOwner.mockRejectedValueOnce(new Error("db"));
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(h.reportError.mock.calls[0][1].tags.reason).toBe("booking_act_pass_failed");
      expect(h.passBookingRequestAct).not.toHaveBeenCalled();
    });

    it("a throwing reporter on that path never escapes", async () => {
      const h = makeHarness({
        bill: confirmedAct,
        passAct: async () => {
          throw new Error("boom");
        },
      });
      h.reportError.mockImplementation(() => {
        throw new Error("sentry down");
      });
      await expect(
        leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID }),
      ).resolves.toMatchObject({ eventHumanId: ROW });
    });

    it("lost races are not failures: re-added (on_lineup) or the sender removed the act (not-found)", async () => {
      for (const thrown of [
        { code: "INVALID_STATUS", message: "booking_request_act_on_lineup", meta: { reason: "on_lineup", bookingRequestId: BOOKING_REQUEST } },
        { code: "BOOKING_REQUEST_NOT_FOUND", message: "booking_request_not_found" },
      ]) {
        const h = makeHarness({
          bill: confirmedAct,
          passAct: async () => {
            throw thrown;
          },
        });
        await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
        expect(h.reportError).not.toHaveBeenCalled();
        expect(lineupLeft(h)).toEqual([EDITOR, OWNER].sort());
      }
    });

    it("the pass is told to re-judge THIS event under the bill lock (owner ruling 2026-10-01)", async () => {
      const h = makeHarness({ bill: confirmedAct });
      await leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(h.passBookingRequestAct.mock.calls[0]![1].onlyWhileEventUpcoming).toEqual({
        eventId: EVENT_ID,
      });
    });

    it("lost race: the show stopped being upcoming before the pass (event_not_upcoming) → info log, not reported", async () => {
      const h = makeHarness({
        bill: confirmedAct,
        passAct: async () => {
          throw {
            code: "INVALID_STATUS",
            message: "booking_request_act_event_not_upcoming",
            meta: { reason: "event_not_upcoming", bookingRequestId: BOOKING_REQUEST, eventId: EVENT_ID },
          };
        },
      });
      await expect(
        leaveEventLineup(h.deps, { actorHumanId: PERSON, eventId: EVENT_ID }),
      ).resolves.toMatchObject({ eventHumanId: ROW });
      expect(h.reportError).not.toHaveBeenCalled();
      expect(h.deps.logger!.error).not.toHaveBeenCalled();
      expect(h.deps.logger!.info).toHaveBeenCalledWith(
        "event_humans.lineup_leave_aftermath.booking_act_not_passed",
        { eventId: EVENT_ID, useCase: "leaveEventLineup", race: "event_not_upcoming" },
      );
      expect(lineupLeft(h)).toEqual([EDITOR, OWNER].sort());
    });

    it("unwired transition with a live act is reported as a wiring bug; with no act, silence", async () => {
      const wired = makeHarness({ bill: confirmedAct, passAct: "none" });
      await leaveEventLineup(wired.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(wired.reportError.mock.calls[0][1].tags.reason).toBe("booking_act_pass_unwired");

      const noAct = makeHarness({ bill: { act: null }, passAct: "none" });
      await leaveEventLineup(noAct.deps, { actorHumanId: PERSON, eventId: EVENT_ID });
      expect(noAct.reportError).not.toHaveBeenCalled();
    });
  });
});

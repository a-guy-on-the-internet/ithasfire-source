import { describe, expect, it, vi } from "vitest";

import type { AttachEventHumanInput } from "@th/ports/repos/event-humans";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { EventRecord } from "@th/ports/repos/events";

import {
  confirmBookingRequestAct,
  declineBookingRequestAct,
  type AnswerBookingRequestActDeps,
} from "../answer-booking-request-act";
import { lateJoinSlot } from "../_shared/late-join";
import {
  ACTOR_ID,
  AGREEMENT_ID,
  EVENT_ID,
  NOW,
  ORG_ID,
  REQUEST_ID,
  buildAgreementRecord,
  buildBookingRequestRecord,
  buildStageEventRecord,
  systemEntriesFor,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// LATE JOIN (lineup-booking-requests v3, FR-010 / L4) and what an answer
// tells (FR-012a). An act that joins after the bill flowed into an UPCOMING,
// live event lands on its lineup by itself, in its bill slot, in the join's
// own transaction; a person is told through the lineup consent notice
// (`event.lineup-added`, recorded OWED before the tx, dispatched after); the
// sender hears every answer in-app.
//
// ACTOR_ID is the human SENDER. Bill: SELF(0) · HOLLOW (joined, 1) · DELLA
// (invited, 2) · "Junco" by name (3). The minted event has the sender,
// Hollow and Junco on its lineup — Della joins late.
// ─────────────────────────────────────────────────────────────────────────────

const HOLLOW = "f1f1f1f1-0000-4000-8000-000000000001";
const DELLA = "f1f1f1f1-0000-4000-8000-000000000002";
const MOTH = "6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a";
const EDITOR = "f1f1f1f1-0000-4000-8000-000000000003";
const UPCOMING = new Date("2026-09-19T00:00:00.000Z");
const STARTED = new Date("2026-06-01T00:00:00.000Z");

type LineupRow = {
  id: string;
  eventId: string;
  humanId: string | null;
  orgId: string | null;
  externalName: string | null;
  externalUrl: string | null;
  role: string;
  customRoleLabel: string | null;
  sortOrder: number;
};

function buildDeps(
  options: {
    event?: Partial<EventRecord>;
    request?: BookingRequestRecord;
    noticeFails?: boolean;
    answeredFails?: boolean;
    editorRoleRevokedAtLock?: boolean;
  } = {},
) {
  const request =
    options.request ??
    buildBookingRequestRecord({
      status: "ACCEPTED",
      agreementId: AGREEMENT_ID,
      billRecorded: true,
    });
  const event = buildStageEventRecord({
    id: EVENT_ID,
    status: "DRAFT",
    startsAt: UPCOMING,
    ...options.event,
  });
  const lineup: LineupRow[] = [];
  const row = (over: Partial<LineupRow>): LineupRow => ({
    id: crypto.randomUUID(),
    eventId: EVENT_ID,
    humanId: null,
    orgId: null,
    externalName: null,
    externalUrl: null,
    role: "PERFORMER",
    customRoleLabel: null,
    sortOrder: lineup.length,
    ...over,
  });
  // The mint: sender, Hollow, Junco.
  lineup.push(row({ humanId: ACTOR_ID }));
  lineup.push(row({ humanId: HOLLOW }));
  lineup.push(row({ externalName: "Junco" }));

  let editorRole: string | null = "ADMIN";
  const eventHumans = {
    listByEvent: vi.fn(async (eventId: string) =>
      lineup
        .filter((r) => r.eventId === eventId)
        .sort((a, b) => a.sortOrder - b.sortOrder),
    ),
    attach: vi.fn(async (input: AttachEventHumanInput) => {
      const created = row({
        id: input.id ?? crypto.randomUUID(),
        humanId: input.humanId ?? null,
        orgId: input.orgId ?? null,
        externalName: input.externalName ?? null,
        externalUrl: input.externalUrl ?? null,
        role: input.role,
        customRoleLabel: input.customRoleLabel ?? null,
        sortOrder: input.sortOrder ?? 0,
      });
      lineup.push(created);
      return created;
    }),
    reorder: vi.fn(async (eventId: string, ids: string[]) => {
      ids.forEach((id, index) => {
        const found = lineup.find((r) => r.id === id && r.eventId === eventId);
        if (!found) throw new Error("event_human_reorder_scope_mismatch");
        found.sortOrder = index;
      });
    }),
  };

  const repos = withTx({
    bookingRequests: {
      getById: vi.fn(async (id: string) => (id === request.id ? request : null)),
    },
    agreements: {
      getById: vi.fn(async (id: string) =>
        id === AGREEMENT_ID ? buildAgreementRecord({ draftEventId: EVENT_ID }) : null,
      ),
    },
    events: { getById: vi.fn(async (id: string) => (id === EVENT_ID ? event : null)) },
    eventHumans,
    humans: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          name: id === DELLA ? "Della" : id === HOLLOW ? "Hollow Bones" : "Sam Sender",
          status: "ACTIVE",
        })),
      ),
    },
    organizations: {
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: id === MOTH ? "Paper Moth" : "Org", status: "ACTIVE" })),
      ),
    },
    entityPages: {
      getByOwners: vi.fn(async (ownerType: string, ids: string[]) =>
        ownerType === "ORGANIZATION" && ids.includes(MOTH)
          ? [
              {
                id: "page-moth",
                ownerType,
                ownerId: MOTH,
                slug: "paper-moth",
                displayName: null,
                visibility: "PUBLIC",
              },
            ]
          : [],
      ),
    },
    audit: { log: vi.fn(async () => {}) },
    authz: {
      getOrgMemberships: vi.fn(async ({ orgIds, humanId }: { orgIds: string[]; humanId: string }) =>
        humanId === EDITOR && editorRole
          ? orgIds.filter((id) => id === MOTH).map((orgId) => ({ orgId, humanId, role: editorRole! }))
          : [],
      ),
    },
  });

  const lineupNotices = {
    recordOwed: vi.fn(async () => {}),
    dispatch: vi.fn(async () => {
      if (options.noticeFails) throw new Error("notice down");
    }),
  };
  const notifyBookingLineupAnswered = vi.fn(async () => {
    if (options.answeredFails) throw new Error("answered down");
  });
  const reportError = vi.fn();
  const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const deps = {
    repos: repos as unknown as AnswerBookingRequestActDeps["repos"],
    clock: { now: () => NOW },
    logger: logger as unknown as AnswerBookingRequestActDeps["logger"],
    lineupNotices,
    notifyBookingLineupAnswered,
    publicAppUrl: "https://ithasfire.test",
    reportError,
  } satisfies AnswerBookingRequestActDeps;

  const acts = repos.bookingRequests as unknown as AnswerBookingRequestActDeps["repos"]["bookingRequests"];
  if (options.editorRoleRevokedAtLock) {
    const lock = acts.lockBill.bind(acts);
    acts.lockBill = vi.fn(async (id: string) => {
      editorRole = "VIEWER";
      return lock(id);
    });
  }

  return {
    deps,
    repos,
    acts,
    lineup,
    eventHumans,
    lineupNotices,
    notifyBookingLineupAnswered,
    reportError,
    logger,
  };
}

async function seedBill(acts: AnswerBookingRequestActDeps["repos"]["bookingRequests"]) {
  await acts.addActs(REQUEST_ID, [
    { source: "SELF", sortOrder: 0 },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: HOLLOW, sortOrder: 1, invitedAt: NOW },
    { source: "TAGGED", actOwnerType: "human", actOwnerId: DELLA, sortOrder: 2, invitedAt: NOW, role: "DJ" },
    { source: "EXTERNAL", externalName: "Junco", sortOrder: 3 },
    { source: "TAGGED", actOwnerType: "organization", actOwnerId: MOTH, sortOrder: 4, invitedAt: NOW },
  ]);
  await acts.setActConfirmation({
    bookingRequestId: REQUEST_ID,
    actOwnerType: "human",
    actOwnerId: HOLLOW,
    expectedFrom: "PENDING",
    to: "CONFIRMED",
    respondedAt: NOW,
  });
}

const join = (actorHumanId = DELLA, extra: Record<string, unknown> = {}) => ({
  actorHumanId,
  bookingRequestId: REQUEST_ID,
  ...extra,
});

const order = (lineup: LineupRow[]) =>
  [...lineup]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((r) =>
      r.humanId === ACTOR_ID
        ? "sender"
        : r.humanId === HOLLOW
          ? "hollow"
          : r.humanId === DELLA
            ? "della"
            : r.orgId === MOTH
              ? "moth"
              : r.externalName,
    );

describe("late join (v3 FR-010)", () => {
  it("a join after the event exists lands the act on its lineup IN ITS BILL SLOT, with a ledger entry, under the lock", async () => {
    const { deps, repos, acts, lineup, lineupNotices } = buildDeps();
    await seedBill(acts);

    await expect(confirmBookingRequestAct(deps, join())).resolves.toMatchObject({
      confirmation: "CONFIRMED",
      changed: true,
    });

    // After Hollow (the last joined act above Della on the bill), before Junco.
    expect(order(lineup)).toEqual(["sender", "hollow", "della", "Junco"]);
    const della = lineup.find((r) => r.humanId === DELLA)!;
    expect(della).toMatchObject({ role: "DJ", orgId: null });

    const entries = systemEntriesFor(repos, REQUEST_ID).map((e) => e.systemKind);
    expect(entries).toEqual([
      "booking_request.act_confirmed",
      "booking_request.act_joined_lineup",
    ]);
    expect(systemEntriesFor(repos, REQUEST_ID)[1]!.systemData).toEqual({
      actId: (await acts.getActForOwner({
        bookingRequestId: REQUEST_ID,
        actOwnerType: "human",
        actOwnerId: DELLA,
      }))!.id,
      eventId: EVENT_ID,
      // The name snapshot, the same one act_confirmed carries.
      actName: "Della",
    });

    // The lineup consent notice: OWED before the tx under the row's id,
    // dispatched after — the attachEventHuman discipline — naming the sender.
    expect(lineupNotices.recordOwed).toHaveBeenCalledWith({
      eventHumanId: della.id,
      addedByHumanId: ACTOR_ID,
      addedByOrgId: null,
      addedByName: "Sam Sender",
      via: "attach",
    });
    expect(lineupNotices.dispatch).toHaveBeenCalledWith({
      kind: "attached",
      eventId: EVENT_ID,
      eventHumanId: della.id,
      addedByHumanId: ACTOR_ID,
      addedByOrgId: null,
      addedByName: "Sam Sender",
    });
    expect(lineupNotices.recordOwed.mock.invocationCallOrder[0]!).toBeLessThan(
      (repos as unknown as { tx: ReturnType<typeof vi.fn> }).tx.mock.invocationCallOrder[0]!,
    );
  });

  it("attaches NOTHING once the event has started", async () => {
    const { deps, repos, acts, lineup, eventHumans, lineupNotices } = buildDeps({
      event: { startsAt: STARTED },
    });
    await seedBill(acts);
    await confirmBookingRequestAct(deps, join());
    expect(eventHumans.attach).not.toHaveBeenCalled();
    expect(order(lineup)).toEqual(["sender", "hollow", "Junco"]);
    expect(systemEntriesFor(repos, REQUEST_ID).map((e) => e.systemKind)).toEqual([
      "booking_request.act_confirmed",
    ]);
    // OWED is recorded for every join (inert when unused — no row exists for
    // the sweep to visit); nothing is dispatched.
    expect(lineupNotices.recordOwed).toHaveBeenCalledTimes(1);
    expect(lineupNotices.dispatch).not.toHaveBeenCalled();
  });

  it("RACE: the night is booked between the pre-read and the lock — the joiner still lands on the lineup and is told", async () => {
    // Committed state at the pre-read: accepted, no event yet.
    const { deps, acts, lineup, lineupNotices, repos } = buildDeps({
      request: buildBookingRequestRecord({
        status: "ACCEPTED",
        agreementId: AGREEMENT_ID,
        billRecorded: true,
      }),
    });
    await seedBill(acts);
    let minted = false;
    const agreements = (repos as unknown as {
      agreements: { getById: ReturnType<typeof vi.fn> };
    }).agreements;
    agreements.getById.mockImplementation(async (id: string) =>
      id === AGREEMENT_ID
        ? buildAgreementRecord({ draftEventId: minted ? EVENT_ID : null })
        : null,
    );
    // The agree-mint commits just before the join takes the bill lock.
    const lock = acts.lockBill.bind(acts);
    acts.lockBill = vi.fn(async (id: string) => {
      minted = true;
      return lock(id);
    });

    await confirmBookingRequestAct(deps, join());

    expect(order(lineup)).toEqual(["sender", "hollow", "della", "Junco"]);
    const della = lineup.find((r) => r.humanId === DELLA)!;
    expect(lineupNotices.recordOwed).toHaveBeenCalledWith(
      expect.objectContaining({ eventHumanId: della.id }),
    );
    expect(lineupNotices.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "attached", eventHumanId: della.id }),
    );
  });

  it("attaches NOTHING to a cancelled event", async () => {
    const { deps, acts, eventHumans } = buildDeps({ event: { status: "CANCELLED" } });
    await seedBill(acts);
    await confirmBookingRequestAct(deps, join());
    expect(eventHumans.attach).not.toHaveBeenCalled();
  });

  it("attaches nothing when the act is already on the lineup (an editor put them there)", async () => {
    const { deps, acts, lineup, eventHumans } = buildDeps();
    await seedBill(acts);
    lineup.push({
      id: crypto.randomUUID(),
      eventId: EVENT_ID,
      humanId: DELLA,
      orgId: null,
      externalName: null,
      externalUrl: null,
      role: "PERFORMER",
      customRoleLabel: null,
      sortOrder: 9,
    });
    await confirmBookingRequestAct(deps, join());
    expect(eventHumans.attach).not.toHaveBeenCalled();
  });

  it("re-decides under the lock: an event cancelled between the pre-read and the lock gets nothing", async () => {
    const { deps, acts, eventHumans, lineupNotices } = buildDeps();
    await seedBill(acts);
    // The pre-read sees a live, upcoming event; the event is cancelled by
    // the time the join holds the lock.
    let locked = false;
    const lock = acts.lockBill.bind(acts);
    acts.lockBill = vi.fn(async (id: string) => {
      locked = true;
      return lock(id);
    });
    const repos = deps.repos as unknown as { events: { getById: ReturnType<typeof vi.fn> } };
    repos.events.getById.mockImplementation(async () =>
      buildStageEventRecord({
        id: EVENT_ID,
        status: locked ? "CANCELLED" : "DRAFT",
        startsAt: UPCOMING,
      }),
    );
    await confirmBookingRequestAct(deps, join());
    // OWED was recorded for a row that never existed (inert); nothing attached
    // and nothing dispatched.
    expect(lineupNotices.recordOwed).toHaveBeenCalledTimes(1);
    expect(eventHumans.attach).not.toHaveBeenCalled();
    expect(lineupNotices.dispatch).not.toHaveBeenCalled();
  });

  it("a GROUP that joins late lands linked by orgId with its name and page — and no person notice", async () => {
    const { deps, acts, lineup, lineupNotices } = buildDeps();
    await seedBill(acts);
    await confirmBookingRequestAct(deps, join(EDITOR, { asOrgId: MOTH }));

    // Moth sits at 4 on the bill; the last act above it that is on the
    // lineup is Junco (by name, which counts as present): right after it.
    expect(order(lineup)).toEqual(["sender", "hollow", "Junco", "moth"]);
    expect(lineup.find((r) => r.orgId === MOTH)).toMatchObject({
      humanId: null,
      externalName: "Paper Moth",
      externalUrl: "https://ithasfire.test/orgs/paper-moth",
    });
    expect(lineupNotices.recordOwed).not.toHaveBeenCalled();
    expect(lineupNotices.dispatch).not.toHaveBeenCalled();
  });

  it("a failing lineup notice never fails the committed join: logger.error + reportError", async () => {
    const { deps, acts, reportError, logger } = buildDeps({ noticeFails: true });
    await seedBill(acts);
    await expect(confirmBookingRequestAct(deps, join())).resolves.toMatchObject({ changed: true });
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.act_late_join_notice_failed",
      expect.any(Object),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { useCase: "answerBookingRequestAct", step: "lineup_notice" } }),
    );
  });
});

describe("lateJoinSlot", () => {
  it("appends when no joined act above it is on the lineup (never takes the headline by itself)", () => {
    const now = NOW;
    const act = (id: string, sortOrder: number, confirmation: "PENDING" | "CONFIRMED") => ({
      id,
      bookingRequestId: REQUEST_ID,
      source: "TAGGED" as const,
      actOwnerType: "human" as const,
      actOwnerId: id,
      externalName: null,
      externalUrl: null,
      role: "PERFORMER" as const,
      customRoleLabel: null,
      sortOrder,
      confirmation,
      invitedAt: now,
      respondedAt: null,
      declineReason: null,
      removedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    const lineupRow = (humanId: string) => ({
      id: `row-${humanId}`,
      eventId: EVENT_ID,
      humanId,
      orgId: null,
      externalName: null,
      externalUrl: null,
      role: "PERFORMER" as const,
      customRoleLabel: null,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
      profileSlug: null,
      humanDisplayName: null,
    });
    const headliner = act("h1", 0, "CONFIRMED");
    const second = act("h2", 1, "CONFIRMED");
    expect(
      lateJoinSlot({ lineup: [lineupRow("h2")], bill: [headliner, second], act: headliner, sender: null }),
    ).toBe(1);
    expect(
      lateJoinSlot({ lineup: [lineupRow("h1"), lineupRow("x")], bill: [headliner, second], act: second, sender: null }),
    ).toBe(1);
  });
});

describe("the sender hears every answer, in-app (v3 FR-012a)", () => {
  it("join → joined; pass → passed; leave → left", async () => {
    const joined = buildDeps({ event: { startsAt: STARTED } });
    await seedBill(joined.acts);
    await confirmBookingRequestAct(joined.deps, join());
    expect(joined.notifyBookingLineupAnswered).toHaveBeenCalledWith(
      expect.objectContaining({
        answer: "joined",
        actName: "Della",
        actorHumanId: DELLA,
        act: expect.objectContaining({ confirmation: "CONFIRMED" }),
      }),
    );
    await declineBookingRequestAct(joined.deps, join());
    expect(joined.notifyBookingLineupAnswered).toHaveBeenLastCalledWith(
      expect.objectContaining({ answer: "left" }),
    );

    const passed = buildDeps({ event: { startsAt: STARTED } });
    await seedBill(passed.acts);
    await declineBookingRequestAct(passed.deps, join(DELLA, { declineReason: "Out of town" }));
    expect(passed.notifyBookingLineupAnswered).toHaveBeenCalledWith(
      expect.objectContaining({ answer: "passed" }),
    );
    // The pass reason stays on the sender-only ledger entry (v3 L19); the
    // notice's payload never copies it (pinned in the notifier's suite).
    expect(passed.notifyBookingLineupAnswered.mock.calls[0]![0]).not.toHaveProperty("reason");
  });

  it("an idempotent repeat tells nobody", async () => {
    const { deps, acts, notifyBookingLineupAnswered } = buildDeps({ event: { startsAt: STARTED } });
    await seedBill(acts);
    await confirmBookingRequestAct(deps, join());
    await confirmBookingRequestAct(deps, join());
    expect(notifyBookingLineupAnswered).toHaveBeenCalledTimes(1);
  });

  it("a failing notifier never fails the committed answer: logger.error + reportError", async () => {
    const { deps, acts, reportError, logger } = buildDeps({
      answeredFails: true,
      event: { startsAt: STARTED },
    });
    await seedBill(acts);
    await expect(confirmBookingRequestAct(deps, join())).resolves.toMatchObject({ changed: true });
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.act_answer_notice_failed",
      expect.objectContaining({ answer: "joined" }),
    );
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { useCase: "answerBookingRequestAct", step: "lineup_answered" } }),
    );
  });
});

describe("a group's editor is re-checked under the lock (review carry-over)", () => {
  it("a role revoked between the pre-read and the lock answers BOOKING_REQUEST_NOT_FOUND and writes nothing", async () => {
    const { deps, acts, repos } = buildDeps({
      editorRoleRevokedAtLock: true,
      event: { startsAt: STARTED },
    });
    await seedBill(acts);
    await expect(
      confirmBookingRequestAct(deps, join(EDITOR, { asOrgId: MOTH })),
    ).rejects.toMatchObject({ code: "BOOKING_REQUEST_NOT_FOUND" });
    expect(
      (await acts.getActForOwner({
        bookingRequestId: REQUEST_ID,
        actOwnerType: "organization",
        actOwnerId: MOTH,
      }))?.confirmation,
    ).toBe("PENDING");
    expect(systemEntriesFor(repos, REQUEST_ID)).toEqual([]);
  });
});

describe("late join from an ORG sender", () => {
  it("names the group sender on the notice — as addedByOrgId, with no person", async () => {
    const { deps, acts, lineupNotices } = buildDeps({
      request: buildBookingRequestRecord({
        status: "ACCEPTED",
        agreementId: AGREEMENT_ID,
        billRecorded: true,
        performerOwnerType: "organization",
        performerOwnerId: ORG_ID,
      }),
    });
    await acts.addActs(REQUEST_ID, [
      { source: "TAGGED", actOwnerType: "human", actOwnerId: DELLA, sortOrder: 0, invitedAt: NOW },
    ]);
    await confirmBookingRequestAct(deps, join());
    // A group sender is no person: addedByHumanId null, the group in
    // addedByOrgId, its name for the copy.
    expect(lineupNotices.recordOwed).toHaveBeenCalledWith(
      expect.objectContaining({
        addedByHumanId: null,
        addedByOrgId: ORG_ID,
        addedByName: "Org",
      }),
    );
  });
});

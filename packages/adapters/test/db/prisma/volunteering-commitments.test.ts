/**
 * Unit coverage for the two per-human volunteer-signup reads that share one
 * projection: `listCommitmentsByHuman` (the `/my-volunteering` page) and
 * `listUpcomingSignupsForFeed` (the .ics feed).
 *
 * Stubbed Prisma rather than Postgres (same pattern as
 * notification-digests.test.ts) because everything worth pinning here is
 * adapter-side and invisible to a core test with a faked repo: the exact
 * `where` (an accidental status or date filter would silently amputate the
 * page), the row→record mapping, and the in-memory
 * `startsAt ASC NULLS LAST, createdAt DESC` sort.
 */
import { describe, expect, it, vi } from "vitest";

import {
  COMMITMENT_CLAIM_MAX_ROWS,
  COMMITMENTS_MAX_ROWS,
  makeVolunteeringRepo,
} from "../../../src/db/prisma/volunteering";
import type { PrismaClientOrTx } from "../../../src/db/prisma/types";

const HUMAN_ID = "human-1";
/** The caller clock — splits the claim read into upcoming / past. */
const NOW = new Date("2026-06-10T12:00:00Z");

/** Stands in for Prisma's `Decimal` — mapped via `toNumber()`. */
const decimal = (n: number) => ({ toNumber: () => n });

type Row = Record<string, unknown>;

function shiftRow(over: Row = {}): Row {
  return {
    id: "shift-signup",
    status: "APPROVED",
    eventId: "event-1",
    askId: "ask-event-1",
    hoursWorked: null,
    checkedInAt: null,
    createdAt: new Date("2026-06-01T00:00:00Z"),
    event: {
      title: "Block Party",
      slug: "block-party",
      timezone: "America/Chicago",
      addressText: "123 Test St",
    },
    ask: {
      title: "Block Party",
      cadence: "ONE_TIME",
      startsAt: null,
      endsAt: null,
      subjectType: "EVENT",
    },
    role: { name: "Setup", _count: { shifts: 2 } },
    shiftId: "shift-1",
    smsOptIn: true,
    contactPhone: "+16155550100",
    shift: {
      label: "Load-in",
      startsAt: new Date("2026-07-01T17:00:00Z"),
      endsAt: new Date("2026-07-01T20:00:00Z"),
    },
    ...over,
  };
}

function askRow(over: Row = {}): Row {
  return {
    id: "ask-signup",
    status: "PENDING",
    eventId: null,
    askId: "ask-1",
    hoursWorked: null,
    checkedInAt: null,
    createdAt: new Date("2026-06-02T00:00:00Z"),
    event: null,
    ask: {
      title: "Weekly food bank",
      cadence: "ONGOING",
      startsAt: new Date("2026-06-20T15:00:00Z"),
      endsAt: new Date("2026-06-20T18:00:00Z"),
      subjectType: "PLACE",
    },
    role: { name: "Sorter", _count: { shifts: 0 } },
    shiftId: null,
    smsOptIn: false,
    contactPhone: "  ",
    shift: null,
    ...over,
  };
}

/**
 * One `VolunteerOccurrenceClaim` row in `HUMAN_CLAIM_SELECT` shape — a
 * volunteer's commitment to ONE dated slot of a standing ask.
 *
 * `signup.status` defaults to APPROVED, the state a claim can actually be
 * made from (`CLAIMABLE_SIGNUP_STATUSES` is APPROVED | CHECKED_IN).
 */
function claimRow(over: Row = {}): Row {
  const occurrence = {
    id: "occ-1",
    askId: "ask-standing",
    startsAt: new Date("2026-09-03T23:00:00Z"),
    endsAt: new Date("2026-09-04T03:00:00Z"), // 4h
    status: "SCHEDULED",
    role: { name: "Door" },
    ask: {
      title: "Basement Thursdays",
      cadence: "RECURRING",
      subjectType: "PLACE",
      startsAt: new Date("2026-01-01T00:00:00Z"),
    },
    ...((over.occurrence as Row) ?? {}),
  };
  const signup = {
    id: "standing-signup",
    status: "APPROVED",
    eventId: null,
    shiftId: null,
    smsOptIn: true,
    contactPhone: "+16155550100",
    role: { _count: { shifts: 0 } },
    ...((over.signup as Row) ?? {}),
  };
  return {
    id: "claim-1",
    status: "CLAIMED",
    checkedInAt: null,
    hoursWorked: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...over,
    occurrence,
    signup,
  };
}

/**
 * `listCommitmentsByHuman` reads THREE bounded queries; the feed reads two
 * (signups only). `claimFindMany` is called twice — [0] upcoming, [1] past —
 * in the order the `Promise.all` array literal evaluates them.
 */
function makeRepo(
  findMany: ReturnType<typeof vi.fn>,
  claimFindMany: ReturnType<typeof vi.fn> = vi.fn(async () => []),
) {
  const prisma = {
    volunteerSignup: { findMany },
    volunteerOccurrenceClaim: { findMany: claimFindMany },
  };
  return makeVolunteeringRepo(prisma as unknown as PrismaClientOrTx);
}

/** Claim stub returning `upcoming` on the first call and `past` on the second. */
function claimStub(upcoming: Row[], past: Row[] = []) {
  return vi
    .fn()
    .mockResolvedValueOnce(upcoming)
    .mockResolvedValueOnce(past)
    .mockResolvedValue([]);
}

describe("volunteering repo – listCommitmentsByHuman", () => {
  it("queries the human's signups with NO status filter and NO date bound", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makeRepo(findMany);

    await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(findMany).toHaveBeenCalledTimes(1);
    const arg = findMany.mock.calls[0]![0] as { where: Record<string, unknown> };
    // Exact-equality, not objectContaining: a stray `status` / `shift` /
    // `ask` clause here is precisely the regression that would drop the
    // page's pending and history sections.
    expect(arg.where).toEqual({ humanId: HUMAN_ID });
  });

  it("returns every status, including the ones the .ics feed filters out", async () => {
    const statuses = [
      "PENDING",
      "APPROVED",
      "REJECTED",
      "WITHDRAWN",
      "CHECKED_IN",
      "NO_SHOW",
    ];
    const findMany = vi.fn(async () =>
      statuses.map((status, i) =>
        shiftRow({
          id: `s-${status}`,
          status,
          shift: {
            label: null,
            startsAt: new Date(Date.UTC(2026, 6, i + 1, 17)),
            endsAt: new Date(Date.UTC(2026, 6, i + 1, 20)),
          },
        }),
      ),
    );
    const repo = makeRepo(findMany);

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(rows.map((r) => r.status)).toEqual(statuses);
  });

  it("maps the event-shift path: window from the shift, title/venue from the event", async () => {
    const findMany = vi.fn(async () => [
      shiftRow({
        hoursWorked: decimal(4.5),
        checkedInAt: new Date("2026-07-01T17:05:00Z"),
        status: "CHECKED_IN",
      }),
    ]);
    const repo = makeRepo(findMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(row).toEqual({
      signupId: "shift-signup",
      // Signup rows are not occurrence rows — asserted here, in the ONE
      // exact-equality case, so the discriminator can't quietly go missing.
      claimId: null,
      occurrenceId: null,
      status: "CHECKED_IN",
      source: "EVENT_SHIFT",
      title: "Block Party",
      roleName: "Setup",
      shiftLabel: "Load-in",
      startsAt: new Date("2026-07-01T17:00:00Z"),
      endsAt: new Date("2026-07-01T20:00:00Z"),
      eventId: "event-1",
      eventSlug: "block-party",
      eventTimezone: "America/Chicago",
      addressText: "123 Test St",
      askId: "ask-event-1",
      hoursWorked: 4.5,
      // Override wins over the 3h scheduled window (17:00–20:00).
      hoursCredited: 4.5,
      checkedInAt: new Date("2026-07-01T17:05:00Z"),
      createdAt: new Date("2026-06-01T00:00:00Z"),
      cadence: "ONE_TIME",
      smsOptIn: true,
      hasContactPhone: true,
      reminderBasis: {
        shiftId: "shift-1",
        roleHasShifts: true,
        ask: { subjectType: "EVENT", cadence: "ONE_TIME", startsAt: null },
      },
    });
  });

  it("maps the ask path: window and title from the ask", async () => {
    const findMany = vi.fn(async () => [askRow()]);
    const repo = makeRepo(findMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(row).toMatchObject({
      signupId: "ask-signup",
      source: "ASK_WINDOW",
      title: "Weekly food bank",
      roleName: "Sorter",
      shiftLabel: null,
      startsAt: new Date("2026-06-20T15:00:00Z"),
      endsAt: new Date("2026-06-20T18:00:00Z"),
      eventId: null,
      eventSlug: null,
      askId: "ask-1",
    });
  });

  it("includes windowless rows with startsAt null (shiftless event signup, ask with no startsAt)", async () => {
    const findMany = vi.fn(async () => [
      // Shiftless EVENT signup — its backfilled EVENT ask carries no window.
      shiftRow({ id: "shiftless-event", shift: null }),
      // Ask signup on a standing ask with no window at all.
      askRow({
        id: "windowless-ask",
        ask: { title: "Standing help", startsAt: null, endsAt: null },
      }),
      // …and an ask-less shiftless event row (askId backfill miss).
      shiftRow({ id: "orphan", shift: null, askId: null, ask: null }),
    ]);
    const repo = makeRepo(findMany);

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(rows.map((r) => r.signupId).sort()).toEqual([
      "orphan",
      "shiftless-event",
      "windowless-ask",
    ]);
    expect(rows.every((r) => r.startsAt === null && r.endsAt === null)).toBe(
      true,
    );

    const byId = new Map(rows.map((r) => [r.signupId, r]));
    // Shiftless-with-ask reads as the ask path (matches the .ics feed's
    // classification), title from the ask.
    expect(byId.get("shiftless-event")).toMatchObject({
      source: "ASK_WINDOW",
      title: "Block Party",
      shiftLabel: null,
      // Still linkable: the event join survives on the ask path.
      eventId: "event-1",
      eventSlug: "block-party",
    });
    expect(byId.get("windowless-ask")).toMatchObject({
      source: "ASK_WINDOW",
      title: "Standing help",
    });
    // No ask to fall back to → event path, title from the event.
    expect(byId.get("orphan")).toMatchObject({
      source: "EVENT_SHIFT",
      title: "Block Party",
      askId: null,
    });
  });

  it("orders startsAt ASC with NULLS LAST, then createdAt DESC", async () => {
    const at = (iso: string) => new Date(iso);
    const findMany = vi.fn(async () => [
      // Deliberately shuffled.
      shiftRow({
        id: "windowless-older",
        shift: null,
        ask: { title: "A", startsAt: null, endsAt: null },
        createdAt: at("2026-05-05T00:00:00Z"),
      }),
      shiftRow({
        id: "same-start-older",
        shift: {
          label: null,
          startsAt: at("2026-08-01T17:00:00Z"),
          endsAt: null,
        },
        createdAt: at("2026-06-01T00:00:00Z"),
      }),
      shiftRow({
        id: "windowless-newer",
        shift: null,
        ask: { title: "B", startsAt: null, endsAt: null },
        createdAt: at("2026-06-05T00:00:00Z"),
      }),
      shiftRow({
        id: "same-start-newer",
        shift: {
          label: null,
          startsAt: at("2026-08-01T17:00:00Z"),
          endsAt: null,
        },
        createdAt: at("2026-06-09T00:00:00Z"),
      }),
      // Past row — proves the read is not forward-looking.
      shiftRow({
        id: "past",
        shift: {
          label: null,
          startsAt: at("2025-01-05T17:00:00Z"),
          endsAt: null,
        },
        createdAt: at("2024-12-01T00:00:00Z"),
      }),
    ]);
    const repo = makeRepo(findMany);

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(rows.map((r) => r.signupId)).toEqual([
      "past",
      "same-start-newer",
      "same-start-older",
      "windowless-newer",
      "windowless-older",
    ]);
  });

  // ── hoursCredited ──────────────────────────────────────────────────────

  it("EVENT_SHIFT with no override derives hours from the shift — null is NOT zero", async () => {
    // The exact production row that rendered "0 HOURS THIS YEAR": a
    // CHECKED_IN 4-hour shift whose hoursWorked override is null.
    const findMany = vi.fn(async () => [
      shiftRow({
        id: "checked-in-no-override",
        status: "CHECKED_IN",
        hoursWorked: null,
        shift: {
          label: null,
          startsAt: new Date("2026-08-15T21:00:00Z"),
          endsAt: new Date("2026-08-16T01:00:00Z"),
        },
      }),
    ]);
    const repo = makeRepo(findMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(row!.hoursWorked).toBeNull();
    expect(row!.hoursCredited).toBe(4);
  });

  it("EVENT_SHIFT override wins over the derivable duration", async () => {
    const findMany = vi.fn(async () => [
      shiftRow({
        id: "override",
        status: "CHECKED_IN",
        // 4-hour scheduled shift, but the admin recorded 2.5.
        hoursWorked: decimal(2.5),
      }),
    ]);
    const repo = makeRepo(findMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(row!.hoursCredited).toBe(2.5);
    // The raw override is still exposed unchanged alongside it.
    expect(row!.hoursWorked).toBe(2.5);
  });

  /**
   * GUARD — do not delete, do not "simplify" the branch this pins.
   *
   * A standing ask's window legitimately spans months. If someone collapses
   * `mapCommitment`'s carve-out into one unconditional `creditedHours(...)`
   * call, this row would be credited with ~2200 hours on a statement a
   * volunteer submits for school service credit or grant reporting.
   */
  it("ASK_WINDOW never derives hours from the ask window, however long", async () => {
    const findMany = vi.fn(async () => [
      askRow({
        id: "season-long-ask",
        status: "CHECKED_IN",
        hoursWorked: null,
        ask: {
          title: "Help out this season",
          startsAt: new Date("2026-03-01T00:00:00Z"),
          endsAt: new Date("2026-06-01T00:00:00Z"), // ~92 days = ~2208h
        },
      }),
    ]);
    const repo = makeRepo(findMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(row!.source).toBe("ASK_WINDOW");
    // The window IS exposed (the page renders it as a date range)…
    expect(row!.startsAt).toEqual(new Date("2026-03-01T00:00:00Z"));
    expect(row!.endsAt).toEqual(new Date("2026-06-01T00:00:00Z"));
    // …but it is NEVER hours.
    expect(row!.hoursCredited).toBeNull();
  });

  it("ASK_WINDOW with an override credits exactly the override", async () => {
    const findMany = vi.fn(async () => [
      askRow({
        id: "ask-with-override",
        status: "CHECKED_IN",
        hoursWorked: decimal(6),
        ask: {
          title: "Help out this season",
          startsAt: new Date("2026-03-01T00:00:00Z"),
          endsAt: new Date("2026-06-01T00:00:00Z"),
        },
      }),
    ]);
    const repo = makeRepo(findMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(row!.hoursCredited).toBe(6);
  });

  it("windowless row with no override credits null", async () => {
    const findMany = vi.fn(async () => [
      shiftRow({
        id: "orphan-windowless",
        shift: null,
        ask: null,
        askId: null,
        hoursWorked: null,
      }),
    ]);
    const repo = makeRepo(findMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(row!.startsAt).toBeNull();
    expect(row!.hoursCredited).toBeNull();
  });

  it("bounds the read: DB-level createdAt DESC + take, so truncation drops the OLDEST rows", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makeRepo(findMany);

    await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    const arg = findMany.mock.calls[0]![0] as {
      orderBy: unknown;
      take: number;
    };
    expect(arg.take).toBe(COMMITMENTS_MAX_ROWS);
    // The DB order is deliberately createdAt DESC, NOT the caller-facing
    // sort: it decides WHICH rows survive the cap. Anything else (or no
    // orderBy at all) could truncate away a volunteer's next shift.
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
  });

  // ── cadence ─────────────────────────────────────────────────────────────

  it("carries the ask's cadence, and null when the row has no ask at all", async () => {
    const findMany = vi.fn(async () => [
      // Event-shift row on an EVENT-subject ask — the ask is real, so its
      // cadence is real.
      shiftRow({ id: "event-shift" }),
      // Standing ask row.
      askRow({ id: "ongoing-ask" }),
      // PURE event-shift row: askId backfill miss, no ask to read.
      shiftRow({ id: "orphan", askId: null, ask: null }),
    ]);
    const repo = makeRepo(findMany);

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);
    const byId = new Map(rows.map((r) => [r.signupId, r.cadence]));

    expect(byId.get("event-shift")).toBe("ONE_TIME");
    expect(byId.get("ongoing-ask")).toBe("ONGOING");
    expect(byId.get("orphan")).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════
// Occurrence claims — one row per claimed dated slot on a standing ask
// ══════════════════════════════════════════════════════════════════════════

describe("volunteering repo – listCommitmentsByHuman (occurrence claims)", () => {
  it("reads only CLAIMED claims on SCHEDULED occurrences, split at `now`", async () => {
    // WITHDRAWN claims and CANCELLED occurrences are excluded IN SQL, so
    // the `where` is the only place that exclusion is observable — a stub
    // cannot filter for us. Exact equality, not objectContaining: dropping
    // `status: "CLAIMED"` would resurrect shifts the volunteer dropped, and
    // dropping the occurrence status would show them cancelled slots as if
    // they were still on.
    const claimFindMany = claimStub([], []);
    const repo = makeRepo(vi.fn(async () => []), claimFindMany);

    await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(claimFindMany).toHaveBeenCalledTimes(2);
    const [upcoming, past] = claimFindMany.mock.calls as unknown as [
      [{ where: Record<string, unknown>; orderBy: unknown; take: number }],
      [{ where: Record<string, unknown>; orderBy: unknown; take: number }],
    ];

    expect(upcoming[0].where).toEqual({
      status: "CLAIMED",
      signup: { humanId: HUMAN_ID },
      occurrence: { status: "SCHEDULED", startsAt: { gte: NOW } },
    });
    expect(past[0].where).toEqual({
      status: "CLAIMED",
      signup: { humanId: HUMAN_ID },
      occurrence: { status: "SCHEDULED", startsAt: { lt: NOW } },
    });
  });

  /**
   * GUARD — the truncation property the single-query version could not make.
   *
   * The upcoming bucket is ordered ASC so the cap can only ever drop the
   * FURTHEST-OUT slot; the past bucket DESC so it can only drop the oldest.
   * DESC on the upcoming bucket would keep a volunteer's 2029 dates and
   * truncate away the shift they are working on Thursday.
   */
  it("bounds each claim bucket in the direction that protects upcoming slots", async () => {
    const claimFindMany = claimStub([], []);
    const repo = makeRepo(vi.fn(async () => []), claimFindMany);

    await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    const [upcoming, past] = claimFindMany.mock.calls as unknown as [
      [{ orderBy: unknown; take: number }],
      [{ orderBy: unknown; take: number }],
    ];

    expect(upcoming[0].take).toBe(COMMITMENT_CLAIM_MAX_ROWS);
    expect(upcoming[0].orderBy).toEqual({ occurrence: { startsAt: "asc" } });
    expect(past[0].take).toBe(COMMITMENT_CLAIM_MAX_ROWS);
    expect(past[0].orderBy).toEqual({ occurrence: { startsAt: "desc" } });
    // Claims are capped SEPARATELY from signups: a standing volunteer's
    // three years of Tuesdays must not evict their event signups.
    expect(COMMITMENT_CLAIM_MAX_ROWS).toBeLessThanOrEqual(COMMITMENTS_MAX_ROWS);
  });

  it("emits one row per claim with the OCCURRENCE's window, role, title and cadence", async () => {
    // The parent standing ask is open-ended and windowless — the exact row
    // that used to render "No set shift time". The volunteer's real dates
    // live on the occurrences.
    const parent = askRow({
      id: "standing-signup",
      status: "APPROVED",
      askId: "ask-standing",
      ask: {
        title: "Basement Thursdays",
        cadence: "RECURRING",
        startsAt: new Date("2026-01-01T00:00:00Z"),
        endsAt: null,
      },
    });
    const claimFindMany = claimStub([
      claimRow({ id: "claim-sep-3" }),
      claimRow({
        id: "claim-sep-10",
        occurrence: {
          id: "occ-2",
          startsAt: new Date("2026-09-10T23:00:00Z"),
          endsAt: new Date("2026-09-11T03:00:00Z"),
        },
      }),
    ]);
    const repo = makeRepo(vi.fn(async () => [parent]), claimFindMany);

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(rows.map((r) => r.claimId)).toEqual(["claim-sep-3", "claim-sep-10"]);
    expect(rows[0]).toEqual({
      // The PARENT signup's id — repeated across both rows, which is why
      // row identity is `claimId ?? signupId`.
      signupId: "standing-signup",
      claimId: "claim-sep-3",
      occurrenceId: "occ-1",
      status: "APPROVED",
      source: "ASK_WINDOW",
      title: "Basement Thursdays",
      roleName: "Door",
      shiftLabel: null,
      // THE POINT: the occurrence's window, NOT the ask's (2026-01-01, open).
      startsAt: new Date("2026-09-03T23:00:00Z"),
      endsAt: new Date("2026-09-04T03:00:00Z"),
      eventId: null,
      eventSlug: null,
      eventTimezone: null,
      addressText: null,
      askId: "ask-standing",
      hoursWorked: null,
      // 4h occurrence — derived, because an occurrence IS a bounded shift.
      hoursCredited: 4,
      checkedInAt: null,
      // The CLAIM's creation date, not the signup's.
      createdAt: new Date("2026-08-01T00:00:00Z"),
      cadence: "RECURRING",
      // The PARENT signup's opt-in and anchor facts; the phone is a boolean.
      smsOptIn: true,
      hasContactPhone: true,
      reminderBasis: {
        shiftId: null,
        roleHasShifts: false,
        ask: {
          subjectType: "PLACE",
          cadence: "RECURRING",
          startsAt: new Date("2026-01-01T00:00:00Z"),
        },
      },
    });
    expect(rows[1]!.startsAt).toEqual(new Date("2026-09-10T23:00:00Z"));
  });

  /**
   * GUARD — do not delete.
   *
   * The de-duplication rule this whole phase exists for. A standing
   * volunteer whose ask is open-ended used to see their parent signup
   * rendered with the ASK's window ("No set shift time") sitting beside
   * their actual claimed dates: the same commitment stated twice, once
   * wrongly.
   */
  it("suppresses the bare parent signup row when it produced occurrence rows", async () => {
    const parent = askRow({
      id: "standing-signup",
      status: "APPROVED",
      askId: "ask-standing",
      ask: {
        title: "Basement Thursdays",
        cadence: "RECURRING",
        startsAt: new Date("2026-01-01T00:00:00Z"),
        endsAt: null,
      },
    });
    const claimFindMany = claimStub([claimRow()]);
    const repo = makeRepo(vi.fn(async () => [parent]), claimFindMany);

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.claimId).toBe("claim-1");
    // No windowless phantom of the parent.
    expect(rows.some((r) => r.claimId === null)).toBe(false);
  });

  it("keeps the parent row when the signup has NO claims", async () => {
    const parent = askRow({ id: "standing-signup" });
    const repo = makeRepo(vi.fn(async () => [parent]), claimStub([], []));

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      signupId: "standing-signup",
      claimId: null,
      occurrenceId: null,
      source: "ASK_WINDOW",
    });
  });

  it("does not suppress a parent whose claims produced NO rows (cancelled / truncated away)", async () => {
    // Both exclusions happen in SQL, so from this layer they look identical:
    // the claim queries simply come back empty. Suppression keys off rows
    // ACTUALLY EMITTED, so the volunteer is never left with nothing.
    const parent = askRow({ id: "standing-signup", askId: "ask-standing" });
    const repo = makeRepo(vi.fn(async () => [parent]), claimStub([], []));

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(rows.map((r) => r.signupId)).toEqual(["standing-signup"]);
  });

  it("keeps a parent that carries its OWN check-in or hours — it is not a duplicate", async () => {
    // `checkInVolunteer` stamps `role.defaultHours` onto the SIGNUP at
    // ask-level check-in. Those hours exist nowhere else in the result, so
    // suppressing this row would silently delete credited hours from a
    // volunteer's service statement.
    const parent = askRow({
      id: "standing-signup",
      status: "CHECKED_IN",
      askId: "ask-standing",
      checkedInAt: new Date("2026-05-01T18:00:00Z"),
      hoursWorked: decimal(3),
    });
    const repo = makeRepo(vi.fn(async () => [parent]), claimStub([claimRow()]));

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(rows).toHaveLength(2);
    const parentRow = rows.find((r) => r.claimId === null)!;
    expect(parentRow).toMatchObject({
      signupId: "standing-signup",
      status: "CHECKED_IN",
      hoursWorked: 3,
      hoursCredited: 3,
    });
  });

  // ── status + hours on occurrence rows ──────────────────────────────────

  it("a checked-in claim reads CHECKED_IN with the occurrence's hours", async () => {
    const claimFindMany = claimStub([], [
      claimRow({
        id: "worked",
        checkedInAt: new Date("2026-05-07T23:02:00Z"),
        occurrence: {
          startsAt: new Date("2026-05-07T23:00:00Z"),
          endsAt: new Date("2026-05-08T02:30:00Z"), // 3.5h
        },
      }),
    ]);
    const repo = makeRepo(vi.fn(async () => []), claimFindMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(row).toMatchObject({
      claimId: "worked",
      status: "CHECKED_IN",
      checkedInAt: new Date("2026-05-07T23:02:00Z"),
      hoursWorked: null,
      hoursCredited: 3.5,
    });
  });

  it("a per-occurrence hours override wins over the occurrence duration", async () => {
    const claimFindMany = claimStub([], [
      claimRow({
        id: "short-night",
        checkedInAt: new Date("2026-05-07T23:02:00Z"),
        hoursWorked: decimal(1.25),
      }),
    ]);
    const repo = makeRepo(vi.fn(async () => []), claimFindMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    // The claim's own override (checkInOccurrenceClaim), never the parent's.
    expect(row!.hoursWorked).toBe(1.25);
    expect(row!.hoursCredited).toBe(1.25);
  });

  /**
   * GUARD — do not delete, do not "simplify".
   *
   * A parent CHECKED_IN at the ASK level says the volunteer turned up ONCE.
   * It says nothing about the six Thursdays they have merely claimed.
   * Inheriting it would mark every unworked slot CHECKED_IN, and CHECKED_IN
   * is the gate the totals band and the printable service statement count
   * on — so each future slot would be billed at its full duration to a
   * school registrar.
   */
  it("an un-worked claim under a CHECKED_IN parent reads APPROVED, not CHECKED_IN", async () => {
    const claimFindMany = claimStub([
      claimRow({
        id: "future-slot",
        checkedInAt: null,
        signup: { status: "CHECKED_IN" },
      }),
    ]);
    const repo = makeRepo(vi.fn(async () => []), claimFindMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(row!.status).toBe("APPROVED");
    expect(row!.checkedInAt).toBeNull();
    // The hours are still exposed (the slot has a real duration) — it is
    // the STATUS that stops them being counted as worked.
    expect(row!.hoursCredited).toBe(4);
  });

  it("a revoked parent carries through — the volunteer must see they are off the roster", async () => {
    const claimFindMany = claimStub([
      claimRow({ id: "revoked", signup: { status: "REJECTED" } }),
    ]);
    const repo = makeRepo(vi.fn(async () => []), claimFindMany);

    const [row] = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(row!.status).toBe("REJECTED");
  });

  /**
   * GUARD — the 2208-hour failure mode, on the row type most likely to end
   * up on a service statement.
   *
   * A standing ask's window legitimately spans months. Occurrence rows are
   * the ONE place hours are derived on the ask path, so if someone reaches
   * for `ask.startsAt/endsAt` here — the fields sitting right there on the
   * joined ask — a single claimed Thursday night is credited as ~2200 hours.
   */
  it("occurrence hours come from the OCCURRENCE window, never the season-long ask window", async () => {
    const claimFindMany = claimStub([], [
      claimRow({
        id: "one-night",
        checkedInAt: new Date("2026-05-07T23:02:00Z"),
        occurrence: {
          startsAt: new Date("2026-05-07T23:00:00Z"),
          endsAt: new Date("2026-05-08T03:00:00Z"), // 4h
          // THE TRAP, deliberately baited: the joined ask carries a
          // season-long window (1 Mar – 1 Jun, ~92 days = ~2208 hours)
          // even though `HUMAN_CLAIM_SELECT` does not project it. Reaching
          // for `ask.startsAt/endsAt` here credits 2208 hours and this test
          // says so out loud (verified by planting exactly that change).
          ask: {
            title: "Help out this season",
            cadence: "ONGOING",
            startsAt: new Date("2026-03-01T00:00:00Z"),
            endsAt: new Date("2026-06-01T00:00:00Z"),
          },
        },
      }),
    ]);
    const repo = makeRepo(
      // The parent signup carries that season-long window…
      vi.fn(async () => [
        askRow({
          id: "standing-signup",
          askId: "ask-standing",
          ask: {
            title: "Help out this season",
            cadence: "ONGOING",
            startsAt: new Date("2026-03-01T00:00:00Z"),
            endsAt: new Date("2026-06-01T00:00:00Z"),
          },
        }),
      ]),
      claimFindMany,
    );

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);
    const occurrenceRow = rows.find((r) => r.claimId === "one-night")!;

    expect(occurrenceRow.hoursCredited).toBe(4);
    // …and it is nowhere near the ask window, in either direction.
    expect(occurrenceRow.hoursCredited).toBeLessThan(24);
    expect(occurrenceRow.startsAt).toEqual(new Date("2026-05-07T23:00:00Z"));
    expect(occurrenceRow.endsAt).toEqual(new Date("2026-05-08T03:00:00Z"));
  });

  // ── ordering ────────────────────────────────────────────────────────────

  it("interleaves occurrence rows with signup rows by startsAt, nulls last", async () => {
    const findMany = vi.fn(async () => [
      shiftRow({
        id: "event-shift",
        shift: {
          label: null,
          startsAt: new Date("2026-09-05T17:00:00Z"),
          endsAt: new Date("2026-09-05T20:00:00Z"),
        },
      }),
      // Windowless standing ask with no claims — stays, and sorts last.
      askRow({
        id: "windowless",
        askId: "ask-other",
        ask: { title: "Standing help", cadence: "ONGOING", startsAt: null, endsAt: null },
      }),
    ]);
    const claimFindMany = claimStub(
      [
        claimRow({
          id: "claim-sep-10",
          occurrence: {
            id: "occ-2",
            startsAt: new Date("2026-09-10T23:00:00Z"),
            endsAt: new Date("2026-09-11T03:00:00Z"),
          },
        }),
      ],
      [
        claimRow({
          id: "claim-past",
          occurrence: {
            id: "occ-0",
            startsAt: new Date("2026-05-07T23:00:00Z"),
            endsAt: new Date("2026-05-08T03:00:00Z"),
          },
        }),
      ],
    );
    const repo = makeRepo(findMany, claimFindMany);

    const rows = await repo.listCommitmentsByHuman(HUMAN_ID, NOW);

    expect(rows.map((r) => r.claimId ?? r.signupId)).toEqual([
      "claim-past", // 2026-05-07
      "event-shift", // 2026-09-05
      "claim-sep-10", // 2026-09-10
      "windowless", // no start — always last
    ]);
  });
});

describe("volunteering repo – listUpcomingSignupsForFeed (shared projection regression)", () => {
  const FROM = new Date("2026-06-01T00:00:00Z");

  it("still filters to accepted statuses and the `from` bound on both paths", async () => {
    const findMany = vi.fn(async () => []);
    const repo = makeRepo(findMany);

    await repo.listUpcomingSignupsForFeed(HUMAN_ID, FROM);

    expect(findMany).toHaveBeenCalledTimes(2);
    const [shiftCall, askCall] = findMany.mock.calls as unknown as [
      [{ where: Record<string, unknown> }],
      [{ where: Record<string, unknown> }],
    ];
    expect(shiftCall[0].where).toEqual({
      humanId: HUMAN_ID,
      status: { in: ["APPROVED", "CHECKED_IN"] },
      shift: { startsAt: { gte: FROM } },
    });
    expect(askCall[0].where).toEqual({
      humanId: HUMAN_ID,
      status: { in: ["APPROVED", "CHECKED_IN"] },
      shiftId: null,
      askId: { not: null },
      ask: { startsAt: { gte: FROM } },
    });
  });

  /**
   * The regression that slipped review once already.
   *
   * Sharing `HUMAN_SIGNUP_SELECT` made the feed's ask-path query start
   * joining the event, which the PAGE wants and the FEED must not gain —
   * enriched ask-path rows would add LOCATION/URL to VEVENTs in calendars
   * people are already subscribed to.
   *
   * It is reachable, not theoretical: `volunteerSubjectTypeSchema` includes
   * "EVENT" and `updateVolunteerAsk` never inspects `subjectType` while
   * accepting `startsAt`, so an EVENT-subject ask WITH a window exists via
   * the API. `resolveOrCreateEventAsk` adopts it, event-path signups stamp
   * its askId, and a shiftless APPROVED signup then matches the feed's
   * ask-path `where` verbatim while carrying an `eventId` — exactly the row
   * below.
   *
   * Both sides are asserted in ONE test so the two code paths can never
   * drift apart again.
   */
  it("ask-path row with an eventId: the PAGE gets the event fields, the FEED still gets nulls", async () => {
    const askPathRowOnAnEvent = askRow({
      id: "event-ask-windowed",
      status: "APPROVED",
      // The tell-tale combination: ask-path (no shift) but event-bound.
      eventId: "event-1",
      askId: "ask-event-1",
      event: {
        title: "Block Party",
        slug: "block-party",
        timezone: "America/Chicago",
        addressText: "123 Test St",
      },
      ask: {
        title: "Block Party",
        startsAt: new Date("2026-06-20T15:00:00Z"),
        endsAt: new Date("2026-06-20T18:00:00Z"),
      },
    });

    // Page side.
    const pageRepo = makeRepo(vi.fn(async () => [askPathRowOnAnEvent]));
    const [commitment] = await pageRepo.listCommitmentsByHuman(HUMAN_ID, NOW);
    expect(commitment).toMatchObject({
      signupId: "event-ask-windowed",
      source: "ASK_WINDOW",
      eventId: "event-1",
      eventSlug: "block-party",
      eventTimezone: "America/Chicago",
      addressText: "123 Test St",
    });

    // Feed side — same row, same projection, byte-identical to the output
    // before the projection was shared.
    const feedRepo = makeRepo(
      vi
        .fn()
        .mockResolvedValueOnce([]) // shift path
        .mockResolvedValueOnce([askPathRowOnAnEvent]), // ask path
    );
    const feed = await feedRepo.listUpcomingSignupsForFeed(HUMAN_ID, FROM);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      signupId: "event-ask-windowed",
      source: "ASK_WINDOW",
      title: "Block Party",
      // eventId was ALWAYS carried on the ask path — that part is unchanged.
      eventId: "event-1",
      // …but these three were hard-coded null before, and must stay null.
      eventSlug: null,
      eventTimezone: null,
      addressText: null,
    });
  });

  /**
   * The occurrence phase must not touch calendars people are already
   * subscribed to. Standing-shift occurrences in the .ics feed ship as
   * their own reviewed change — not as a side effect of a page read model,
   * which is exactly how the event-field enrichment nearly leaked before.
   */
  it("occurrence claims never reach the feed — it does not even read the claim table", async () => {
    const claimFindMany = claimStub([claimRow()], [claimRow({ id: "past" })]);
    const repo = makeRepo(
      vi
        .fn()
        .mockResolvedValueOnce([shiftRow()]) // shift path
        .mockResolvedValueOnce([]), // ask path
      claimFindMany,
    );

    const feed = await repo.listUpcomingSignupsForFeed(HUMAN_ID, FROM);

    expect(claimFindMany).not.toHaveBeenCalled();
    expect(feed.map((f) => f.signupId)).toEqual(["shift-signup"]);
    // …and no feed row grew an occurrence field.
    expect(feed.every((f) => !("occurrenceId" in f) && !("claimId" in f))).toBe(
      true,
    );
  });

  it("shift-path feed row is unchanged: event title/venue still populated", async () => {
    // The mirror of the case above — nulling the ask path must not touch
    // the event path. (Also covered end-to-end in
    // test/integration/volunteering-asks.test.ts, but that suite skips
    // itself when no database is reachable, so the proof lives here too.)
    const findMany = vi
      .fn()
      .mockResolvedValueOnce([shiftRow()])
      .mockResolvedValueOnce([]);
    const repo = makeRepo(findMany);

    const feed = await repo.listUpcomingSignupsForFeed(HUMAN_ID, FROM);

    expect(feed[0]).toEqual({
      signupId: "shift-signup",
      status: "APPROVED",
      source: "EVENT_SHIFT",
      title: "Block Party",
      roleName: "Setup",
      shiftLabel: "Load-in",
      startsAt: new Date("2026-07-01T17:00:00Z"),
      endsAt: new Date("2026-07-01T20:00:00Z"),
      eventId: "event-1",
      eventSlug: "block-party",
      eventTimezone: "America/Chicago",
      addressText: "123 Test St",
      askId: "ask-event-1",
    });
  });

  it("drops windowless rows, sorts soonest-first, and carries no page-only fields", async () => {
    const findMany = vi
      .fn()
      // Shift path: one dated row plus a windowless straggler.
      .mockResolvedValueOnce([
        shiftRow({ id: "dated", hoursWorked: decimal(2) }),
        shiftRow({ id: "windowless", shift: null, ask: null, askId: null }),
      ])
      // Ask path: an earlier dated row.
      .mockResolvedValueOnce([askRow({ id: "ask-dated" })]);
    const repo = makeRepo(findMany);

    const feed = await repo.listUpcomingSignupsForFeed(HUMAN_ID, FROM);

    expect(feed.map((r) => r.signupId)).toEqual(["ask-dated", "dated"]);
    // Feed rows are the narrow shape — the page-only fields must not leak.
    expect(Object.keys(feed[0]!).sort()).toEqual(
      [
        "addressText",
        "askId",
        "endsAt",
        "eventId",
        "eventSlug",
        "eventTimezone",
        "roleName",
        "shiftLabel",
        "signupId",
        "source",
        "startsAt",
        "status",
        "title",
      ].sort(),
    );
  });
});

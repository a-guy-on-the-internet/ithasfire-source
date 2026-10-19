/**
 * `listMyVolunteerCommitments` is a near one-line delegation to
 * `tx.volunteering.listCommitmentsByHuman`, so READ THESE FOR WHAT THEY
 * ARE. Only four cases here verify something the use case itself owns:
 * the self-read scoping (an actor can never reach another human's rows),
 * that the repo is handed `deps.clock.now()` rather than reaching for a
 * wall clock of its own, and the two `invalid_input` boundary cases.
 *
 * The status / window / ordering cases assert that a fake's return value
 * survives the delegation — i.e. that core does NOT filter or re-sort on
 * the way out. They are NOT independent verification that those
 * guarantees hold. The real coverage for "all six statuses", "windowless
 * rows included", "past rows included" and "startsAt ASC nulls last,
 * createdAt DESC" lives where the behaviour actually is:
 *
 *   - packages/adapters/test/db/prisma/volunteering-commitments.test.ts
 *     (stubbed Prisma — always runs)
 *   - packages/adapters/test/integration/volunteering-asks.test.ts
 *     (real Postgres — skips when no database is reachable)
 */
import { describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type {
  VolunteerCommitmentRecord,
  VolunteerSignupStatus,
} from "@th/ports/repos/volunteering";

import { listMyVolunteerCommitments } from "./volunteer-signups";
import type { VolunteerSignupDeps } from "./volunteer-signups";

// ── Constants ────────────────────────────────────────────────────────────────

const ACTOR_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_HUMAN_ID = "00000000-0000-4000-8000-000000000002";
const EVENT_ID = "00000000-0000-4000-8000-000000000003";
const ASK_ID = "00000000-0000-4000-8000-000000000004";
const EVENT_ASK_ID = "00000000-0000-4000-8000-0000000000e1";
const NOW = new Date("2026-06-10T12:00:00.000Z");
const LIVE_ORG_ID = "00000000-0000-4000-8000-0000000000ab";

const ALL_STATUSES: VolunteerSignupStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
  "CHECKED_IN",
  "NO_SHOW",
];

// ── Fixtures ─────────────────────────────────────────────────────────────────

function commitment(
  over: Partial<VolunteerCommitmentRecord> & { signupId: string },
): VolunteerCommitmentRecord {
  return {
    claimId: null,
    occurrenceId: null,
    status: "APPROVED",
    source: "EVENT_SHIFT",
    title: "Neighbourhood Block Party",
    roleName: "Setup",
    shiftLabel: "Load-in",
    startsAt: new Date("2026-07-01T17:00:00.000Z"),
    endsAt: new Date("2026-07-01T20:00:00.000Z"),
    eventId: EVENT_ID,
    eventSlug: "block-party",
    eventTimezone: "America/Chicago",
    addressText: "123 Test St",
    // Production (`mapCommitment`) passes the event's own ask id.
    askId: EVENT_ASK_ID,
    hoursWorked: null,
    // Derived by the adapter from the 3h shift window above; core passes it
    // through untouched. The rule itself is tested in
    // packages/core/src/lib/__tests__/volunteer-hours.test.ts and the
    // ask-window carve-out in the adapter suite.
    hoursCredited: 3,
    checkedInAt: null,
    createdAt: NOW,
    cadence: null,
    smsOptIn: false,
    hasContactPhone: false,
    // Default: an event-shift signup (a SHIFT anchor).
    reminderBasis: { shiftId: "shift-1", roleHasShifts: true, ask: null },
    ...over,
  };
}

/** What the use case returns for a fixture: no basis, a derived flag. */
function listed(
  row: VolunteerCommitmentRecord,
  over: {
    signupsPaused?: boolean;
    textRemindersOffered?: boolean;
    reminderAnchor?: "SHIFT" | "EVENT_START" | "ASK_START" | null;
  } = {},
) {
  const { reminderBasis: _basis, ...rest } = row;
  return {
    ...rest,
    signupsPaused: false,
    textRemindersOffered: true,
    reminderAnchor: "SHIFT" as const,
    ...over,
  };
}

// ── Mock builder ─────────────────────────────────────────────────────────────

/**
 * The use case is a thin authenticated self-read, so the fake repo is
 * keyed by humanId: anything the actor does NOT own is unreachable by
 * construction, which is exactly the property the last test asserts.
 */
function makeDeps(rowsByHuman: Record<string, VolunteerCommitmentRecord[]>) {
  const txRepos = {
    volunteering: {
      listCommitmentsByHuman: vi.fn(
        async (humanId: string) => rowsByHuman[humanId] ?? [],
      ),
      // Ban that sticks: every ask here is owned by a (live) org unless a
      // test says otherwise.
      listAskOwnersByIds: vi.fn(async (askIds: string[]) =>
        askIds.map((id) =>
          id === EVENT_ASK_ID
            ? {
                id,
                subjectType: "EVENT" as const,
                subjectId: EVENT_ID,
                eventOwner: { humanId: null, orgId: LIVE_ORG_ID },
              }
            : {
                id,
                subjectType: "ORG" as const,
                subjectId: LIVE_ORG_ID,
              },
        ),
      ),
    },
    bans: {
      findBannedOwners: vi.fn(async () => ({
        humanIds: [] as string[],
        orgIds: [] as string[],
      })),
    },
    // The venue line goes through the holder-address gate. These events are
    // EXPLICITLY EXACT with no venue (the gate fails closed on a missing
    // `locationMode`), and hold the same street the rows carry, so every
    // assertion below sees exactly what the repo returned.
    events: {
      findManyByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({
          id,
          locationMode: "EXACT",
          locationRadiusMeters: null,
          addressRevealAt: null,
          addressRevealPreset: null,
          placeId: null,
          addressText: "123 Test St",
          locality: null,
          region: null,
          locationLabel: null,
          lat: null,
          lng: null,
        })),
      ),
    },
    places: { getById: vi.fn(async () => null) },
  };
  const deps: VolunteerSignupDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: TxRepos) => Promise<unknown>) =>
        fn(txRepos as unknown as TxRepos),
      ),
    } as unknown as Repos,
    authz: { hasStaffRole: vi.fn(async () => false) },
    clock: { now: () => NOW },
    notify: vi.fn(async () => ({}) as never),
    appBaseUrl: "https://example.test",
  };
  return { deps, txRepos };
}

// ══════════════════════════════════════════════════════════════════════════════
// listMyVolunteerCommitments
// ══════════════════════════════════════════════════════════════════════════════

describe("listMyVolunteerCommitments", () => {
  it("reads the actor's rows via listCommitmentsByHuman", async () => {
    const rows = [commitment({ signupId: "s1" })];
    const { deps, txRepos } = makeDeps({ [ACTOR_ID]: rows });

    const result = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(result).toEqual(rows.map((r) => listed(r)));
    expect(txRepos.volunteering.listCommitmentsByHuman).toHaveBeenCalledWith(
      ACTOR_ID,
      NOW,
    );
    expect(deps.repos.tx).toHaveBeenCalledTimes(1);
  });

  it("returns rows in ALL SIX statuses — not just the feed's APPROVED | CHECKED_IN", async () => {
    const rows = ALL_STATUSES.map((status, i) =>
      commitment({
        signupId: `s-${status}`,
        status,
        startsAt: new Date(Date.UTC(2026, 6, i + 1, 17)),
        endsAt: new Date(Date.UTC(2026, 6, i + 1, 20)),
      }),
    );
    const { deps } = makeDeps({ [ACTOR_ID]: rows });

    const result = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(result.map((r) => r.status)).toEqual(ALL_STATUSES);
  });

  it("includes past-dated rows (no `from` bound, unlike the .ics feed)", async () => {
    const past = commitment({
      signupId: "past",
      status: "CHECKED_IN",
      startsAt: new Date("2025-01-05T17:00:00.000Z"),
      endsAt: new Date("2025-01-05T20:00:00.000Z"),
      checkedInAt: new Date("2025-01-05T17:05:00.000Z"),
      hoursWorked: 3.5,
      hoursCredited: 3.5,
    });
    const future = commitment({ signupId: "future" });
    const { deps } = makeDeps({ [ACTOR_ID]: [past, future] });

    const result = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(result.map((r) => r.signupId)).toEqual(["past", "future"]);
    expect(result[0]).toMatchObject({
      hoursWorked: 3.5,
      hoursCredited: 3.5,
      checkedInAt: new Date("2025-01-05T17:05:00.000Z"),
    });
  });

  it("includes windowless rows with startsAt null (shiftless event signup, ask with no startsAt)", async () => {
    const shiftlessEvent = commitment({
      signupId: "shiftless",
      status: "PENDING",
      shiftLabel: null,
      startsAt: null,
      endsAt: null,
    });
    const windowlessAsk = commitment({
      signupId: "windowless-ask",
      source: "ASK_WINDOW",
      status: "APPROVED",
      title: "Weekly food bank",
      shiftLabel: null,
      startsAt: null,
      endsAt: null,
      eventId: null,
      eventSlug: null,
      eventTimezone: null,
      addressText: null,
      askId: ASK_ID,
    });
    const { deps } = makeDeps({
      [ACTOR_ID]: [shiftlessEvent, windowlessAsk],
    });

    const result = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(result.map((r) => r.signupId)).toEqual([
      "shiftless",
      "windowless-ask",
    ]);
    expect(result.every((r) => r.startsAt === null)).toBe(true);
  });

  it("preserves the repo's order: startsAt ASC, nulls last, createdAt DESC tiebreak", async () => {
    // The port owns the ordering; the use case must not re-sort or reverse
    // it on the way out.
    const ordered = [
      commitment({
        signupId: "early",
        startsAt: new Date("2026-07-01T17:00:00.000Z"),
      }),
      commitment({
        signupId: "same-start-newer",
        startsAt: new Date("2026-08-01T17:00:00.000Z"),
        createdAt: new Date("2026-06-09T00:00:00.000Z"),
      }),
      commitment({
        signupId: "same-start-older",
        startsAt: new Date("2026-08-01T17:00:00.000Z"),
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
      }),
      commitment({
        signupId: "windowless-newer",
        startsAt: null,
        endsAt: null,
        createdAt: new Date("2026-06-05T00:00:00.000Z"),
      }),
      commitment({
        signupId: "windowless-older",
        startsAt: null,
        endsAt: null,
        createdAt: new Date("2026-05-05T00:00:00.000Z"),
      }),
    ];
    const { deps } = makeDeps({ [ACTOR_ID]: ordered });

    const result = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(result.map((r) => r.signupId)).toEqual([
      "early",
      "same-start-newer",
      "same-start-older",
      "windowless-newer",
      "windowless-older",
    ]);
  });

  it("reads ONLY the actor's rows — another human's commitments are unreachable", async () => {
    const { deps, txRepos } = makeDeps({
      [ACTOR_ID]: [commitment({ signupId: "mine" })],
      [OTHER_HUMAN_ID]: [commitment({ signupId: "theirs" })],
    });

    const result = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
      // Extra keys can't redirect the read — the use case only ever passes
      // input.actorHumanId, and the schema has no id parameter at all.
      humanId: OTHER_HUMAN_ID,
    });

    expect(result.map((r) => r.signupId)).toEqual(["mine"]);
    expect(txRepos.volunteering.listCommitmentsByHuman).toHaveBeenCalledTimes(1);
    expect(txRepos.volunteering.listCommitmentsByHuman).toHaveBeenCalledWith(
      ACTOR_ID,
      NOW,
    );
    expect(
      txRepos.volunteering.listCommitmentsByHuman,
    ).not.toHaveBeenCalledWith(OTHER_HUMAN_ID, NOW);
  });

  it("passes occurrence-claim rows through untouched (claimId / occurrenceId / cadence)", async () => {
    // The repo emits one row per claimed dated slot on a standing ask; core
    // must not filter, re-key or flatten them. The behaviour itself lives in
    // packages/adapters/test/db/prisma/volunteering-commitments.test.ts.
    const rows = [
      commitment({
        signupId: "standing-signup",
        claimId: "claim-sep-3",
        occurrenceId: "occ-1",
        source: "ASK_WINDOW",
        cadence: "RECURRING",
        startsAt: new Date("2026-09-03T23:00:00.000Z"),
        endsAt: new Date("2026-09-04T03:00:00.000Z"),
        hoursCredited: 4,
      }),
      commitment({
        signupId: "standing-signup",
        claimId: "claim-sep-10",
        occurrenceId: "occ-2",
        source: "ASK_WINDOW",
        cadence: "RECURRING",
        startsAt: new Date("2026-09-10T23:00:00.000Z"),
        endsAt: new Date("2026-09-11T03:00:00.000Z"),
        hoursCredited: 4,
      }),
    ];
    const { deps } = makeDeps({ [ACTOR_ID]: rows });

    const result = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(result).toEqual(rows.map((r) => listed(r)));
    // The repeated signupId is the whole reason identity is claimId-first.
    expect(new Set(result.map((r) => r.signupId)).size).toBe(1);
    expect(result.map((r) => r.claimId)).toEqual([
      "claim-sep-3",
      "claim-sep-10",
    ]);
  });

  it("returns an empty list when the human holds nothing", async () => {
    const { deps } = makeDeps({});

    await expect(
      listMyVolunteerCommitments(deps, { actorHumanId: ACTOR_ID }),
    ).resolves.toEqual([]);
  });

  it("rejects invalid input (missing actorHumanId)", async () => {
    const { deps, txRepos } = makeDeps({});

    await expect(listMyVolunteerCommitments(deps, {})).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(txRepos.volunteering.listCommitmentsByHuman).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid actorHumanId", async () => {
    const { deps, txRepos } = makeDeps({});

    await expect(
      listMyVolunteerCommitments(deps, { actorHumanId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(txRepos.volunteering.listCommitmentsByHuman).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// The venue line goes through the holder-address gate
// ══════════════════════════════════════════════════════════════════════════════

describe("listMyVolunteerCommitments — address gate", () => {
  const PLACE_ID = "00000000-0000-4000-8000-0000000000c1";
  const VENUE_ORG = "00000000-0000-4000-8000-0000000000c2";
  const HOUR = 60 * 60 * 1000;

  /** Owned by VENUE_ORG; accepts community listings venue-wide. */
  const withheldPlace = {
    id: PLACE_ID,
    orgIdsWithAccess: [VENUE_ORG],
    humanIdsWithAccess: [],
    acceptsCommunityListings: true,
    name: "The Blue Door House",
    formattedAddress: "901 Porter Rd",
    city: "Nashville",
    region: "TN",
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
  };

  async function lineFor(
    eventOverrides: Record<string, unknown>,
    place: unknown = null,
    rowOverrides: Partial<VolunteerCommitmentRecord> = {},
  ) {
    const row = commitment({ signupId: "s1", ...rowOverrides });
    const { deps, txRepos } = makeDeps({ [ACTOR_ID]: [row] });
    const getPlace = vi.fn(async () => place);
    const findManyByIds = vi.fn(async () => [
      {
        id: EVENT_ID,
        locationMode: "EXACT",
        locationRadiusMeters: null,
        addressRevealAt: null,
        addressRevealPreset: null,
        placeId: null,
        addressText: "123 Test St",
        locality: "Nashville",
        region: "TN",
        locationLabel: null,
        ...eventOverrides,
      },
    ]);
    Object.assign(txRepos, {
      events: { findManyByIds },
      places: { getById: getPlace },
    });
    const [out] = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });
    return { addressText: out!.addressText, getPlace, findManyByIds };
  }

  it("EXACT: unchanged", async () => {
    expect((await lineFor({})).addressText).toBe("123 Test St");
  });

  it("NEVER: the coarse area, never the street", async () => {
    const { addressText } = await lineFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "NEVER",
      addressRevealAt: null,
    });
    expect(addressText).toBe("Nashville, TN");
  });

  it("before the reveal: the coarse area, never the street", async () => {
    const { addressText } = await lineFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: new Date(NOW.getTime() + HOUR),
    });
    expect(addressText).toBe("Nashville, TN");
  });

  it("after the reveal at a withheld venue: the Place's street, not the Event projection", async () => {
    const { addressText, getPlace } = await lineFor(
      {
        // The venue's own show.
        orgId: VENUE_ORG,
        stewardship: "OWNED",
        placeId: PLACE_ID,
        locationMode: "OBSCURED",
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date(NOW.getTime() - HOUR),
        addressText: "East Nashville",
      },
      withheldPlace,
      { addressText: "East Nashville" },
    );
    expect(getPlace).toHaveBeenCalledWith(PLACE_ID);
    expect(addressText).toBe("901 Porter Rd");
  });

  it("a row that carried no address keeps none (the gate never adds one)", async () => {
    const { addressText } = await lineFor({}, null, { addressText: null });
    expect(addressText).toBeNull();
  });

  const revealedOwnShow = {
    orgId: VENUE_ORG,
    stewardship: "OWNED",
    placeId: PLACE_ID,
    locationMode: "OBSCURED",
    addressRevealPreset: "IMMEDIATELY",
    addressRevealAt: new Date(NOW.getTime() - HOUR),
    addressText: "East Nashville",
  };

  it("C1: a stranger's UNCONFIRMED event at the house: the coarse area, never the street", async () => {
    const { addressText } = await lineFor(
      { ...revealedOwnShow, orgId: "00000000-0000-4000-8000-0000000000c9" },
      withheldPlace,
      { addressText: "East Nashville" },
    );
    expect(addressText).toBe("Nashville, TN");
  });

  it.each(["PENDING", "REJECTED", "WITHDRAWN", "NO_SHOW"] as const)(
    "M1: a %s signup row carries NO address, not even the label",
    async (status) => {
      const { addressText } = await lineFor(revealedOwnShow, withheldPlace, {
        addressText: "East Nashville",
        status,
      });
      expect(addressText).toBeNull();
    },
  );

  it("M1: a non-accepted row's event is not even resolved", async () => {
    const { findManyByIds, getPlace } = await lineFor(
      revealedOwnShow,
      withheldPlace,
      { addressText: "East Nashville", status: "PENDING" },
    );
    expect(findManyByIds).not.toHaveBeenCalled();
    expect(getPlace).not.toHaveBeenCalled();
  });

  it("M1: CHECKED_IN is accepted", async () => {
    const { addressText } = await lineFor(revealedOwnShow, withheldPlace, {
      addressText: "East Nashville",
      status: "CHECKED_IN",
    });
    expect(addressText).toBe("901 Porter Rd");
  });
});

// Ban that sticks: a volunteer keeps the shifts they claimed before the
// ask's owner was withheld (owner ruling 2026-10-07), and each row says
// whether its ask has paused sign-ups (owner ruling 2026-10-08), without
// saying why.
describe("listMyVolunteerCommitments — withheld ask owner", () => {
  const BANNED_ORG_ID = "00000000-0000-4000-8000-0000000000aa";
  const BANNED_HUMAN_ID = "00000000-0000-4000-8000-0000000000bb";
  const LIVE_ASK_ID = "00000000-0000-4000-8000-0000000000a2";
  const HUMAN_ASK_ID = "00000000-0000-4000-8000-0000000000a3";

  const claimedOn = (askId: string, claimId: string) =>
    commitment({
      signupId: `signup-${claimId}`,
      claimId,
      occurrenceId: `occ-${claimId}`,
      source: "ASK_WINDOW",
      eventId: null,
      eventSlug: null,
      eventTimezone: null,
      addressText: null,
      askId,
      status: "APPROVED",
    });

  function withOwners(
    txRepos: ReturnType<typeof makeDeps>["txRepos"],
    owners: Record<
      string,
      {
        subjectType: string;
        subjectId: string;
        eventOwner?: { humanId: string | null; orgId: string | null } | null;
      }
    >,
    banned: { humanIds: string[]; orgIds: string[] },
  ) {
    const listAskOwnersByIds = vi.fn(async (askIds: string[]) =>
      askIds.filter((id) => owners[id]).map((id) => ({ id, ...owners[id]! })),
    );
    const findBannedOwners = vi.fn(async () => banned);
    (txRepos.volunteering as Record<string, unknown>).listAskOwnersByIds =
      listAskOwnersByIds;
    (txRepos as Record<string, unknown>).bans = { findBannedOwners };
    return { listAskOwnersByIds, findBannedOwners };
  }

  it("flags a withheld owner's rows signupsPaused: true and a live owner's false, every row still listed", async () => {
    const paused1 = claimedOn(ASK_ID, "claim-1");
    const paused2 = claimedOn(ASK_ID, "claim-2");
    const live = claimedOn(LIVE_ASK_ID, "claim-3");
    const eventRow = commitment({ signupId: "event-signup" });
    const { deps, txRepos } = makeDeps({
      [ACTOR_ID]: [paused1, live, eventRow, paused2],
    });
    const { listAskOwnersByIds, findBannedOwners } = withOwners(
      txRepos,
      {
        [ASK_ID]: { subjectType: "ORG", subjectId: BANNED_ORG_ID },
        [LIVE_ASK_ID]: { subjectType: "ORG", subjectId: LIVE_ORG_ID },
        [EVENT_ASK_ID]: {
          subjectType: "EVENT",
          subjectId: EVENT_ID,
          eventOwner: { humanId: null, orgId: LIVE_ORG_ID },
        },
      },
      { humanIds: [], orgIds: [BANNED_ORG_ID] },
    );

    const rows = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    // Existing rows are listed exactly as before, plus the flag.
    expect(rows).toEqual([
      listed(paused1, { signupsPaused: true }),
      listed(live),
      listed(eventRow),
      listed(paused2, { signupsPaused: true }),
    ]);
    // Batched: ONE owner read for the distinct ask ids, ONE bans call.
    expect(listAskOwnersByIds).toHaveBeenCalledTimes(1);
    expect(listAskOwnersByIds).toHaveBeenCalledWith([
      ASK_ID,
      LIVE_ASK_ID,
      EVENT_ASK_ID,
    ]);
    expect(findBannedOwners).toHaveBeenCalledTimes(1);
    expect(findBannedOwners).toHaveBeenCalledWith({
      humanIds: [],
      orgIds: [BANNED_ORG_ID, LIVE_ORG_ID],
    });
  });

  it("a banned HUMAN owner's ask is flagged in the same single bans call", async () => {
    const humanRow = claimedOn(HUMAN_ASK_ID, "claim-h");
    const orgRow = claimedOn(LIVE_ASK_ID, "claim-o");
    const { deps, txRepos } = makeDeps({ [ACTOR_ID]: [humanRow, orgRow] });
    const { findBannedOwners } = withOwners(
      txRepos,
      {
        [HUMAN_ASK_ID]: { subjectType: "HUMAN", subjectId: BANNED_HUMAN_ID },
        [LIVE_ASK_ID]: { subjectType: "ORG", subjectId: LIVE_ORG_ID },
      },
      { humanIds: [BANNED_HUMAN_ID], orgIds: [] },
    );

    const rows = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(rows.map((r) => r.signupsPaused)).toEqual([true, false]);
    expect(findBannedOwners).toHaveBeenCalledTimes(1);
    expect(findBannedOwners).toHaveBeenCalledWith({
      humanIds: [BANNED_HUMAN_ID],
      orgIds: [LIVE_ORG_ID],
    });
  });

  it("the row carries only the boolean: no owner id, no reason", async () => {
    const { deps, txRepos } = makeDeps({
      [ACTOR_ID]: [claimedOn(ASK_ID, "claim-1")],
    });
    withOwners(
      txRepos,
      { [ASK_ID]: { subjectType: "ORG", subjectId: BANNED_ORG_ID } },
      { humanIds: [], orgIds: [BANNED_ORG_ID] },
    );

    const [row] = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(row!.signupsPaused).toBe(true);
    expect(JSON.stringify(row)).not.toContain(BANNED_ORG_ID);
  });

  it("an empty list makes no owner read and no bans call", async () => {
    const { deps, txRepos } = makeDeps({});
    const { listAskOwnersByIds, findBannedOwners } = withOwners(txRepos, {}, {
      humanIds: [],
      orgIds: [],
    });

    await expect(
      listMyVolunteerCommitments(deps, { actorHumanId: ACTOR_ID }),
    ).resolves.toEqual([]);
    expect(listAskOwnersByIds).not.toHaveBeenCalled();
    expect(findBannedOwners).not.toHaveBeenCalled();
  });

  it("an EVENT-owned ask resolves to the event's owner: banned org → true", async () => {
    const eventRow = commitment({ signupId: "event-signup" });
    const { deps, txRepos } = makeDeps({ [ACTOR_ID]: [eventRow] });
    const { findBannedOwners } = withOwners(
      txRepos,
      {
        [EVENT_ASK_ID]: {
          subjectType: "EVENT",
          subjectId: EVENT_ID,
          eventOwner: { humanId: null, orgId: BANNED_ORG_ID },
        },
      },
      { humanIds: [], orgIds: [BANNED_ORG_ID] },
    );

    const [row] = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(row!.signupsPaused).toBe(true);
    expect(findBannedOwners).toHaveBeenCalledWith({
      humanIds: [],
      orgIds: [BANNED_ORG_ID],
    });
    expect(JSON.stringify(row)).not.toContain(BANNED_ORG_ID);
  });

  it("an EVENT owned by a banned human → true; a live owner → false", async () => {
    const bannedEvent = commitment({ signupId: "e1", askId: HUMAN_ASK_ID });
    const liveEvent = commitment({ signupId: "e2" });
    const { deps, txRepos } = makeDeps({ [ACTOR_ID]: [bannedEvent, liveEvent] });
    withOwners(
      txRepos,
      {
        [HUMAN_ASK_ID]: {
          subjectType: "EVENT",
          subjectId: "event-2",
          eventOwner: { humanId: BANNED_HUMAN_ID, orgId: null },
        },
        [EVENT_ASK_ID]: {
          subjectType: "EVENT",
          subjectId: EVENT_ID,
          eventOwner: { humanId: null, orgId: LIVE_ORG_ID },
        },
      },
      { humanIds: [BANNED_HUMAN_ID], orgIds: [] },
    );

    const rows = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(rows.map((r) => r.signupsPaused)).toEqual([true, false]);
  });

  it("a mixed ORG / HUMAN / EVENT list still makes exactly one bans call", async () => {
    const { deps, txRepos } = makeDeps({
      [ACTOR_ID]: [
        claimedOn(ASK_ID, "c1"),
        claimedOn(HUMAN_ASK_ID, "c2"),
        commitment({ signupId: "event-signup" }),
      ],
    });
    const { listAskOwnersByIds, findBannedOwners } = withOwners(
      txRepos,
      {
        [ASK_ID]: { subjectType: "ORG", subjectId: LIVE_ORG_ID },
        [HUMAN_ASK_ID]: { subjectType: "HUMAN", subjectId: BANNED_HUMAN_ID },
        [EVENT_ASK_ID]: {
          subjectType: "EVENT",
          subjectId: EVENT_ID,
          eventOwner: { humanId: null, orgId: BANNED_ORG_ID },
        },
      },
      { humanIds: [BANNED_HUMAN_ID], orgIds: [BANNED_ORG_ID] },
    );

    const rows = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(rows.map((r) => r.signupsPaused)).toEqual([false, true, true]);
    expect(listAskOwnersByIds).toHaveBeenCalledTimes(1);
    expect(findBannedOwners).toHaveBeenCalledTimes(1);
  });

  it("an EVENT ask with no owner (community listing) makes no bans call", async () => {
    const { deps, txRepos } = makeDeps({
      [ACTOR_ID]: [commitment({ signupId: "event-only" })],
    });
    const { findBannedOwners } = withOwners(
      txRepos,
      {
        [EVENT_ASK_ID]: {
          subjectType: "EVENT",
          subjectId: EVENT_ID,
          eventOwner: { humanId: null, orgId: null },
        },
      },
      { humanIds: [], orgIds: [] },
    );

    const rows = await listMyVolunteerCommitments(deps, {
      actorHumanId: ACTOR_ID,
    });

    expect(rows.map((r) => r.signupsPaused)).toEqual([false]);
    expect(findBannedOwners).not.toHaveBeenCalled();
  });
});

describe("listMyVolunteerCommitments — text reminders switch data", () => {
  const ask = (over: Record<string, unknown> = {}) => ({
    subjectType: "PLACE" as const,
    cadence: "ONE_TIME" as const,
    startsAt: new Date("2026-07-01T17:00:00.000Z"),
    ...over,
  });

  async function run(rows: VolunteerCommitmentRecord[]) {
    const { deps } = makeDeps({ [ACTOR_ID]: rows });
    return listMyVolunteerCommitments(deps, { actorHumanId: ACTOR_ID });
  }

  it("a shift row is offered texts", async () => {
    const [row] = await run([commitment({ signupId: "s1" })]);
    expect(row!.textRemindersOffered).toBe(true);
    expect(row!.reminderAnchor).toBe("SHIFT");
  });

  it("a shiftless signup on a role with NO shifts is offered texts", async () => {
    const [row] = await run([
      commitment({
        signupId: "s1",
        reminderBasis: { shiftId: null, roleHasShifts: false, ask: null },
      }),
    ]);
    expect(row!.textRemindersOffered).toBe(true);
    expect(row!.reminderAnchor).toBe("EVENT_START");
  });

  it("a shiftless signup on a role WITH shifts is not offered texts", async () => {
    const [row] = await run([
      commitment({
        signupId: "s1",
        reminderBasis: { shiftId: null, roleHasShifts: true, ask: null },
      }),
    ]);
    expect(row!.textRemindersOffered).toBe(false);
    expect(row!.reminderAnchor).toBeNull();
  });

  it("a ONE_TIME ask with a start is offered texts; an ONGOING ask is not", async () => {
    const base = {
      source: "ASK_WINDOW" as const,
      eventId: null,
      askId: ASK_ID,
    };
    const rows = await run([
      commitment({
        ...base,
        signupId: "one-time",
        cadence: "ONE_TIME",
        reminderBasis: { shiftId: null, roleHasShifts: false, ask: ask() },
      }),
      commitment({
        ...base,
        signupId: "ongoing",
        cadence: "ONGOING",
        reminderBasis: {
          shiftId: null,
          roleHasShifts: false,
          ask: ask({ cadence: "ONGOING" }),
        },
      }),
      commitment({
        ...base,
        signupId: "no-start",
        reminderBasis: {
          shiftId: null,
          roleHasShifts: false,
          ask: ask({ startsAt: null }),
        },
      }),
    ]);
    expect(rows.map((r) => r.textRemindersOffered)).toEqual([
      true,
      false,
      false,
    ]);
    expect(rows.map((r) => r.reminderAnchor)).toEqual([
      "ASK_START",
      null,
      null,
    ]);
  });

  it("passes smsOptIn and hasContactPhone through and never exposes the basis", async () => {
    const rows = await run([
      commitment({ signupId: "on", smsOptIn: true, hasContactPhone: true }),
      commitment({ signupId: "off" }),
    ]);
    expect(rows.map((r) => [r.smsOptIn, r.hasContactPhone])).toEqual([
      [true, true],
      [false, false],
    ]);
    expect(rows[0]).not.toHaveProperty("reminderBasis");
  });
});

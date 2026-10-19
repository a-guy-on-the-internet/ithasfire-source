import { describe, expect, it, vi } from "vitest";

import type { EntityPageRecord } from "@th/types/repos/entity-pages";
import type { BookingRequestActRecord } from "@th/ports/repos/booking-requests";
import type { PerformerProfileRecord } from "@th/ports/repos/performer-profiles";
import type { OrgMembership } from "@th/ports/repos/authz";

import {
  BOOKING_LINEUP_TAG_DAILY_MAX,
  BOOKING_LINEUP_TAG_DAILY_WINDOW_SECONDS,
  bookingLineupTagBudgetKey,
  createBookingRequest,
  type CreateBookingRequestDeps,
} from "../create-booking-request";
import { notifyBookingLineupInvited } from "../notify-booking-lineup-invited";
import { notifyBookingRequestReceived } from "../notify-booking-request-received";
import {
  ACTOR_ID,
  NOW,
  ORG_ID,
  PLACE_ID,
  REQUEST_ID,
  buildBookingRequestRecord,
  buildPerformerProfile,
  buildPlaceRecord,
  withTx,
} from "./helpers";

// ─────────────────────────────────────────────────────────────────────────────
// The bill on createBookingRequest (lineup-booking-requests v2, FR-002 /
// FR-003 / FR-004 / FR-007, docs/specs/2026-09-25). The pre-bill behaviour
// of the create path is pinned by create-booking-request.test.ts; this file
// pins what the bill adds on top of it.
// ─────────────────────────────────────────────────────────────────────────────

const TAGGED_A = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";
const TAGGED_B = "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2";
const UNLISTED_HUMAN = "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3";
const SUSPENDED_HUMAN = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
const NO_PAGE_HUMAN = "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5";
const UNKNOWN_HUMAN = "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6";
const PUBLIC_APP_URL = "https://ithasfire.test";
/** Eleven more taggable artists, for the budget arithmetic. */
const CROWD = Array.from(
  { length: 11 },
  (_, i) => `aaaaaaaa-0000-4000-8000-${String(i).padStart(12, "0")}`,
);

type HumanRow = { id: string; name: string | null; status: string };

const HUMANS: HumanRow[] = [
  { id: ACTOR_ID, name: "Sam Sender", status: "ACTIVE" },
  { id: TAGGED_A, name: "Alice Human", status: "ACTIVE" },
  { id: TAGGED_B, name: "Bea Human", status: "ACTIVE" },
  { id: UNLISTED_HUMAN, name: "Una Listed", status: "ACTIVE" },
  { id: SUSPENDED_HUMAN, name: "Sus Pended", status: "SUSPENDED" },
  { id: NO_PAGE_HUMAN, name: "No Page", status: "ACTIVE" },
  ...CROWD.map((id, i) => ({ id, name: `Crowd ${i}`, status: "ACTIVE" })),
];

function page(
  ownerId: string,
  overrides: Partial<EntityPageRecord> = {},
): EntityPageRecord {
  return {
    id: `page-${ownerId}`,
    ownerType: "HUMAN",
    ownerId,
    slug: `slug-${ownerId.slice(0, 4)}`,
    displayName: null,
    bio: null,
    avatarUrl: null,
    bannerUrl: null,
    visibility: "PUBLIC",
    allowFollows: true,
    showFollowerCount: true,
    category: null,
    templateAppliedCategories: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const PAGES: EntityPageRecord[] = [
  page(ACTOR_ID, { displayName: "Sam" }),
  page(TAGGED_A, { displayName: "The Alice Band" }),
  // No page displayName → falls back to Human.name.
  page(TAGGED_B),
  page(UNLISTED_HUMAN, { visibility: "UNLISTED" }),
  page(SUSPENDED_HUMAN, { displayName: "Suspended Act" }),
  ...CROWD.map((id) => page(id)),
];

/**
 * Fixed-window counter with the Redis adapter's semantics: every consume
 * INCRements (a refused one too), `allowed` = count ≤ max, `remaining` =
 * max − count after the increment (0 when refused). `used` = tokens already
 * spent in this window before the test starts; `count()` reads the counter.
 */
function makeBucket(used = 0) {
  let count = used;
  const consume = vi.fn(async (_key: string, max: number, _window: number) => {
    count += 1;
    const allowed = count <= max;
    return {
      allowed,
      remaining: allowed ? max - count : 0,
      retryAfterSeconds: 3600,
    };
  });
  return { consume, count: () => count };
}

/** A logger whose `child()` is itself, so scoped logs are observable. */
function makeLogger() {
  const logger = {
    child: vi.fn(() => logger),
    withTime: vi.fn(async (_name: string, fn: () => Promise<unknown>) => fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return logger;
}

type BuildOptions = {
  profile?: PerformerProfileRecord | null;
  membership?: OrgMembership | null;
  rateLimit?: { consume: ReturnType<typeof vi.fn> } | null;
  notifyLineup?: CreateBookingRequestDeps["notifyBookingLineupInvited"];
  calendars?: unknown;
};

function buildDeps(options: BuildOptions = {}) {
  const profile =
    options.profile === undefined ? buildPerformerProfile() : options.profile;

  const bookingRequests = {
    findOpenByPerformerAndPlace: vi.fn(async () => null),
    create: vi.fn(async (input: Record<string, unknown>) =>
      buildBookingRequestRecord(input as never),
    ),
  };
  const humans = {
    getById: vi.fn(async (id: string) => ({ id, genreTags: [] })),
    getByIds: vi.fn(async (ids: string[]) =>
      HUMANS.filter((human) => ids.includes(human.id)),
    ),
    // The venue notification's recipient slug read.
    getByIdWithIdentity: vi.fn(async (id: string) => ({
      human: { id, name: "Venue Owner" },
      identity: { username: "venueowner" },
    })),
  };
  const entityPages = {
    getByOwners: vi.fn(async (_type: string, ids: string[]) =>
      PAGES.filter((row) => ids.includes(row.ownerId)),
    ),
    // The venue notification's admin-slug fallback.
    getByOwner: vi.fn(async () => null),
  };
  const organizations = {
    getByIds: vi.fn(async (ids: string[]) =>
      ids.map((id) => ({ id, name: "Night Owl Presents" })),
    ),
  };
  const mocks = {
    bookingRequests,
    performerProfiles: { getByOwner: vi.fn(async () => profile) },
    places: { getById: vi.fn(async () => buildPlaceRecord()) },
    humans,
    entityPages,
    organizations,
    authz: {
      getOrgMembership: vi.fn(async () => options.membership ?? null),
    },
    audit: { log: vi.fn(async () => {}) },
    humanStats: { findByHumanId: vi.fn(async () => null) },
    events: {
      listPublishedByPlace: vi.fn(async () => ({ items: [], nextCursor: null })),
      listPublishedOccurrencesByPlace: vi.fn(async () => []),
    },
    calendars: options.calendars ?? {
      findById: vi.fn(async () => null),
      findDefaultForPlace: vi.fn(async () => null),
      listByPlace: vi.fn(async () => []),
      listAvailabilityForPlace: vi.fn(async () => []),
      countAvailabilityForPlace: vi.fn(async () => 1),
    },
  };
  const repos = withTx(mocks);
  const logger = makeLogger();
  const reportError = vi.fn();
  const deps: CreateBookingRequestDeps = {
    repos: repos as unknown as CreateBookingRequestDeps["repos"],
    clock: { now: () => NOW },
    logger: logger as unknown as CreateBookingRequestDeps["logger"],
    reportError,
    rateLimit: (options.rateLimit ??
      null) as CreateBookingRequestDeps["rateLimit"],
    notifyBookingLineupInvited: options.notifyLineup,
  };

  /** The bill rows actually written, in stored order. */
  const actsWritten = async (): Promise<BookingRequestActRecord[]> =>
    (
      repos as unknown as {
        bookingRequests: {
          listActsForRequests: (ids: string[]) => Promise<BookingRequestActRecord[]>;
        };
      }
    ).bookingRequests.listActsForRequests([REQUEST_ID]);

  return { deps, mocks, repos, logger, reportError, actsWritten };
}

const baseInput = {
  actorHumanId: ACTOR_ID,
  performerOwnerType: "human",
  performerOwnerId: ACTOR_ID,
  placeId: PLACE_ID,
  message: "We'd love to play a Friday night slot.",
  preferredDates: ["2026-07-10"],
};

const promoterBill = {
  includeSelf: false,
  acts: [
    { kind: "tagged", humanId: TAGGED_A },
    { kind: "external", name: "  The <b>Openers</b> ", url: "https://openers.example" },
    { kind: "tagged", humanId: TAGGED_B },
  ],
};

describe("createBookingRequest — the bill", () => {
  // ── Backward compatibility ────────────────────────────────────────────────

  it("no bill (every pre-bill client): exactly one SELF row for the sender, CONFIRMED, sortOrder 0 — nothing else read or spent", async () => {
    const rateLimit = makeBucket();
    const notifyLineup = vi.fn(async () => {});
    const { deps, mocks, actsWritten } = buildDeps({ rateLimit, notifyLineup });

    await createBookingRequest(deps, baseInput);

    const acts = await actsWritten();
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({
      bookingRequestId: REQUEST_ID,
      source: "SELF",
      actOwnerType: "human",
      actOwnerId: ACTOR_ID,
      confirmation: "CONFIRMED",
      sortOrder: 0,
      role: "PERFORMER",
    });
    // The pitch is unchanged: actName stays what the client sent (none).
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ actName: null }),
    );
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bill: { self: true, tagged: 0, external: 0 },
        }),
      }),
    );
    expect(mocks.entityPages.getByOwners).not.toHaveBeenCalled();
    expect(rateLimit.consume).not.toHaveBeenCalled();
    expect(notifyLineup).not.toHaveBeenCalled();
  });

  it("no bill still enforces performer mode (the sender IS the act) and writes nothing", async () => {
    const { deps, mocks, actsWritten } = buildDeps({ profile: null });

    await expect(createBookingRequest(deps, baseInput)).rejects.toMatchObject({
      code: "PERFORMER_MODE_REQUIRED",
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(await actsWritten()).toEqual([]);
  });

  it("an ORG sender's SELF row carries the org pair", async () => {
    const { deps, actsWritten } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" },
      profile: buildPerformerProfile({ ownerType: "organization", ownerId: ORG_ID }),
    });

    await createBookingRequest(deps, {
      ...baseInput,
      performerOwnerType: "org",
      performerOwnerId: ORG_ID,
      bill: { includeSelf: true, acts: [] },
    });

    expect(await actsWritten()).toEqual([
      expect.objectContaining({
        source: "SELF",
        actOwnerType: "organization",
        actOwnerId: ORG_ID,
        sortOrder: 0,
      }),
    ]);
  });

  // ── The promoter case (D3) ────────────────────────────────────────────────

  it("a promoter with NO performer mode sends 2 tagged + 1 free-text acts: rows in bill order, distinct sortOrders, TAGGED pending + invited, EXTERNAL confirmed", async () => {
    const { deps, mocks, actsWritten } = buildDeps({ profile: null });

    const result = await createBookingRequest(deps, {
      ...baseInput,
      bill: promoterBill,
    });

    expect(result.bookingRequestId).toBe(REQUEST_ID);
    // D3: the gate guards the SELF row, and there is none.
    expect(mocks.performerProfiles.getByOwner).not.toHaveBeenCalled();

    const acts = await actsWritten();
    expect(acts.map((act) => act.sortOrder)).toEqual([0, 1, 2]);
    expect(acts[0]).toMatchObject({
      source: "TAGGED",
      actOwnerType: "human",
      actOwnerId: TAGGED_A,
      confirmation: "PENDING",
      invitedAt: NOW,
      role: "PERFORMER",
    });
    expect(acts[1]).toMatchObject({
      source: "EXTERNAL",
      actOwnerType: null,
      actOwnerId: null,
      // Sanitized before the length check (NFR-001).
      externalName: "The Openers",
      externalUrl: "https://openers.example",
      confirmation: "CONFIRMED",
    });
    expect(acts[2]).toMatchObject({
      source: "TAGGED",
      actOwnerId: TAGGED_B,
      confirmation: "PENDING",
    });
    expect(acts.some((act) => act.source === "SELF")).toBe(false);
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bill: { self: false, tagged: 2, external: 1 },
        }),
      }),
    );
  });

  it("includeSelf with other acts: SELF is row 0, the acts follow", async () => {
    const { deps, actsWritten } = buildDeps();

    await createBookingRequest(deps, {
      ...baseInput,
      bill: {
        includeSelf: true,
        acts: [{ kind: "external", name: "Support Act" }],
      },
    });

    const acts = await actsWritten();
    expect(acts.map((act) => [act.source, act.sortOrder])).toEqual([
      ["SELF", 0],
      ["EXTERNAL", 1],
    ]);
  });

  it("includeSelf WITHOUT performer mode → PERFORMER_MODE_REQUIRED (same code, same one-click enable)", async () => {
    const { deps, mocks } = buildDeps({ profile: null });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        bill: { includeSelf: true, acts: [{ kind: "tagged", humanId: TAGGED_A }] },
      }),
    ).rejects.toMatchObject({ code: "PERFORMER_MODE_REQUIRED" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  // ── Typed shape rules ─────────────────────────────────────────────────────

  it("v3 L12: includeSelf off and no acts is ACCEPTED (no LINEUP_REQUIRED) — no act rows at all, and the request says it recorded a bill", async () => {
    const rateLimit = makeBucket();
    const notifyLineup = vi.fn(async () => {});
    // No performer mode needed: the sender is not on the bill.
    const { deps, mocks, repos } = buildDeps({
      profile: null,
      rateLimit,
      notifyLineup,
    });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        bill: { includeSelf: false, acts: [] },
      }),
    ).resolves.toMatchObject({ bookingRequestId: REQUEST_ID });

    // The column, not a hidden row, is what tells the mint "empty bill →
    // empty lineup" apart from "sent before bills → the sender headlines".
    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ billRecorded: true }),
    );
    // Nothing is written to the bill — removed rows included.
    const all = await (
      repos as unknown as {
        bookingRequests: {
          listActsForRequests: (
            ids: string[],
            options: { includeRemoved: boolean },
          ) => Promise<BookingRequestActRecord[]>;
        };
      }
    ).bookingRequests.listActsForRequests([REQUEST_ID], { includeRemoved: true });
    expect(all).toEqual([]);
    // Nothing tagged: no budget spent, nobody invited.
    expect(rateLimit.consume).not.toHaveBeenCalled();
    expect(notifyLineup).not.toHaveBeenCalled();
    expect(mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bill: { self: false, tagged: 0, external: 0 },
        }),
      }),
    );
  });

  it("v3 L12: every PERFORM create records a bill — the pre-bill contract (no `bill` sent) included", async () => {
    const perform = buildDeps();
    await createBookingRequest(perform.deps, baseInput);
    expect(perform.mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ billRecorded: true }),
    );
  });

  it("RENT with a bill → BILL_NOT_ALLOWED, nothing written", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingRequest(deps, {
        actorHumanId: ACTOR_ID,
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
        placeId: PLACE_ID,
        intent: "RENT",
        requestedStartsAt: "2026-07-10T23:00:00.000Z",
        requestedEndsAt: "2026-07-11T03:00:00.000Z",
        purpose: "Birthday party",
        bill: { includeSelf: true, acts: [] },
      }),
    ).rejects.toMatchObject({ code: "BILL_NOT_ALLOWED" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("RENT without a bill writes NO act rows (a room hire has no lineup)", async () => {
    const calendar = {
      id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      placeId: PLACE_ID,
      name: "Main",
      isDefault: true,
      acceptsPerform: true,
      acceptsRent: true,
      acceptsUse: true,
      rentalMode: "REQUEST",
      spaces: [],
    };
    const { deps, mocks, actsWritten } = buildDeps({
      profile: null,
      calendars: {
        findById: vi.fn(async () => calendar),
        findDefaultForPlace: vi.fn(async () => calendar),
        listByPlace: vi.fn(async () => [calendar]),
        listAvailabilityForPlace: vi.fn(async () => []),
        countAvailabilityForPlace: vi.fn(async () => 1),
      },
    });

    await createBookingRequest(deps, {
      actorHumanId: ACTOR_ID,
      performerOwnerType: "human",
      performerOwnerId: ACTOR_ID,
      placeId: PLACE_ID,
      intent: "RENT",
      requestedStartsAt: "2026-07-10T23:00:00.000Z",
      requestedEndsAt: "2026-07-11T03:00:00.000Z",
      purpose: "Birthday party",
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(await actsWritten()).toEqual([]);
    // A room hire never recorded a bill: its mint keeps the pre-bill rule.
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ billRecorded: false }),
    );
  });

  it("the same human tagged twice → ACT_NOT_TAGGABLE duplicate (before the tx: the DB unique would abort it)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        bill: {
          includeSelf: true,
          acts: [
            { kind: "tagged", humanId: TAGGED_A },
            { kind: "tagged", humanId: TAGGED_A },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "ACT_NOT_TAGGABLE",
      meta: { reason: "duplicate", humanId: TAGGED_A },
    });
    expect(mocks.entityPages.getByOwners).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("a human sender tagging themselves → ACT_NOT_TAGGABLE self (the self toggle is the way on)", async () => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        bill: { includeSelf: false, acts: [{ kind: "tagged", humanId: ACTOR_ID }] },
      }),
    ).rejects.toMatchObject({
      code: "ACT_NOT_TAGGABLE",
      meta: { reason: "self", humanId: ACTOR_ID },
    });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("an ORG sender may tag the acting member (a different party from the org)", async () => {
    const { deps, actsWritten } = buildDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "ADMIN" },
      profile: null,
    });

    await createBookingRequest(deps, {
      ...baseInput,
      performerOwnerType: "org",
      performerOwnerId: ORG_ID,
      bill: { includeSelf: false, acts: [{ kind: "tagged", humanId: ACTOR_ID }] },
    });

    expect(await actsWritten()).toEqual([
      expect.objectContaining({ source: "TAGGED", actOwnerId: ACTOR_ID }),
    ]);
  });

  it.each([
    ["an UNLISTED page", UNLISTED_HUMAN],
    ["a SUSPENDED human", SUSPENDED_HUMAN],
    ["no entity page", NO_PAGE_HUMAN],
    ["an unknown id", UNKNOWN_HUMAN],
  ])("a human with %s is not taggable → ACT_NOT_TAGGABLE not_taggable, nothing written", async (_label, humanId) => {
    const rateLimit = makeBucket();
    const { deps, mocks, actsWritten } = buildDeps({ rateLimit });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        bill: {
          includeSelf: true,
          acts: [
            { kind: "tagged", humanId: TAGGED_A },
            { kind: "tagged", humanId },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "ACT_NOT_TAGGABLE",
      meta: { reason: "not_taggable", humanId },
    });
    // ONE batched read per repo for the whole bill.
    expect(mocks.humans.getByIds).toHaveBeenCalledTimes(1);
    expect(mocks.entityPages.getByOwners).toHaveBeenCalledTimes(1);
    expect(mocks.entityPages.getByOwners).toHaveBeenCalledWith("HUMAN", [
      TAGGED_A,
      humanId,
    ]);
    // A refused request never spends budget.
    expect(rateLimit.consume).not.toHaveBeenCalled();
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(await actsWritten()).toEqual([]);
  });

  // ── actName (FR-004) ──────────────────────────────────────────────────────

  it("NEVER defaults actName from a TAGGED act: a tagged-only promoter bill stores actName null", async () => {
    const { deps, mocks } = buildDeps({ profile: null });

    await createBookingRequest(deps, {
      ...baseInput,
      bill: {
        includeSelf: false,
        acts: [
          { kind: "tagged", humanId: TAGGED_A },
          { kind: "tagged", humanId: TAGGED_B },
        ],
      },
    });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ actName: null }),
    );
  });

  it("tagged + free-text without self: actName is the first FREE-TEXT act's name, even when a tagged act comes first", async () => {
    const { deps, mocks } = buildDeps({ profile: null });

    // promoterBill = [tagged Alice, external "The Openers", tagged Bea]
    await createBookingRequest(deps, { ...baseInput, bill: promoterBill });

    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ actName: "The Openers" }),
    );
  });

  it("the venue's received notification never names a tagged (pending) artist on a promoter request", async () => {
    const notify = vi.fn(async () => ({ ok: true }));
    const { deps, repos } = buildDeps({ profile: null });
    deps.notifyBookingRequestReceived = (args) =>
      notifyBookingRequestReceived(
        {
          repos: repos as never,
          notify: notify as never,
          publicAppUrl: PUBLIC_APP_URL,
        },
        args,
      );

    await createBookingRequest(deps, {
      ...baseInput,
      bill: { includeSelf: false, acts: [{ kind: "tagged", humanId: TAGGED_A }] },
    });

    expect(notify).toHaveBeenCalledTimes(1);
    const sent = notify.mock.calls[0]![0] as { payload: { actName: string } };
    // No actName on the row → the venue is told the SENDER (organizer) asked.
    expect(sent.payload.actName).toBe("Sam Sender");
    const wire = JSON.stringify(notify.mock.calls);
    expect(wire).not.toContain("The Alice Band");
    expect(wire).not.toContain("Alice Human");
  });

  it("an explicit actName always wins, and with self on the bill nothing is defaulted", async () => {
    const explicit = buildDeps({ profile: null });
    await createBookingRequest(explicit.deps, {
      ...baseInput,
      actName: "Friday Showcase",
      bill: promoterBill,
    });
    expect(explicit.mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ actName: "Friday Showcase" }),
    );

    const withSelf = buildDeps();
    await createBookingRequest(withSelf.deps, {
      ...baseInput,
      bill: { includeSelf: true, acts: [{ kind: "tagged", humanId: TAGGED_A }] },
    });
    expect(withSelf.mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ actName: null }),
    );
  });

  // ── Tag budget (FR-007) ───────────────────────────────────────────────────

  it("spends ONE token per tagged human from the SENDER's daily bucket", async () => {
    const rateLimit = makeBucket();
    const { deps } = buildDeps({ profile: null, rateLimit });

    await createBookingRequest(deps, { ...baseInput, bill: promoterBill });

    expect(rateLimit.consume).toHaveBeenCalledTimes(2);
    expect(rateLimit.consume).toHaveBeenCalledWith(
      bookingLineupTagBudgetKey("human", ACTOR_ID),
      BOOKING_LINEUP_TAG_DAILY_MAX,
      BOOKING_LINEUP_TAG_DAILY_WINDOW_SECONDS,
    );
    expect(BOOKING_LINEUP_TAG_DAILY_MAX).toBe(30);
    expect(BOOKING_LINEUP_TAG_DAILY_WINDOW_SECONDS).toBe(86_400);
  });

  it("an EMPTY budget → RATE_LIMITED lineup_tag_budget after ONE probe, and NOTHING is written or notified", async () => {
    const rateLimit = makeBucket(30);
    const notifyLineup = vi.fn(async () => {});
    const { deps, mocks, actsWritten } = buildDeps({
      profile: null,
      rateLimit,
      notifyLineup,
    });

    await expect(
      createBookingRequest(deps, { ...baseInput, bill: promoterBill }),
    ).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "lineup_tag_budget",
      meta: { scope: "lineup_tag_budget", retryAfterSeconds: 3600 },
    });
    expect(rateLimit.consume).toHaveBeenCalledTimes(1);
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
    expect(await actsWritten()).toEqual([]);
    expect(notifyLineup).not.toHaveBeenCalled();
  });

  it("a bill that does not FIT is refused having spent ONE token (25/30 used + 11 tags); a 3-tag bill then fits", async () => {
    const rateLimit = makeBucket(25);
    const big = buildDeps({ profile: null, rateLimit });

    await expect(
      createBookingRequest(big.deps, {
        ...baseInput,
        bill: {
          includeSelf: false,
          acts: CROWD.map((humanId) => ({ kind: "tagged", humanId })),
        },
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", message: "lineup_tag_budget" });
    // The probe only: 26/30 — the refusal cost one token, not eleven.
    expect(rateLimit.consume).toHaveBeenCalledTimes(1);
    expect(rateLimit.count()).toBe(26);
    expect(big.mocks.bookingRequests.create).not.toHaveBeenCalled();

    const small = buildDeps({ profile: null, rateLimit });
    await createBookingRequest(small.deps, {
      ...baseInput,
      bill: {
        includeSelf: false,
        acts: CROWD.slice(0, 3).map((humanId) => ({ kind: "tagged", humanId })),
      },
    });
    expect(small.mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(rateLimit.count()).toBe(29);
  });

  it("a bill that EXACTLY fits the rest of the budget is accepted (28/30 used + 2 tags)", async () => {
    const rateLimit = makeBucket(28);
    const { deps, mocks } = buildDeps({ profile: null, rateLimit });

    await createBookingRequest(deps, { ...baseInput, bill: promoterBill });

    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(rateLimit.count()).toBe(30);
  });

  it("a THROWING rate limiter fails open: the request lands, the failure is logged at error AND reported, once", async () => {
    const rateLimit = {
      consume: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };
    const { deps, mocks, logger, reportError, actsWritten } = buildDeps({
      profile: null,
      rateLimit,
    });

    await createBookingRequest(deps, { ...baseInput, bill: promoterBill });

    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(await actsWritten()).toHaveLength(3);
    // One broken limiter → one consume, one log, one report (not one per tag).
    expect(rateLimit.consume).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.lineup_tag_budget_consume_failed",
      expect.objectContaining({ performerOwnerId: ACTOR_ID }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), {
      tags: { useCase: "createBookingRequest", step: "lineup_tag_budget" },
      extra: {
        performerOwnerType: "human",
        performerOwnerId: ACTOR_ID,
        placeId: PLACE_ID,
      },
    });
  });

  it("a throwing limiter AND a throwing reporter still fail open", async () => {
    const { deps, mocks } = buildDeps({
      profile: null,
      rateLimit: {
        consume: vi.fn(async () => {
          throw new Error("redis down");
        }),
      },
    });
    deps.reportError = () => {
      throw new Error("sentry down");
    };

    await expect(
      createBookingRequest(deps, { ...baseInput, bill: promoterBill }),
    ).resolves.toMatchObject({ bookingRequestId: REQUEST_ID });
    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
  });

  // ── Lineup invites (FR-003) ───────────────────────────────────────────────

  it("fans out ONE invite per TAGGED act, post-commit, with (request, human) idempotency keys and an absolute confirm link", async () => {
    const notify = vi.fn(async () => ({ ok: true }));
    const buildNotifier = (
      repos: Parameters<typeof notifyBookingLineupInvited>[0]["repos"],
    ): CreateBookingRequestDeps["notifyBookingLineupInvited"] =>
      (args) =>
        notifyBookingLineupInvited(
          { repos, notify: notify as never, publicAppUrl: PUBLIC_APP_URL },
          args,
        );
    let notifier: CreateBookingRequestDeps["notifyBookingLineupInvited"];
    const lazy = vi.fn(
      async (args: Parameters<NonNullable<typeof notifier>>[0]) => notifier!(args),
    );
    const { deps, mocks, repos } = buildDeps({
      profile: null,
      notifyLineup: lazy,
    });
    notifier = buildNotifier(repos as never);

    await createBookingRequest(deps, { ...baseInput, bill: promoterBill });

    // Called once for the request, AFTER the transaction: later than the
    // audit row, which is the LAST write inside `writeBookingRequestInTx`.
    expect(lazy).toHaveBeenCalledTimes(1);
    expect(lazy).toHaveBeenCalledWith({
      bookingRequest: expect.objectContaining({ id: REQUEST_ID }),
      place: expect.objectContaining({ id: PLACE_ID }),
      taggedHumanIds: [TAGGED_A, TAGGED_B],
      taggedOrgIds: [],
      // v3: the tagging actor is skipped in a group's fan-out.
      actorHumanId: ACTOR_ID,
    });
    const lastTxWrite = mocks.audit.log.mock.invocationCallOrder.at(-1)!;
    expect(lazy.mock.invocationCallOrder[0]!).toBeGreaterThan(lastTxWrite);

    // Two TAGGED acts → two sends; the EXTERNAL act is nobody to notify.
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({
        humanId: TAGGED_A,
        variant: "booking.lineup-invited",
        idempotencyKey: `booking-lineup-invited:${REQUEST_ID}:${TAGGED_A}`,
        payload: expect.objectContaining({
          targetUrl: `${PUBLIC_APP_URL}/bookings/acts/${REQUEST_ID}`,
          senderName: "Sam Sender",
          venueName: "Test Venue",
        }),
      }),
      expect.objectContaining({
        humanId: TAGGED_B,
        idempotencyKey: `booking-lineup-invited:${REQUEST_ID}:${TAGGED_B}`,
      }),
    ]);
  });

  it("no TAGGED act → no invite fan-out", async () => {
    const notifyLineup = vi.fn(async () => {});
    const { deps } = buildDeps({ profile: null, notifyLineup });

    await createBookingRequest(deps, {
      ...baseInput,
      bill: { includeSelf: false, acts: [{ kind: "external", name: "The Openers" }] },
    });

    expect(notifyLineup).not.toHaveBeenCalled();
  });

  it("a THROWING invite notifier never fails the committed request: logged at error AND reported", async () => {
    const boom = new Error("notify pipeline down");
    const { deps, mocks, logger, reportError, actsWritten } = buildDeps({
      profile: null,
      notifyLineup: vi.fn(async () => {
        throw boom;
      }),
    });

    await expect(
      createBookingRequest(deps, { ...baseInput, bill: promoterBill }),
    ).resolves.toMatchObject({ bookingRequestId: REQUEST_ID });

    expect(mocks.bookingRequests.create).toHaveBeenCalledTimes(1);
    expect(await actsWritten()).toHaveLength(3);
    expect(logger.error).toHaveBeenCalledWith(
      "booking_requests.notify_lineup_invited_failed",
      expect.objectContaining({ bookingRequestId: REQUEST_ID, err: boom }),
    );
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "createBookingRequest", step: "lineup_invited" },
      extra: { bookingRequestId: REQUEST_ID, placeId: PLACE_ID, taggedCount: 2 },
    });
  });

  it("a throwing notifier AND a throwing reporter still resolve", async () => {
    const { deps } = buildDeps({
      profile: null,
      notifyLineup: vi.fn(async () => {
        throw new Error("notify down");
      }),
    });
    deps.reportError = () => {
      throw new Error("sentry down");
    };

    await expect(
      createBookingRequest(deps, { ...baseInput, bill: promoterBill }),
    ).resolves.toMatchObject({ bookingRequestId: REQUEST_ID });
  });

  it("a failed bill write is NOT swallowed: the create rejects and nobody is invited", async () => {
    const notifyLineup = vi.fn(async () => {});
    const { deps, repos } = buildDeps({ profile: null, notifyLineup });
    const bag = repos as unknown as {
      bookingRequests: { addActs: (...args: unknown[]) => Promise<unknown> };
    };
    bag.bookingRequests.addActs = vi.fn(async () => {
      throw { code: "conflict", message: "booking_request_act_duplicate" };
    });

    await expect(
      createBookingRequest(deps, { ...baseInput, bill: promoterBill }),
    ).rejects.toMatchObject({ message: "booking_request_act_duplicate" });
    expect(notifyLineup).not.toHaveBeenCalled();
  });

  // ── Schema (strict) ───────────────────────────────────────────────────────

  it.each([
    [
      "more than 12 rows in total (self + 12 acts)",
      {
        includeSelf: true,
        acts: Array.from({ length: 12 }, (_, i) => ({
          kind: "external",
          name: `Act ${i}`,
        })),
      },
    ],
    ["a tagged act with a stray field", { includeSelf: true, acts: [{ kind: "tagged", humanId: TAGGED_A, name: "x" }] }],
    ["a tagged act with a non-uuid id", { includeSelf: true, acts: [{ kind: "tagged", humanId: "alice" }] }],
    ["a javascript: act url", { includeSelf: true, acts: [{ kind: "external", name: "X", url: "javascript:alert(1)" }] }],
    ["an act name that sanitizes to nothing", { includeSelf: true, acts: [{ kind: "external", name: "<script>alert(1)</script>" }] }],
    ["an act name over 120 chars", { includeSelf: true, acts: [{ kind: "external", name: "x".repeat(121) }] }],
    ["an unknown bill field", { includeSelf: true, acts: [], headliner: 0 }],
    ["a missing includeSelf", { acts: [] }],
  ])("rejects %s as invalid input", async (_label, bill) => {
    const { deps, mocks } = buildDeps();

    await expect(
      createBookingRequest(deps, { ...baseInput, bill }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("accepts exactly 12 rows (self + 11 acts)", async () => {
    const { deps, actsWritten } = buildDeps();

    await createBookingRequest(deps, {
      ...baseInput,
      bill: {
        includeSelf: true,
        acts: Array.from({ length: 11 }, (_, i) => ({
          kind: "external",
          name: `Act ${i}`,
        })),
      },
    });

    const acts = await actsWritten();
    expect(acts).toHaveLength(12);
    expect(new Set(acts.map((act) => act.sortOrder)).size).toBe(12);
  });
});

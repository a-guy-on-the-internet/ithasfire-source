import { describe, expect, it, vi } from "vitest";

import type { BookingRequestActRecord } from "@th/ports/repos/booking-requests";
import type { EntityPageRecord } from "@th/types/repos/entity-pages";

import {
  BOOKING_LINEUP_TAG_DAILY_MAX,
  createBookingRequest,
  type CreateBookingRequestDeps,
} from "../create-booking-request";
import { bookingBillSchema } from "../_shared/bill-schema";
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
// createBookingRequest, lineup-booking-requests v3 (FR-002, L12, L13, L17):
// a tagged act may be a GROUP; each act carries a role (+ label beside
// OTHER); groups are taggable when search would surface them (an ACTIVE
// org) and spend the same daily tag budget. The v2 behaviour is pinned by
// create-booking-request-bill.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

const GROUP_A = "6a6a6a6a-6a6a-46a6-86a6-6a6a6a6a6a6a";
const GROUP_B = "6b6b6b6b-6b6b-46b6-86b6-6b6b6b6b6b6b";
const SUSPENDED_GROUP = "6c6c6c6c-6c6c-46c6-86c6-6c6c6c6c6c6c";
const TAGGED_HUMAN = "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1";

const ORGS = [
  { id: GROUP_A, name: "Paper Moth", status: "ACTIVE" },
  // No page at all — still taggable: search surfaces every ACTIVE org.
  { id: GROUP_B, name: "Junco Collective", status: "ACTIVE" },
  { id: SUSPENDED_GROUP, name: "Gone Band", status: "SUSPENDED" },
  { id: ORG_ID, name: "Night Owl Presents", status: "ACTIVE" },
];

function page(
  ownerType: "HUMAN" | "ORGANIZATION",
  ownerId: string,
  overrides: Partial<EntityPageRecord> = {},
): EntityPageRecord {
  return {
    id: `page-${ownerId}`,
    ownerType,
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

const PAGES = [
  page("HUMAN", TAGGED_HUMAN),
  page("ORGANIZATION", GROUP_A, { displayName: "Paper Moth (band)" }),
];

function makeBucket(used = 0) {
  let count = used;
  const consume = vi.fn(async (_key: string, max: number) => {
    count += 1;
    const allowed = count <= max;
    return { allowed, remaining: allowed ? max - count : 0, retryAfterSeconds: 3600 };
  });
  return { consume, count: () => count };
}

function buildDeps(
  options: {
    rateLimit?: ReturnType<typeof makeBucket> | null;
    notifyLineup?: CreateBookingRequestDeps["notifyBookingLineupInvited"];
    /** The org sender's membership for ACTOR_ID (org-sender tests). */
    senderOrgRole?: string | null;
  } = {},
) {
  const bookingRequests = {
    findOpenByPerformerAndPlace: vi.fn(async () => null),
    create: vi.fn(async (input: Record<string, unknown>) =>
      buildBookingRequestRecord(input as never),
    ),
  };
  const organizations = {
    getByIds: vi.fn(async (ids: string[]) =>
      ORGS.filter((org) => ids.includes(org.id)),
    ),
  };
  const mocks = {
    bookingRequests,
    performerProfiles: { getByOwner: vi.fn(async () => buildPerformerProfile()) },
    places: { getById: vi.fn(async () => buildPlaceRecord()) },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, genreTags: [] })),
      getByIds: vi.fn(async (ids: string[]) =>
        ids.map((id) => ({ id, name: "Tagged Human", status: "ACTIVE" })),
      ),
    },
    entityPages: {
      getByOwners: vi.fn(async (type: string, ids: string[]) =>
        PAGES.filter((row) => row.ownerType === type && ids.includes(row.ownerId)),
      ),
      getByOwner: vi.fn(async () => null),
    },
    organizations,
    authz: {
      getOrgMembership: vi.fn(async ({ orgId, humanId }: { orgId: string; humanId: string }) =>
        options.senderOrgRole && orgId === ORG_ID && humanId === ACTOR_ID
          ? { orgId, humanId, role: options.senderOrgRole }
          : null,
      ),
    },
    audit: { log: vi.fn(async () => {}) },
    humanStats: { findByHumanId: vi.fn(async () => null) },
    events: {
      listPublishedByPlace: vi.fn(async () => ({ items: [], nextCursor: null })),
      listPublishedOccurrencesByPlace: vi.fn(async () => []),
    },
    calendars: {
      findById: vi.fn(async () => null),
      findDefaultForPlace: vi.fn(async () => null),
      listByPlace: vi.fn(async () => []),
      listAvailabilityForPlace: vi.fn(async () => []),
      countAvailabilityForPlace: vi.fn(async () => 1),
    },
  };
  const repos = withTx(mocks);
  const deps: CreateBookingRequestDeps = {
    repos: repos as unknown as CreateBookingRequestDeps["repos"],
    clock: { now: () => NOW },
    reportError: vi.fn(),
    rateLimit: (options.rateLimit ?? null) as CreateBookingRequestDeps["rateLimit"],
    notifyBookingLineupInvited: options.notifyLineup,
  };
  const actsWritten = async (): Promise<BookingRequestActRecord[]> =>
    (
      repos as unknown as {
        bookingRequests: {
          listActsForRequests: (ids: string[]) => Promise<BookingRequestActRecord[]>;
        };
      }
    ).bookingRequests.listActsForRequests([REQUEST_ID]);
  return { deps, mocks, actsWritten };
}

const baseInput = {
  actorHumanId: ACTOR_ID,
  performerOwnerType: "human",
  performerOwnerId: ACTOR_ID,
  placeId: PLACE_ID,
  message: "A three-act night.",
  preferredDates: ["2026-07-10"],
};

describe("bill schema — a tagged act is a person OR a group (v3 L17)", () => {
  it("takes exactly one of humanId / orgId", () => {
    const parse = (act: Record<string, unknown>) =>
      bookingBillSchema.safeParse({ includeSelf: false, acts: [act] }).success;

    expect(parse({ kind: "tagged", humanId: TAGGED_HUMAN })).toBe(true);
    expect(parse({ kind: "tagged", orgId: GROUP_A })).toBe(true);
    expect(parse({ kind: "tagged", humanId: TAGGED_HUMAN, orgId: GROUP_A })).toBe(false);
    expect(parse({ kind: "tagged" })).toBe(false);
    expect(parse({ kind: "tagged", orgId: "not-a-uuid" })).toBe(false);
    // Strict all the way down: no smuggled owner type.
    expect(parse({ kind: "tagged", orgId: GROUP_A, actOwnerType: "human" })).toBe(false);
  });

  it("each act takes a role from EventHuman's list, and a label ≤ 60 sanitized before the check", () => {
    const parse = (act: Record<string, unknown>) =>
      bookingBillSchema.safeParse({ includeSelf: false, acts: [act] });

    expect(parse({ kind: "tagged", orgId: GROUP_A, role: "DJ" }).success).toBe(true);
    expect(parse({ kind: "external", name: "Junco", role: "HOST" }).success).toBe(true);
    expect(parse({ kind: "tagged", orgId: GROUP_A, role: "HEADLINER" }).success).toBe(false);
    expect(
      parse({ kind: "external", name: "Junco", role: "OTHER", customRoleLabel: "x".repeat(61) })
        .success,
    ).toBe(false);
    // Markup is stripped BEFORE measuring: 60 visible chars inside tags pass.
    const parsed = parse({
      kind: "external",
      name: "Junco",
      role: "OTHER",
      customRoleLabel: `<b>${"x".repeat(60)}</b>`,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("createBookingRequest — groups on the bill (v3 L17)", () => {
  it("writes a TAGGED group row (PENDING, invited now) and invites it, beside a tagged person", async () => {
    const notifyLineup = vi.fn(async () => {});
    const { deps, actsWritten } = buildDeps({ notifyLineup });

    await createBookingRequest(deps, {
      ...baseInput,
      bill: {
        includeSelf: true,
        acts: [
          { kind: "tagged", orgId: GROUP_A },
          { kind: "tagged", humanId: TAGGED_HUMAN },
        ],
      },
    });

    const acts = await actsWritten();
    expect(acts.map((act) => [act.source, act.actOwnerType, act.actOwnerId, act.sortOrder])).toEqual([
      ["SELF", "human", ACTOR_ID, 0],
      ["TAGGED", "organization", GROUP_A, 1],
      ["TAGGED", "human", TAGGED_HUMAN, 2],
    ]);
    expect(acts[1]).toMatchObject({ confirmation: "PENDING", invitedAt: NOW });
    expect(notifyLineup).toHaveBeenCalledWith(
      expect.objectContaining({
        taggedHumanIds: [TAGGED_HUMAN],
        taggedOrgIds: [GROUP_A],
      }),
    );
  });

  it("a group with no page is taggable (search surfaces every ACTIVE org); a SUSPENDED one is not", async () => {
    const ok = buildDeps();
    await expect(
      createBookingRequest(ok.deps, {
        ...baseInput,
        bill: { includeSelf: true, acts: [{ kind: "tagged", orgId: GROUP_B }] },
      }),
    ).resolves.toMatchObject({ bookingRequestId: REQUEST_ID });

    const refused = buildDeps();
    await expect(
      createBookingRequest(refused.deps, {
        ...baseInput,
        bill: { includeSelf: true, acts: [{ kind: "tagged", orgId: SUSPENDED_GROUP }] },
      }),
    ).rejects.toMatchObject({
      code: "ACT_NOT_TAGGABLE",
      meta: { reason: "not_taggable", orgId: SUSPENDED_GROUP },
    });
    expect(refused.mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("an unknown group id is not taggable, and nothing is written", async () => {
    const { deps, mocks } = buildDeps();
    const UNKNOWN = "6d6d6d6d-6d6d-46d6-86d6-6d6d6d6d6d6d";
    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        bill: { includeSelf: true, acts: [{ kind: "tagged", orgId: UNKNOWN }] },
      }),
    ).rejects.toMatchObject({ code: "ACT_NOT_TAGGABLE", meta: { orgId: UNKNOWN } });
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("a group tagged twice → ACT_NOT_TAGGABLE duplicate, before any read but the place", async () => {
    const { deps, mocks } = buildDeps();
    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        bill: {
          includeSelf: true,
          acts: [
            { kind: "tagged", orgId: GROUP_A },
            { kind: "tagged", orgId: GROUP_A },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "ACT_NOT_TAGGABLE",
      meta: { reason: "duplicate", orgId: GROUP_A },
    });
    // The ONE read ahead of the bill is the place's claimed check (amendment
    // 2026-09-25: an unclaimed venue is refused before the bill). Nothing
    // else is read: the walk's own place read never runs.
    expect(mocks.places.getById).toHaveBeenCalledTimes(1);
  });

  it("an ORG sender cannot tag ITSELF (that is the 'I'm on the bill' toggle); a human sender may tag a group", async () => {
    const orgSender = buildDeps({ senderOrgRole: "ADMIN" });
    await expect(
      createBookingRequest(orgSender.deps, {
        ...baseInput,
        performerOwnerType: "org",
        performerOwnerId: ORG_ID,
        bill: { includeSelf: false, acts: [{ kind: "tagged", orgId: ORG_ID }] },
      }),
    ).rejects.toMatchObject({
      code: "ACT_NOT_TAGGABLE",
      meta: { reason: "self", orgId: ORG_ID },
    });

    // The same org id tagged by a HUMAN sender is another party: fine.
    const humanSender = buildDeps();
    await expect(
      createBookingRequest(humanSender.deps, {
        ...baseInput,
        bill: { includeSelf: true, acts: [{ kind: "tagged", orgId: ORG_ID }] },
      }),
    ).resolves.toMatchObject({ bookingRequestId: REQUEST_ID });
  });

  it("groups spend the daily tag budget like people: 1 person + 2 groups = 3 tokens", async () => {
    const rateLimit = makeBucket();
    const { deps } = buildDeps({ rateLimit });

    await createBookingRequest(deps, {
      ...baseInput,
      bill: {
        includeSelf: true,
        acts: [
          { kind: "tagged", humanId: TAGGED_HUMAN },
          { kind: "tagged", orgId: GROUP_A },
          { kind: "tagged", orgId: GROUP_B },
        ],
      },
    });

    expect(rateLimit.count()).toBe(3);
  });

  it("a bill of groups that would overrun the budget is refused, spending one probe token", async () => {
    const rateLimit = makeBucket(BOOKING_LINEUP_TAG_DAILY_MAX - 1);
    const { deps, mocks } = buildDeps({ rateLimit });

    await expect(
      createBookingRequest(deps, {
        ...baseInput,
        bill: {
          includeSelf: true,
          acts: [
            { kind: "tagged", orgId: GROUP_A },
            { kind: "tagged", orgId: GROUP_B },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", message: "lineup_tag_budget" });
    expect(rateLimit.count()).toBe(BOOKING_LINEUP_TAG_DAILY_MAX);
    expect(mocks.bookingRequests.create).not.toHaveBeenCalled();
  });

  it("actName is NEVER prefilled from a tagged act — a group included (NFR-002)", async () => {
    const { deps, mocks } = buildDeps();

    await createBookingRequest(deps, {
      ...baseInput,
      bill: {
        includeSelf: false,
        acts: [
          { kind: "tagged", orgId: GROUP_A },
          { kind: "external", name: "Junco" },
        ],
      },
    });

    // The first FREE-TEXT act, never the (pending) group ahead of it.
    expect(mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ actName: "Junco" }),
    );
    const withOnlyTags = buildDeps();
    await createBookingRequest(withOnlyTags.deps, {
      ...baseInput,
      bill: { includeSelf: false, acts: [{ kind: "tagged", orgId: GROUP_A }] },
    });
    expect(withOnlyTags.mocks.bookingRequests.create).toHaveBeenCalledWith(
      expect.objectContaining({ actName: null }),
    );
  });
});

describe("createBookingRequest — each act carries a role (v3 L13)", () => {
  it("writes the given role, PERFORMER by default, and keeps a label ONLY beside OTHER", async () => {
    const { deps, actsWritten } = buildDeps();

    await createBookingRequest(deps, {
      ...baseInput,
      bill: {
        includeSelf: true,
        acts: [
          { kind: "tagged", humanId: TAGGED_HUMAN, role: "DJ" },
          { kind: "tagged", orgId: GROUP_A, role: "OTHER", customRoleLabel: " Backing band " },
          // A stale label beside a non-OTHER role is dropped, not refused.
          { kind: "external", name: "Junco", role: "HOST", customRoleLabel: "MC" },
          // OTHER with a blank label → no label.
          { kind: "external", name: "Wren", role: "OTHER", customRoleLabel: "   " },
          { kind: "external", name: "Finch" },
        ],
      },
    });

    const acts = await actsWritten();
    expect(acts.map((act) => [act.role, act.customRoleLabel])).toEqual([
      // SELF is always the sender as a PERFORMER at position 1.
      ["PERFORMER", null],
      ["DJ", null],
      ["OTHER", "Backing band"],
      ["HOST", null],
      ["OTHER", null],
      ["PERFORMER", null],
    ]);
  });
});

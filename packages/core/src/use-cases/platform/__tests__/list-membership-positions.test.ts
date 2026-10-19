import { describe, expect, it, vi } from "vitest";

import type {
  MembershipHealthPosition,
  MembershipHealthPositionsQuery,
} from "@th/ports/repos/memberships";

import {
  MEMBERSHIP_POSITIONS_INCOMPLETE_GRACE_HOURS,
  MEMBERSHIP_POSITIONS_LEAVING_WITHIN_DAYS,
  MEMBERSHIP_POSITIONS_STATEMENT_TIMEOUT_MS,
  listMembershipPositions,
  type ListMembershipPositionsDeps,
} from "../list-membership-positions";
import { reportMembershipHealthInputSchema } from "../../memberships/report-membership-health";
import {
  MEMBERSHIP_LIVE_STATUSES,
  MEMBERSHIP_PAYMENT_FAILING_STATUSES,
} from "../../memberships/membership-status";

const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOW = new Date("2026-09-11T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function position(
  overrides: Partial<MembershipHealthPosition> = {},
): MembershipHealthPosition {
  return {
    id: "m-1",
    status: "past_due",
    memberHumanId: "human-1",
    memberName: "Alex Rivera",
    tierId: "tier-1",
    tierName: "Sustaining Member",
    tierPriceCents: 1_200,
    tierCurrency: "usd",
    tierInterval: "MONTH",
    ownerOrgId: "org-1",
    ownerOrgName: "Ithas Fire Demo Org",
    ownerOrgSlug: "demo",
    ownerHumanId: null,
    ownerHumanName: null,
    currentPeriodStart: new Date("2026-08-31T09:00:00.000Z"),
    currentPeriodEnd: new Date("2026-09-30T09:00:00.000Z"),
    cancelAtPeriodEnd: false,
    startedAt: new Date("2026-05-01T09:00:00.000Z"),
    createdAt: new Date("2026-05-01T09:00:00.000Z"),
    updatedAt: new Date("2026-09-02T09:00:00.000Z"),
    ...overrides,
  };
}

function makeDeps(
  options: {
    allowed?: boolean;
    items?: MembershipHealthPosition[];
    nextCursor?: string | null;
    total?: number;
  } = {},
) {
  const hasStaffRole = vi.fn(async () => ({ allowed: options.allowed ?? true }));
  const listHealthPositions = vi.fn(async () => ({
    items: options.items ?? [position()],
    nextCursor: options.nextCursor ?? null,
    total: options.total ?? 1,
  }));
  const deps = {
    repos: { memberships: { listHealthPositions } },
    authz: { hasStaffRole },
    clock: { now: () => NOW },
    logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as ListMembershipPositionsDeps;

  return {
    deps,
    hasStaffRole,
    listHealthPositions,
    run: (input: Record<string, unknown> = {}) =>
      listMembershipPositions(deps, {
        actorHumanId: ACTOR,
        bucket: "attention",
        ...input,
      }),
  };
}

describe("listMembershipPositions — authz", () => {
  it("refuses a non-staff actor with STAFF_ONLY, before reading anything", async () => {
    const h = makeDeps({ allowed: false });
    await expect(h.run()).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(h.listHealthPositions).not.toHaveBeenCalled();
  });

  it("checks ADMIN|SUPPORT in the use case", async () => {
    const h = makeDeps();
    await h.run();
    expect(h.hasStaffRole).toHaveBeenCalledWith({
      actorHumanId: ACTOR,
      requiredRoles: ["ADMIN", "SUPPORT"],
    });
  });

  it("refuses an input with unknown keys (strict), which is why paging is utils.fetch", async () => {
    // `useInfiniteQuery` injects a `direction` key; the strict schema refuses
    // it, which is exactly why the UI pages by hand.
    const h = makeDeps();
    await expect(
      listMembershipPositions(h.deps, {
        actorHumanId: ACTOR,
        bucket: "attention",
        direction: "forward",
      }),
    ).rejects.toBeTruthy();
  });

  it("refuses an unknown bucket", async () => {
    const h = makeDeps();
    await expect(h.run({ bucket: "everything" })).rejects.toBeTruthy();
  });
});

describe("listMembershipPositions — windows", () => {
  it("measures the incomplete grace window back from now", async () => {
    const h = makeDeps();
    await h.run();
    const query = h.listHealthPositions.mock
      .calls[0]?.[0] as MembershipHealthPositionsQuery;
    expect(query.incompleteBefore.getTime()).toBe(
      NOW.getTime() - MEMBERSHIP_POSITIONS_INCOMPLETE_GRACE_HOURS * HOUR_MS,
    );
  });

  it("bounds the leaving window between now and the horizon", async () => {
    const h = makeDeps();
    await h.run({ bucket: "leaving" });
    const query = h.listHealthPositions.mock
      .calls[0]?.[0] as MembershipHealthPositionsQuery;
    expect(query.leavingFrom.getTime()).toBe(NOW.getTime());
    expect(query.leavingBefore.getTime()).toBe(
      NOW.getTime() + MEMBERSHIP_POSITIONS_LEAVING_WITHIN_DAYS * DAY_MS,
    );
  });

  it("uses the same windows the health JOB does", async () => {
    // DRIFT GUARD. If the page and the alert disagree about which rows are a
    // problem, a staff member reading "3 need attention" under a Discord post
    // saying 5 has no way to tell which is lying.
    const jobDefaults = reportMembershipHealthInputSchema.parse({});
    expect(MEMBERSHIP_POSITIONS_INCOMPLETE_GRACE_HOURS).toBe(
      jobDefaults.incompleteGraceHours,
    );
    expect(MEMBERSHIP_POSITIONS_LEAVING_WITHIN_DAYS).toBe(
      jobDefaults.leavingWithinDays,
    );
  });

  it("passes the shared status constants and a statement budget", async () => {
    const h = makeDeps();
    await h.run({ limit: 10, cursor: "abc" });
    expect(h.listHealthPositions).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: "attention",
        paymentFailingStatuses: [...MEMBERSHIP_PAYMENT_FAILING_STATUSES],
        liveStatuses: [...MEMBERSHIP_LIVE_STATUSES],
        cursor: "abc",
        limit: 10,
        statementTimeoutMs: MEMBERSHIP_POSITIONS_STATEMENT_TIMEOUT_MS,
      }),
    );
  });

  it("omits `limit` entirely when the caller passed none, leaving the adapter default", async () => {
    const h = makeDeps();
    await h.run();
    const query = h.listHealthPositions.mock
      .calls[0]?.[0] as MembershipHealthPositionsQuery;
    expect("limit" in query).toBe(false);
  });
});

describe("listMembershipPositions — rows", () => {
  it("reports an INCOMPLETE row's age from createdAt, and says it is exact", async () => {
    // The one status whose start instant is genuinely known: the row is
    // written at signup and has never had a successful invoice.
    const h = makeDeps({
      items: [
        position({
          status: "incomplete",
          createdAt: new Date("2026-09-07T12:00:00.000Z"),
          updatedAt: new Date("2026-09-10T12:00:00.000Z"),
        }),
      ],
    });
    const out = await h.run();
    expect(out.items[0]).toMatchObject({
      sinceBasis: "signup",
      sinceAt: new Date("2026-09-07T12:00:00.000Z"),
    });
  });

  it("reports every OTHER row's age from updatedAt, and flags it approximate", async () => {
    // There is no per-status timestamp on Membership. `updatedAt` moves on any
    // write, so it is labelled rather than presented as an exact age.
    const h = makeDeps({
      items: [
        position({
          status: "unpaid",
          createdAt: new Date("2026-05-01T09:00:00.000Z"),
          updatedAt: new Date("2026-09-02T09:00:00.000Z"),
        }),
      ],
    });
    const out = await h.run();
    expect(out.items[0]).toMatchObject({
      sinceBasis: "lastChange",
      sinceAt: new Date("2026-09-02T09:00:00.000Z"),
    });
  });

  it("resolves an ORG-owned tier to a linkable owner", async () => {
    const h = makeDeps();
    const out = await h.run();
    expect(out.items[0]).toMatchObject({
      ownerType: "ORG",
      ownerId: "org-1",
      ownerLabel: "Ithas Fire Demo Org",
      ownerSlug: "demo",
    });
  });

  it("resolves a HUMAN-owned tier with no slug — people have no admin surface", async () => {
    const h = makeDeps({
      items: [
        position({
          ownerOrgId: null,
          ownerOrgName: null,
          ownerOrgSlug: "should-be-ignored",
          ownerHumanId: "human-9",
          ownerHumanName: "Jamie Chen",
        }),
      ],
    });
    const out = await h.run();
    expect(out.items[0]).toMatchObject({
      ownerType: "HUMAN",
      ownerId: "human-9",
      ownerLabel: "Jamie Chen",
      ownerSlug: null,
    });
  });

  it("falls back to the tier id when a tier has NEITHER owner, rather than dropping the row", async () => {
    // The owner XOR is enforced in core and cannot be expressed in the schema,
    // so a violating row is possible. It must stay visible and actionable.
    const h = makeDeps({
      items: [
        position({
          ownerOrgId: null,
          ownerOrgName: null,
          ownerOrgSlug: null,
          ownerHumanId: null,
          ownerHumanName: null,
        }),
      ],
    });
    const out = await h.run();
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({
      ownerType: "HUMAN",
      ownerId: "tier-1",
      ownerLabel: null,
    });
  });

  it("carries the cursor, the whole-bucket total and the clock through", async () => {
    const h = makeDeps({ nextCursor: "next-page", total: 42 });
    const out = await h.run();
    expect(out.nextCursor).toBe("next-page");
    expect(out.total).toBe(42);
    expect(out.asOf).toEqual(NOW);
  });

  it("never re-cases Stripe's status vocabulary", async () => {
    const h = makeDeps({ items: [position({ status: "past_due" })] });
    const out = await h.run();
    expect(out.items[0]!.status).toBe("past_due");
  });
});

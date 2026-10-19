import { describe, expect, it, vi } from "vitest";

import type { AuthZPort } from "@th/ports/authz";
import type { Repos } from "@th/ports/repos";
import type { ListPlatformTicketsItem, VolunteerSignupRecord } from "@th/types";

import { getScannerEventManifest } from "./get-scanner-event-manifest";

const denyingAuthz = {
  hasStaffRole: vi.fn(async () => ({ allowed: false })),
} as unknown as AuthZPort;

const ACTOR = "00000000-0000-4000-8000-000000000001";
const ORG = "00000000-0000-4000-8000-0000000000a1";
const EVT = "00000000-0000-4000-8000-0000000000a2";
const HUMAN_A = "00000000-0000-4000-8000-00000000aaa1";
const HUMAN_B = "00000000-0000-4000-8000-00000000aaa2";
const HUMAN_C = "00000000-0000-4000-8000-00000000aaa3";

function ticket(
  id: string,
  ownerHumanId: string,
  ownerName: string | null,
  ownerEmail: string | null,
): ListPlatformTicketsItem {
  return {
    id,
    code: `T-${id}`,
    status: "ACTIVE",
    eventId: EVT,
    eventTitle: "Test Event",
    ticketTypeId: "tt-1",
    ticketTypeName: "GA",
    orderId: "ord-1",
    ownerHumanId,
    ownerName,
    ownerEmail,
    issuedAt: new Date("2026-04-01T00:00:00Z"),
    scannedAt: null,
    seatLabel: null,
    transferCount: 0,
    scanCount: 0,
  };
}

function signup(
  overrides: Partial<VolunteerSignupRecord>,
): VolunteerSignupRecord {
  return {
    id: "sg-1",
    eventId: EVT,
    roleId: "role-1",
    shiftId: null,
    humanId: null,
    contactEmail: "v@example.com",
    contactName: null,
    contactPhone: null,
    status: "PENDING",
    answers: null,
    reviewerHumanId: null,
    reviewedAt: null,
    checkedInAt: null,
    notes: null,
    metadata: null,
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
    ...overrides,
  };
}

function makeDeps(opts: {
  tickets?: ListPlatformTicketsItem[];
  signups?: VolunteerSignupRecord[];
  membershipRole?: string | null;
  eventOrgId?: string | null;
}) {
  const tickets = opts.tickets ?? [];
  const signups = opts.signups ?? [];
  const repos = {
    events: {
      getById: vi.fn(async () => ({
        id: EVT,
        orgId: opts.eventOrgId === undefined ? ORG : opts.eventOrgId,
      })),
    },
    authz: {
      getOrgMembership: vi.fn(async () =>
        opts.membershipRole === null
          ? null
          : {
              orgId: ORG,
              humanId: ACTOR,
              role: opts.membershipRole ?? "SCANNER",
            },
      ),
    },
    tickets: {
      listAll: vi.fn(async () => ({
        items: tickets,
        total: tickets.length,
        limit: 10_000,
        offset: 0,
      })),
    },
    volunteering: {
      listSignups: vi.fn(async () => ({
        items: signups,
        pageInfo: {
          total: signups.length,
          count: signups.length,
          limit: 10_000,
          offset: 0,
          hasNextPage: false,
          nextOffset: null,
        },
      })),
    },
  };
  return repos as unknown as Repos;
}

describe("getScannerEventManifest — people", () => {
  it("dedupes attendees by ownerHumanId across multiple tickets", async () => {
    const repos = makeDeps({
      tickets: [
        ticket("t1", HUMAN_A, "Alice", "alice@example.com"),
        ticket("t2", HUMAN_A, "Alice", "alice@example.com"),
        ticket("t3", HUMAN_B, "Bob", "bob@example.com"),
      ],
    });

    const result = await getScannerEventManifest(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, eventId: EVT },
    );

    const attendees = result.people.filter((p) => p.kind === "attendee");
    expect(attendees).toHaveLength(2);
    expect(attendees.map((p) => p.humanId).sort()).toEqual(
      [HUMAN_A, HUMAN_B].sort(),
    );
    expect(result.tickets).toHaveLength(3);
  });

  it("returns volunteer rows for every signup status with signupStatus populated", async () => {
    const repos = makeDeps({
      signups: [
        signup({
          id: "sg-1",
          humanId: HUMAN_A,
          contactName: "A",
          contactEmail: "a@x",
          status: "APPROVED",
        }),
        signup({
          id: "sg-2",
          humanId: HUMAN_B,
          contactName: "B",
          contactEmail: "b@x",
          status: "PENDING",
        }),
        signup({
          id: "sg-3",
          humanId: HUMAN_C,
          contactName: "C",
          contactEmail: "c@x",
          status: "REJECTED",
        }),
      ],
    });

    const result = await getScannerEventManifest(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, eventId: EVT },
    );

    const volunteers = result.people.filter((p) => p.kind === "volunteer");
    expect(volunteers).toHaveLength(3);
    expect(volunteers.map((v) => v.signupStatus).sort()).toEqual(
      ["APPROVED", "PENDING", "REJECTED"].sort(),
    );
  });

  it("returns the same human twice when they are both attendee and volunteer", async () => {
    const repos = makeDeps({
      tickets: [ticket("t1", HUMAN_A, "Alice", "alice@example.com")],
      signups: [
        signup({
          id: "sg-1",
          humanId: HUMAN_A,
          contactName: "Alice",
          contactEmail: "alice@example.com",
          status: "APPROVED",
        }),
      ],
    });

    const result = await getScannerEventManifest(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, eventId: EVT },
    );

    const rowsForA = result.people.filter((p) => p.humanId === HUMAN_A);
    expect(rowsForA).toHaveLength(2);
    expect(rowsForA.map((r) => r.kind).sort()).toEqual([
      "attendee",
      "volunteer",
    ]);
  });

  it("falls back to signup:<id> when a volunteer signup has no humanId", async () => {
    const repos = makeDeps({
      signups: [
        signup({
          id: "sg-orphan",
          humanId: null,
          contactName: "Guest Volunteer",
          contactEmail: "guest@example.com",
          status: "PENDING",
        }),
      ],
    });

    const result = await getScannerEventManifest(
      { repos, authz: denyingAuthz },
      { actorHumanId: ACTOR, eventId: EVT },
    );

    expect(result.people).toHaveLength(1);
    expect(result.people[0]).toMatchObject({
      humanId: "signup:sg-orphan",
      kind: "volunteer",
      displayName: "Guest Volunteer",
      email: "guest@example.com",
      signupStatus: "PENDING",
    });
  });

  it("throws forbidden when actor is not in ORG_SCAN_ROLES", async () => {
    const repos = makeDeps({
      tickets: [ticket("t1", HUMAN_A, "Alice", "alice@example.com")],
      membershipRole: "FINANCE",
    });

    await expect(
      getScannerEventManifest(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, eventId: EVT },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("throws not_found when event is missing or has no orgId", async () => {
    const repos = makeDeps({ eventOrgId: null });

    await expect(
      getScannerEventManifest(
        { repos, authz: denyingAuthz },
        { actorHumanId: ACTOR, eventId: EVT },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("logs scanner.manifest_truncated when a source exceeds the page limit", async () => {
    const repos = makeDeps({
      tickets: [ticket("t1", HUMAN_A, "Alice", "alice@example.com")],
    });
    // Force tickets.total to exceed the cap without materializing 10k rows.
    (repos.tickets.listAll as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      items: [ticket("t1", HUMAN_A, "Alice", "alice@example.com")],
      total: 10_005,
      limit: 10_000,
      offset: 0,
    });

    const warn = vi.fn();
    const logger = {
      child: () => logger,
      withTime: async <T>(_n: string, f: () => Promise<T>) => f(),
      log: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    };

    await getScannerEventManifest(
      { repos, authz: denyingAuthz, logger: logger as never },
      { actorHumanId: ACTOR, eventId: EVT },
    );

    expect(warn).toHaveBeenCalledWith(
      "scanner.manifest_truncated",
      expect.objectContaining({
        eventId: EVT,
        kind: "tickets",
        total: 10_005,
        returned: 10_000,
      }),
    );
  });
});

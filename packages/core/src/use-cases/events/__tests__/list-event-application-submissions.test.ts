import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";
import type {
  EventApplicationSubmissionRecord,
  EventRecord,
  Repos,
  TxRepos,
} from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { listEventApplicationSubmissions } from "../list-event-application-submissions";

const EVENT_ID = "60000000-0000-4000-8000-000000000006";
const ORG_ID = "70000000-0000-4000-8000-000000000007";
const ACTOR_ID = "80000000-0000-4000-8000-000000000008";
const NOW = new Date("2025-12-03T15:00:00Z");

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "VIP Soiree",
  status: "PUBLISHED",
  visibility: "PRIVATE",
  gateType: "APPLICATION",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2026-01-10T20:00:00Z"),
  endsAt: new Date("2026-01-11T01:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  slug: "vip-soiree",
  shortId: "VIP123",
  regionCode: "US-CA",
  publishedAt: new Date("2025-11-01T00:00:00Z"),
  agreementPrimaryId: "AgreementPrimary",
  agreementResaleId: null,
  defaultLocale: "en-US",
  listingPriority: null,
  passwordHash: null,
  passwordUpdatedAt: null,
  waitlistStatus: "DISABLED",
  waitlistPublishAt: null,
  waitlistDescription: null,
  waitlistCap: null,
  payoutTermsId: null,
  resalePayoutTermsId: null,
  placeLayoutId: null,
  currency: null,
};

const baseSubmission: EventApplicationSubmissionRecord = {
  id: "90000000-0000-4000-8000-000000000009",
  eventId: EVENT_ID,
  humanId: "a0000000-0000-4000-8000-00000000000a",
  contactEmail: "guest@example.com",
  contactPhone: "+15555550100",
  status: "PENDING",
  answers: { q1: "Hi" },
  decisionReason: null,
  questionsSnapshot: {},
  reviewerHumanId: null,
  reviewedAt: null,
  approvalToken: null,
  tokenExpiresAt: null,
  inviteId: null,
  metadata: {},
  createdAt: NOW,
  updatedAt: NOW,
};

const membership: OrgMembership = {
  orgId: ORG_ID,
  humanId: ACTOR_ID,
  role: "ADMIN",
};

type Deps = ReturnType<typeof createDeps>;

function createDeps(
  overrides: {
    event?: Partial<EventRecord | null>;
    membership?: OrgMembership | null;
    submissions?: EventApplicationSubmissionRecord[];
  } = {},
) {
  const eventValue =
    overrides.event === null
      ? null
      : { ...baseEvent, ...(overrides.event ?? {}) };
  const membershipValue =
    overrides.membership !== undefined ? overrides.membership : membership;
  const submissionsValue = overrides.submissions ?? [baseSubmission];

  const eventsRepo = {
    getById: vi.fn().mockResolvedValue(eventValue),
  };
  const authzRepo = {
    getOrgMembership: vi
      .fn()
      .mockResolvedValue(eventValue ? membershipValue : null),
    getStaffRolesForHumanId: vi.fn(async () => []),
  };
  const eventApplicationsRepo = {
    listSubmissions: vi.fn().mockResolvedValue({
      items: submissionsValue,
      pageInfo: { total: submissionsValue.length },
    }),
  };
  const tx = {
    events: eventsRepo,
    authz: authzRepo,
    eventApplications: eventApplicationsRepo,
  } as unknown as TxRepos;

  const repos = {
    tx: vi.fn(async (fn: (txRepos: TxRepos) => Promise<unknown>) => fn(tx)),
  } as unknown as Repos;

  const info = vi.fn();
  const logger: LoggerPort = {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_name, fn) => fn()),
    log: vi.fn(),
    info,
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggerPort;

  return {
    repos,
    logger,
    info,
    eventApplicationsRepo,
    authzRepo,
    eventsRepo,
    submissionsValue,
  };
}

describe("listEventApplicationSubmissions", () => {
  let deps: Deps;

  beforeEach(() => {
    deps = createDeps();
  });

  it("returns submissions with pagination defaults", async () => {
    const result = await listEventApplicationSubmissions(
      { repos: deps.repos, logger: deps.logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
      },
    );

    expect(deps.eventApplicationsRepo.listSubmissions).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      purpose: "ATTEND",
      statuses: undefined,
      limit: 50,
      offset: 0,
    });
    expect(result).toEqual({
      eventId: EVENT_ID,
      submissions: deps.submissionsValue,
      pagination: { limit: 50, offset: 0, count: deps.submissionsValue.length },
      appliedFilters: { statuses: null },
    });
  });

  it("survives a raw-shaped questionsSnapshot (tolerant read) and normalizes its options", async () => {
    // Belt and braces for the snapshot writer: a snapshot row written with
    // legacy/raw option shapes must never 500 the whole queue list. The
    // record schema normalizes options on read instead of rejecting.
    deps = createDeps({
      submissions: [
        {
          ...baseSubmission,
          questionsSnapshot: {
            "q-raw": {
              label: "Set length",
              type: "SINGLE_CHOICE",
              options: ["15 min", { value: "Yes" }, null, { junk: true }],
            },
          } as unknown as EventApplicationSubmissionRecord["questionsSnapshot"],
        },
      ],
    });

    const result = await listEventApplicationSubmissions(
      { repos: deps.repos, logger: deps.logger },
      { actorHumanId: ACTOR_ID, eventId: EVENT_ID },
    );

    expect(result.submissions[0]!.questionsSnapshot).toEqual({
      "q-raw": {
        label: "Set length",
        type: "SINGLE_CHOICE",
        options: [
          { id: "opt-1", label: "15 min" },
          { id: "opt-2", label: "Yes" },
        ],
      },
    });
    expect(deps.info).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({
        action: "application_submissions_listed",
        result: "success",
      }),
    );
  });

  it("throws when the event is not application gated", async () => {
    deps = createDeps({ event: { gateType: "PASSWORD" } });

    await expect(
      listEventApplicationSubmissions(
        { repos: deps.repos, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_APPLICATION_GATED" });
  });

  it("applies status filters and pagination bounds", async () => {
    const submissions = [{ ...baseSubmission, status: "APPROVED" as const }];
    deps = createDeps({ submissions });

    const result = await listEventApplicationSubmissions(
      { repos: deps.repos, logger: deps.logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        statuses: ["APPROVED", "APPROVED", "REJECTED"],
        limit: 500,
        offset: -10,
      },
    );

    expect(deps.eventApplicationsRepo.listSubmissions).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      purpose: "ATTEND",
      statuses: ["APPROVED", "REJECTED"],
      limit: 200,
      offset: 0,
    });
    expect(result.pagination).toEqual({
      limit: 200,
      offset: 0,
      count: submissions.length,
    });
    expect(result.appliedFilters).toEqual({
      statuses: ["APPROVED", "REJECTED"],
    });
  });

  it("accepts the full six-status lifecycle filter (spec Phase 2)", async () => {
    deps = createDeps({ submissions: [] });

    const result = await listEventApplicationSubmissions(
      { repos: deps.repos, logger: deps.logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        statuses: [
          "PENDING",
          "APPROVED",
          "REJECTED",
          "WITHDRAWN",
          "EXPIRED",
          "WAITLISTED",
        ],
      },
    );

    expect(deps.eventApplicationsRepo.listSubmissions).toHaveBeenCalledWith(
      expect.objectContaining({
        statuses: [
          "PENDING",
          "APPROVED",
          "REJECTED",
          "WITHDRAWN",
          "EXPIRED",
          "WAITLISTED",
        ],
      }),
    );
    expect(result.appliedFilters.statuses).toHaveLength(6);
  });

  it("throws when the actor cannot edit the event", async () => {
    deps = createDeps({ membership: null });

    await expect(
      listEventApplicationSubmissions(
        { repos: deps.repos, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });
});

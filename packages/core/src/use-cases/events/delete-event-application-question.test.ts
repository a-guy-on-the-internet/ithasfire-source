import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type {
  EventApplicationFormRecord,
  EventApplicationQuestionRecord,
  EventRecord,
  Repos,
  TxRepos,
} from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { deleteEventApplicationQuestion } from "./delete-event-application-question";

const EVENT_ID = "10000000-0000-4000-8000-000000000001";
const ORG_ID = "20000000-0000-4000-8000-000000000002";
const ACTOR_ID = "30000000-0000-4000-8000-000000000003";
const FORM_ID = "40000000-0000-4000-8000-000000000004";
const QUESTION_ID = "50000000-0000-4000-8000-000000000005";
const NOW = new Date("2025-12-03T12:00:00Z");

const baseEvent: EventRecord = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "Gate Application",
  status: "PUBLISHED",
  visibility: "PRIVATE",
  gateType: "APPLICATION",
  locationMode: "EXACT",
  locationRadiusMeters: null,
  locationLabel: null,
  addressRevealAt: null,
  addressRevealPreset: null,
  startsAt: new Date("2025-12-10T00:00:00Z"),
  endsAt: new Date("2025-12-10T03:00:00Z"),
  placeId: null,
  savedLocationId: null,
  categoryId: null,
  addressText: null,
  lat: null,
  lng: null,
  slug: "gate-app",
  shortId: "GATE",
  regionCode: "US-CA",
  publishedAt: new Date("2025-11-01T00:00:00Z"),
  agreementPrimaryId: "60000000-0000-4000-8000-000000000006",
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

const baseForm: EventApplicationFormRecord = {
  id: FORM_ID,
  eventId: EVENT_ID,
  introText: null,
  defaults: {
    includeName: true,
    includeReason: false,
    includeSocialLinks: false,
  },
  opensAt: null,
  closesAt: null,
  maxSubmissions: null,
  autoApprove: false,
  updatedByHumanId: ACTOR_ID,
  createdAt: new Date("2025-11-20T00:00:00Z"),
  updatedAt: NOW,
};

const baseQuestion: EventApplicationQuestionRecord = {
  id: QUESTION_ID,
  formId: FORM_ID,
  type: "SINGLE_CHOICE",
  label: "Have you attended before?",
  description: null,
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  isRequired: true,
  order: 1,
  createdAt: new Date("2025-11-21T00:00:00Z"),
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
    form?: Partial<EventApplicationFormRecord | null>;
    questions?: EventApplicationQuestionRecord[];
  } = {},
) {
  const eventValue =
    overrides.event === null
      ? null
      : { ...baseEvent, ...(overrides.event ?? {}) };
  const formValue =
    overrides.form === null ? null : { ...baseForm, ...(overrides.form ?? {}) };
  const questionsValue = overrides.questions ?? [baseQuestion];

  const eventsRepo = {
    getById: vi.fn().mockResolvedValue(eventValue),
  };
  const authzRepo = {
    getOrgMembership: vi.fn().mockResolvedValue(eventValue ? membership : null),
    getStaffRolesForHumanId: vi.fn(async () => []),
  };
  const eventApplicationsRepo = {
    getForm: vi.fn().mockResolvedValue(formValue),
    listQuestions: vi.fn().mockResolvedValue(questionsValue),
    deleteQuestion: vi.fn().mockResolvedValue(undefined),
  };
  const auditRepo = {
    log: vi.fn(),
  };

  const tx = {
    events: eventsRepo,
    authz: authzRepo,
    eventApplications: eventApplicationsRepo,
    audit: auditRepo,
  } as unknown as TxRepos;

  const repos = {
    tx: vi.fn(async (fn: (txRepos: TxRepos) => Promise<unknown>) => fn(tx)),
  } as unknown as Repos;

  const clock: ClockPort = {
    now: vi.fn(() => NOW),
  };

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
    clock,
    logger,
    info,
    eventApplicationsRepo,
    auditRepo,
  };
}

describe("deleteEventApplicationQuestion", () => {
  let deps: Deps;

  beforeEach(() => {
    deps = createDeps();
  });

  it("deletes the question and logs audit + metrics", async () => {
    const result = await deleteEventApplicationQuestion(
      { repos: deps.repos, clock: deps.clock, logger: deps.logger },
      {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        formId: FORM_ID,
        questionId: QUESTION_ID,
      },
    );

    expect(deps.eventApplicationsRepo.deleteQuestion).toHaveBeenCalledWith(
      QUESTION_ID,
    );
    expect(deps.auditRepo.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "event_application_question_deleted",
        data: expect.objectContaining({ questionId: QUESTION_ID }),
      }),
    );
    expect(deps.info).toHaveBeenCalledWith(
      "event_gate",
      expect.objectContaining({ action: "application_question_deleted" }),
    );
    expect(result).toEqual({
      eventId: EVENT_ID,
      formId: FORM_ID,
      questionId: QUESTION_ID,
    });
  });

  it("throws when the form does not exist", async () => {
    deps.eventApplicationsRepo.getForm.mockResolvedValueOnce(null);

    await expect(
      deleteEventApplicationQuestion(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          formId: FORM_ID,
          questionId: QUESTION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "FORM_NOT_FOUND" });
  });

  it("throws when the form id does not match", async () => {
    deps.eventApplicationsRepo.getForm.mockResolvedValueOnce({
      ...baseForm,
      id: "other",
    });

    await expect(
      deleteEventApplicationQuestion(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          formId: FORM_ID,
          questionId: QUESTION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "FORM_MISMATCH" });
  });

  it("throws when the question cannot be found", async () => {
    deps.eventApplicationsRepo.listQuestions.mockResolvedValueOnce([]);

    await expect(
      deleteEventApplicationQuestion(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          formId: FORM_ID,
          questionId: QUESTION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "QUESTION_NOT_FOUND" });
  });

  it("throws when the event is not application gated", async () => {
    deps = createDeps({ event: { gateType: "NONE" } });

    await expect(
      deleteEventApplicationQuestion(
        { repos: deps.repos, clock: deps.clock, logger: deps.logger },
        {
          actorHumanId: ACTOR_ID,
          eventId: EVENT_ID,
          formId: FORM_ID,
          questionId: QUESTION_ID,
        },
      ),
    ).rejects.toMatchObject({ code: "EVENT_NOT_APPLICATION_GATED" });
  });
});

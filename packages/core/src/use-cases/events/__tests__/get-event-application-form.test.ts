import { beforeEach, describe, expect, it, vi } from "vitest";

import type { LoggerPort } from "@th/ports/logger";
import type { EventRecord, Repos, TxRepos } from "@th/ports/repos";
import type { OrgMembership } from "@th/ports/repos/authz";

import { getEventApplicationForm } from "../get-event-application-form";

/**
 * The ORGANIZER read of an application form.
 *
 * This use case exists because the transport layer previously did this work
 * inline behind nothing but an "is someone signed in" check — so any
 * authenticated user could read any event's organizer-only form config
 * (`defaults`, `maxSubmissions`, `autoApprove`) by event id. These tests pin
 * the authorization, not just the projection.
 */

const EVENT_ID = "60000000-0000-4000-8000-000000000006";
const ORG_ID = "70000000-0000-4000-8000-000000000007";
const ACTOR_ID = "80000000-0000-4000-8000-000000000008";
const FORM_ID = "b0000000-0000-4000-8000-00000000000b";
const NOW = new Date("2026-08-11T15:00:00Z");

const baseEvent = {
  id: EVENT_ID,
  orgId: ORG_ID,
  humanId: null,
  title: "VIP Soiree",
  status: "PUBLISHED",
  visibility: "PRIVATE",
  gateType: "APPLICATION",
  stewardship: "OWNED",
} as unknown as EventRecord;

const membership: OrgMembership = {
  orgId: ORG_ID,
  humanId: ACTOR_ID,
  role: "ADMIN",
};

const baseForm = {
  id: FORM_ID,
  eventId: EVENT_ID,
  introText: "Tell us about your act",
  defaults: {
    includeName: true,
    includeReason: false,
    includeSocialLinks: false,
  },
  opensAt: null,
  closesAt: null,
  maxSubmissions: 50,
  autoApprove: false,
  updatedAt: NOW,
};

const baseQuestion = {
  id: "c0000000-0000-4000-8000-00000000000c",
  formId: FORM_ID,
  type: "SHORT_TEXT" as const,
  label: "Act name",
  description: null,
  options: null,
  isRequired: true,
  order: 0,
};

function createDeps(
  overrides: {
    event?: Partial<EventRecord> | null;
    membership?: OrgMembership | null;
    form?: typeof baseForm | null;
    questions?: (typeof baseQuestion)[];
  } = {},
) {
  const eventValue =
    overrides.event === null
      ? null
      : ({ ...baseEvent, ...(overrides.event ?? {}) } as EventRecord);
  const membershipValue =
    overrides.membership !== undefined ? overrides.membership : membership;
  const formValue = overrides.form === undefined ? baseForm : overrides.form;

  const eventApplicationsRepo = {
    getForm: vi.fn().mockResolvedValue(formValue),
    listQuestions: vi.fn().mockResolvedValue(overrides.questions ?? [baseQuestion]),
  };

  const tx = {
    events: { getById: vi.fn().mockResolvedValue(eventValue) },
    authz: {
      getOrgMembership: vi.fn().mockResolvedValue(membershipValue),
      getStaffRolesForHumanId: vi.fn(async () => []),
    },
    eventApplications: eventApplicationsRepo,
  } as unknown as TxRepos;

  const repos = {
    tx: vi.fn(async (fn: (txRepos: TxRepos) => Promise<unknown>) => fn(tx)),
  } as unknown as Repos;

  const logger = {
    child: vi.fn().mockReturnThis(),
    withTime: vi.fn(async (_name: string, fn: () => unknown) => fn()),
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as LoggerPort;

  return { repos, logger, eventApplicationsRepo };
}

describe("getEventApplicationForm", () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    deps = createDeps();
  });

  it("returns the organizer payload for an editor", async () => {
    const result = await getEventApplicationForm(deps, {
      eventId: EVENT_ID,
      actorHumanId: ACTOR_ID,
    });

    expect(result.form).toMatchObject({
      id: FORM_ID,
      maxSubmissions: 50,
      autoApprove: false,
    });
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]).toMatchObject({ label: "Act name" });
  });

  it("REJECTS a signed-in non-member before reading any form data", async () => {
    deps = createDeps({ membership: null });

    await expect(
      getEventApplicationForm(deps, {
        eventId: EVENT_ID,
        actorHumanId: ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

    // The organizer-only bag must never be fetched for an unauthorized actor.
    expect(deps.eventApplicationsRepo.getForm).not.toHaveBeenCalled();
    expect(deps.eventApplicationsRepo.listQuestions).not.toHaveBeenCalled();
  });

  it("REJECTS a VIEWER (read-only role is not edit access)", async () => {
    deps = createDeps({
      membership: { orgId: ORG_ID, humanId: ACTOR_ID, role: "VIEWER" },
    });

    await expect(
      getEventApplicationForm(deps, {
        eventId: EVENT_ID,
        actorHumanId: ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(deps.eventApplicationsRepo.getForm).not.toHaveBeenCalled();
  });

  it("rejects a missing event with EVENT_NOT_FOUND", async () => {
    deps = createDeps({ event: null });

    await expect(
      getEventApplicationForm(deps, {
        eventId: EVENT_ID,
        actorHumanId: ACTOR_ID,
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("returns an empty payload when the event has no form yet", async () => {
    deps = createDeps({ form: null });

    const result = await getEventApplicationForm(deps, {
      eventId: EVENT_ID,
      actorHumanId: ACTOR_ID,
    });

    expect(result).toEqual({ form: null, questions: [] });
    expect(deps.eventApplicationsRepo.listQuestions).not.toHaveBeenCalled();
  });

  it("rejects unknown input keys (strict schema)", async () => {
    await expect(
      getEventApplicationForm(deps, {
        eventId: EVENT_ID,
        actorHumanId: ACTOR_ID,
        sneaky: true,
      }),
    ).rejects.toBeTruthy();
  });
});

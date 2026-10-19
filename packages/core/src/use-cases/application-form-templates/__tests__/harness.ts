import { vi } from "vitest";

import { createFakeIdempotencyPort, createTestLogger } from "@th/test-utils";
import type { EventRecord, Repos, TxRepos } from "@th/ports/repos";
import type {
  ApplicationFormTemplateRecord,
  ApplicationTemplateQuestion,
} from "@th/types";

export const EVENT_ID = "11111111-1111-4111-8111-111111111111";
export const ORG_ID = "22222222-2222-4222-8222-222222222222";
export const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
export const TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";
export const OTHER_ORG_ID = "55555555-5555-4555-8555-555555555555";
export const OTHER_HUMAN_ID = "66666666-6666-4666-8666-666666666666";
export const FORM_ID = "77777777-7777-4777-8777-777777777777";
export const FIXED_NOW = new Date("2026-08-11T12:00:00.000Z");

export const BASE_QUESTIONS: ApplicationTemplateQuestion[] = [
  {
    type: "SHORT_TEXT",
    label: "Act name",
    description: null,
    options: null,
    isRequired: true,
  },
  {
    type: "SINGLE_CHOICE",
    label: "Proposed set length",
    description: null,
    options: [
      { id: "opt-1", label: "30 min" },
      { id: "opt-2", label: "45 min" },
    ],
    isRequired: false,
  },
];

export function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    orgId: ORG_ID,
    humanId: null,
    title: "Open call",
    status: "DRAFT",
    attendanceMode: "TICKETED",
    stewardship: "OWNED",
    visibility: "PUBLIC",
    gateType: "APPLICATION",
    locationMode: "EXACT",
    timezone: "America/Chicago",
    startsAt: new Date("2026-09-01T20:00:00.000Z"),
    endsAt: null,
    publishedAt: null,
    ...overrides,
  } as EventRecord;
}

export function makeTemplate(
  overrides: Partial<ApplicationFormTemplateRecord> = {},
): ApplicationFormTemplateRecord {
  const platform = overrides.isPlatform ?? false;
  return {
    id: TEMPLATE_ID,
    ownerScope: "ORGANIZATION",
    ownerId: platform ? null : ORG_ID,
    name: "Performer application",
    description: "For open calls",
    purpose: "ATTEND",
    introText: "Tell us about your act.",
    questions: BASE_QUESTIONS,
    isPlatform: platform,
    archivedAt: null,
    createdByHumanId: platform ? null : ACTOR_ID,
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
    updatedAt: new Date("2026-08-01T12:00:00.000Z"),
    ...overrides,
  };
}

export type HarnessOptions = {
  template?: ApplicationFormTemplateRecord | null;
  ownedTemplates?: ApplicationFormTemplateRecord[];
  platformTemplates?: ApplicationFormTemplateRecord[];
  /** Row returned by `findByName` (the create/rename collision pre-check). */
  nameCollision?: ApplicationFormTemplateRecord | null;
  event?: Partial<EventRecord> | null;
  /** Org role of ACTOR_ID in ORG_ID. `null` = no membership. */
  membershipRole?: string | null;
  /** What `countSubmissions` returns. */
  submissionCount?: number;
  /** Existing form on the event; `null` = none yet. */
  form?: {
    id: string;
    introText: string | null;
    opensAt?: Date | null;
    closesAt?: Date | null;
    maxSubmissions?: number | null;
    autoApprove?: boolean;
  } | null;
  /** Existing question rows on the form. */
  existingQuestions?: Array<{
    id: string;
    type: string;
    label: string;
    description: string | null;
    options: Array<{ id: string; label: string }> | null;
    isRequired: boolean;
    order: number;
  }>;
};

export function makeHarness(options: HarnessOptions = {}) {
  const template =
    options.template === undefined ? makeTemplate() : options.template;
  const eventExists = options.event !== null;
  const event = makeEvent(options.event ?? {});
  const membershipRole =
    options.membershipRole === undefined ? "ADMIN" : options.membershipRole;

  const storedForm =
    options.form === undefined
      ? { id: FORM_ID, introText: null }
      : options.form;

  let formRow = storedForm
    ? {
        id: storedForm.id,
        eventId: event.id,
        purpose: "ATTEND" as const,
        publicId: "attendform",
        introText: storedForm.introText,
        defaults: {
          includeName: true,
          includeReason: true,
          includeSocialLinks: false,
        },
        opensAt: storedForm.opensAt ?? null,
        closesAt: storedForm.closesAt ?? null,
        maxSubmissions: storedForm.maxSubmissions ?? null,
        autoApprove: storedForm.autoApprove ?? false,
        updatedByHumanId: null as string | null,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      }
    : null;

  const questionRows = [...(options.existingQuestions ?? [])].map((q) => ({
    ...q,
    formId: FORM_ID,
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  }));

  const applicationFormTemplates = {
    getById: vi.fn(async (id: string) =>
      template && id === template.id ? template : null,
    ),
    list: vi.fn(async () => options.ownedTemplates ?? []),
    listPlatformTemplates: vi.fn(async () => options.platformTemplates ?? []),
    findByName: vi.fn(async () => options.nameCollision ?? null),
    create: vi.fn(
      async (input: {
        ownerScope: string;
        ownerId: string;
        name: string;
        description: string | null;
        purpose: "ATTEND" | "PERFORM";
        introText: string | null;
        questions: ApplicationTemplateQuestion[];
        createdByHumanId: string;
        createdAt: Date;
      }) =>
        makeTemplate({
          id: "88888888-8888-4888-8888-888888888888",
          ownerScope: input.ownerScope as "ORGANIZATION" | "HUMAN",
          ownerId: input.ownerId,
          name: input.name,
          description: input.description,
          purpose: input.purpose,
          introText: input.introText,
          questions: input.questions,
          createdByHumanId: input.createdByHumanId,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        }),
    ),
    update: vi.fn(
      async (input: {
        templateId: string;
        name?: string;
        description?: string | null;
        introText?: string | null;
        questions?: ApplicationTemplateQuestion[];
        updatedAt: Date;
      }) =>
        makeTemplate({
          ...(template ?? {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.introText !== undefined
            ? { introText: input.introText }
            : {}),
          ...(input.questions !== undefined
            ? { questions: input.questions }
            : {}),
          updatedAt: input.updatedAt,
        }),
    ),
    archive: vi.fn(async (input: { templateId: string; archivedAt: Date }) =>
      makeTemplate({ archivedAt: input.archivedAt }),
    ),
  };

  let nextQuestionSeq = 0;
  const eventApplications = {
    // Purpose-aware: the harness event has only an ATTEND form, so a read
    // of any other purpose finds nothing (a caller that forgot ATTEND fails).
    getForm: vi.fn(async (_eventId: string, purpose: string) =>
      purpose === "ATTEND" ? formRow : null,
    ),
    upsertForm: vi.fn(
      async (input: {
        eventId: string;
        purpose: "ATTEND" | "PERFORM";
        introText?: string | null;
        updatedByHumanId: string;
      }) => {
        formRow = {
          id: formRow?.id ?? FORM_ID,
          eventId: input.eventId,
          purpose: "ATTEND" as const,
          publicId: formRow?.publicId ?? "attendform",
          introText:
            input.introText !== undefined
              ? input.introText
              : (formRow?.introText ?? null),
          defaults: formRow?.defaults ?? {
            includeName: true,
            includeReason: true,
            includeSocialLinks: false,
          },
          opensAt: formRow?.opensAt ?? null,
          closesAt: formRow?.closesAt ?? null,
          maxSubmissions: formRow?.maxSubmissions ?? null,
          autoApprove: formRow?.autoApprove ?? false,
          updatedByHumanId: input.updatedByHumanId,
          createdAt: formRow?.createdAt ?? FIXED_NOW,
          updatedAt: FIXED_NOW,
        };
        return formRow;
      },
    ),
    listQuestions: vi.fn(async () => questionRows),
    upsertQuestion: vi.fn(
      async (input: {
        formId: string;
        type: string;
        label: string;
        description: string | null;
        options: Array<{ id: string; label: string }> | null;
        isRequired: boolean;
        order: number;
      }) => {
        nextQuestionSeq += 1;
        return {
          id: `99999999-9999-4999-8999-99999999999${nextQuestionSeq}`,
          formId: input.formId,
          type: input.type,
          label: input.label,
          description: input.description,
          options: input.options,
          isRequired: input.isRequired,
          order: input.order,
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
        };
      },
    ),
    countSubmissions: vi.fn(async () => options.submissionCount ?? 0),
  };

  const authz = {
    getHumanDelegation: vi.fn(async () => null),
    getOrgMembership: vi.fn(
      async ({ orgId, humanId }: { orgId: string; humanId: string }) => {
        if (orgId !== ORG_ID) return null;
        if (humanId !== ACTOR_ID) return null;
        if (membershipRole === null) return null;
        return { orgId, humanId, role: membershipRole };
      },
    ),
  };

  const audit = { log: vi.fn(async () => {}) };

  const txRepos = {
    applicationFormTemplates,
    eventApplications,
    events: {
      getById: vi.fn(async (id: string) =>
        eventExists && id === event.id ? event : null,
      ),
    },
    authz,
    audit,
    organizations: {
      getById: vi.fn(async (id: string) =>
        id === ORG_ID || id === OTHER_ORG_ID
          ? { id, name: "Org", status: "ACTIVE" }
          : null,
      ),
    },
    humans: {
      getById: vi.fn(async (id: string) => ({ id, status: "ACTIVE" })),
    },
  } as unknown as TxRepos;

  const repos = {
    ...txRepos,
    tx: async <T>(fn: (tx: TxRepos) => Promise<T>) => fn(txRepos),
  } as unknown as Repos;

  const deps = {
    repos,
    idempotency: createFakeIdempotencyPort(),
    clock: { now: () => FIXED_NOW },
    logger: createTestLogger(),
  };

  return {
    deps,
    template,
    event,
    mocks: {
      applicationFormTemplates,
      eventApplications,
      audit,
      authz,
    },
  };
}

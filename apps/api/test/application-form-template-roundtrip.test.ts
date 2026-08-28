/**
 * End-to-end (in-memory) proof that the SEEDED starter catalogue and the
 * fork-on-use apply agree.
 *
 * The seed lives in apps/api and the use case lives in @th/core, so neither
 * package's own tests can cross that seam — and it is exactly the seam that
 * would fail silently in production: a catalogue template whose stored shape
 * `applyApplicationFormTemplate` refuses would be broken for every organizer
 * at once, with green tests on both sides.
 *
 * This drives the REAL use case over the REAL encoded catalogue rows and
 * asserts the question rows it would create.
 */

import { describe, expect, it, vi } from "vitest";

import { applyApplicationFormTemplate } from "@th/core/use-cases/application-form-templates/apply-application-form-template";

import {
  LAUNCH_APPLICATION_FORM_TEMPLATES,
  encodeApplicationFormTemplate,
} from "../src/scripts/seed/application-form-templates";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";
const FORM_ID = "77777777-7777-4777-8777-777777777777";
const NOW = new Date("2026-08-11T12:00:00.000Z");

type CreatedQuestion = {
  formId: string;
  type: string;
  label: string;
  description: string | null;
  options: Array<{ id: string; label: string }> | null;
  isRequired: boolean;
  order: number;
};

/**
 * A catalogue row exactly as `ensureApplicationFormTemplates` would write it:
 * `ownerId` NULL, `isPlatform` true, `questions` the encoded JSON.
 */
function catalogueRecord(index: number) {
  const encoded = encodeApplicationFormTemplate(
    LAUNCH_APPLICATION_FORM_TEMPLATES[index]!,
  );
  return {
    record: {
      id: TEMPLATE_ID,
      ownerScope: "ORGANIZATION" as const,
      ownerId: null,
      name: encoded.name,
      description: encoded.description,
      introText: encoded.introText,
      // Round-tripped through JSON the way jsonb storage would.
      questions: JSON.parse(JSON.stringify(encoded.questions)),
      isPlatform: true,
      archivedAt: null,
      createdByHumanId: null,
      createdAt: NOW,
      updatedAt: NOW,
    },
    encoded,
  };
}

function makeDeps(template: ReturnType<typeof catalogueRecord>["record"]) {
  const created: CreatedQuestion[] = [];
  let formIntro: string | null = null;
  let questionSeq = 0;

  const txRepos = {
    applicationFormTemplates: {
      getById: vi.fn(async (id: string) =>
        id === template.id ? template : null,
      ),
    },
    eventApplications: {
      countSubmissions: vi.fn(async () => 0),
      getForm: vi.fn(async () => null),
      upsertForm: vi.fn(async (input: { introText?: string | null }) => {
        if (input.introText !== undefined) formIntro = input.introText;
        return { id: FORM_ID, eventId: EVENT_ID, introText: formIntro };
      }),
      listQuestions: vi.fn(async () => []),
      upsertQuestion: vi.fn(async (input: CreatedQuestion) => {
        created.push(input);
        questionSeq += 1;
        return {
          ...input,
          id: `99999999-9999-4999-8999-9999999999${String(questionSeq).padStart(2, "0")}`,
          createdAt: NOW,
          updatedAt: NOW,
        };
      }),
    },
    events: {
      getById: vi.fn(async () => ({
        id: EVENT_ID,
        orgId: ORG_ID,
        humanId: null,
        stewardship: "OWNED",
        gateType: "APPLICATION",
        attendanceMode: "TICKETED",
        status: "DRAFT",
      })),
    },
    authz: {
      getOrgMembership: vi.fn(async () => ({
        orgId: ORG_ID,
        humanId: ACTOR_ID,
        role: "ADMIN",
      })),
    },
    audit: { log: vi.fn(async () => {}) },
    organizations: { getById: vi.fn(async () => ({ id: ORG_ID })) },
    humans: { getById: vi.fn(async () => ({ id: ACTOR_ID })) },
  };

  const store = new Map<string, unknown>();
  const claimed = new Set<string>();

  return {
    created,
    getIntro: () => formIntro,
    deps: {
      repos: {
        ...txRepos,
        tx: async <T>(fn: (tx: unknown) => Promise<T>) => fn(txRepos),
      },
      idempotency: {
        begin: async (key: string) => {
          if (claimed.has(key)) return false;
          claimed.add(key);
          return true;
        },
        get: async (key: string) => store.get(key) ?? null,
        commit: async (key: string, value: unknown) => {
          store.set(key, value);
        },
        fail: async () => {},
        run: async () => {
          throw new Error("unused");
        },
        purgeExpired: async () => 0,
      },
      clock: { now: () => NOW },
    } as never,
  };
}

describe("seeded catalogue → fork-on-use apply", () => {
  it.each(
    LAUNCH_APPLICATION_FORM_TEMPLATES.map((template, index) => [
      template.name,
      index,
    ]),
  )(
    "%s applies cleanly and creates one row per question, in order",
    async (_name, index) => {
      const { record, encoded } = catalogueRecord(index as number);
      const { deps, created, getIntro } = makeDeps(record);

      const result = await applyApplicationFormTemplate(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        templateId: TEMPLATE_ID,
        clientKey: `roundtrip-${index}`,
      });

      expect(result.created).toEqual(encoded.questions.map((q) => q.label));
      expect(result.createdQuestionIds).toHaveLength(encoded.questions.length);

      // Rows land in template order, starting at 0 on an empty form.
      expect(created.map((q) => q.order)).toEqual(
        encoded.questions.map((_, i) => i),
      );

      // Every field survives the copy unchanged — including the canonical
      // option pairs, which is what the consumer gate renders from.
      expect(
        created.map((q) => ({
          type: q.type,
          label: q.label,
          description: q.description,
          options: q.options,
          isRequired: q.isRequired,
        })),
      ).toEqual(
        encoded.questions.map((q) => ({
          type: q.type,
          label: q.label,
          description: q.description,
          options: q.options,
          isRequired: q.isRequired,
        })),
      );

      // The intro travels only when the template has one.
      expect(getIntro()).toBe(encoded.introText);
    },
  );

  it("never produces a choice question without options (the Phase-1 dead-end)", async () => {
    for (const [index] of LAUNCH_APPLICATION_FORM_TEMPLATES.entries()) {
      const { record } = catalogueRecord(index);
      const { deps, created } = makeDeps(record);
      await applyApplicationFormTemplate(deps, {
        actorHumanId: ACTOR_ID,
        eventId: EVENT_ID,
        templateId: TEMPLATE_ID,
        clientKey: `dead-end-${index}`,
      });
      for (const question of created) {
        if (
          question.type === "SINGLE_CHOICE" ||
          question.type === "MULTI_CHOICE"
        ) {
          expect(question.options?.length ?? 0).toBeGreaterThan(0);
        } else {
          expect(question.options).toBeNull();
        }
      }
    }
  });
});

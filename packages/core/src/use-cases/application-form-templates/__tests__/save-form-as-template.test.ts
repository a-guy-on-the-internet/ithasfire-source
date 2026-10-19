import { describe, expect, it } from "vitest";

import { saveFormAsApplicationTemplate } from "../save-form-as-template";
import {
  ACTOR_ID,
  EVENT_ID,
  FORM_ID,
  ORG_ID,
  OTHER_ORG_ID,
  makeHarness,
  makeTemplate,
} from "./harness";

function input(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    ownerScope: "ORGANIZATION" as const,
    ownerId: ORG_ID,
    name: "Our open call",
    clientKey: "save-form-as-template-key",
    ...overrides,
  };
}

const FORM_QUESTIONS = [
  {
    id: "q-1",
    type: "SHORT_TEXT",
    label: "Act name",
    description: "As you want it billed",
    options: null,
    isRequired: true,
    order: 0,
  },
  {
    id: "q-2",
    type: "MULTI_CHOICE",
    label: "Booth needs",
    description: null,
    options: [
      { id: "opt-1", label: "Table" },
      { id: "opt-2", label: "Power" },
    ],
    isRequired: false,
    order: 1,
  },
];

describe("saveFormAsApplicationTemplate — snapshot up", () => {
  it("snapshots the form's intro and every question with full fidelity", async () => {
    const harness = makeHarness({
      form: { id: FORM_ID, introText: "Tell us about your act." },
      existingQuestions: FORM_QUESTIONS,
    });

    const result = await saveFormAsApplicationTemplate(harness.deps, input());

    expect(result.questionCount).toBe(2);
    expect(result.name).toBe("Our open call");

    const created =
      harness.mocks.applicationFormTemplates.create.mock.calls[0]![0];
    expect(created.introText).toBe("Tell us about your act.");
    expect(created.questions).toEqual([
      {
        type: "SHORT_TEXT",
        label: "Act name",
        description: "As you want it billed",
        options: null,
        isRequired: true,
      },
      {
        type: "MULTI_CHOICE",
        label: "Booth needs",
        description: null,
        options: [
          { id: "opt-1", label: "Table" },
          { id: "opt-2", label: "Power" },
        ],
        isRequired: false,
      },
    ]);
  });

  it("stores questions in ORDER, not in whatever order the repo returned them", async () => {
    const harness = makeHarness({
      existingQuestions: [
        { ...FORM_QUESTIONS[1]!, order: 0 },
        { ...FORM_QUESTIONS[0]!, order: 1 },
      ],
    });

    await saveFormAsApplicationTemplate(harness.deps, input());

    const created =
      harness.mocks.applicationFormTemplates.create.mock.calls[0]![0];
    expect(created.questions.map((q) => q.label)).toEqual([
      "Booth needs",
      "Act name",
    ]);
  });

  it("does NOT capture lifecycle fields — a stale window must not ride along", async () => {
    const harness = makeHarness({
      form: {
        id: FORM_ID,
        introText: null,
        opensAt: new Date("2026-09-01T00:00:00Z"),
        closesAt: new Date("2026-09-08T00:00:00Z"),
        maxSubmissions: 40,
        autoApprove: true,
      },
      existingQuestions: FORM_QUESTIONS,
    });

    await saveFormAsApplicationTemplate(harness.deps, input());

    const created =
      harness.mocks.applicationFormTemplates.create.mock.calls[0]![0];
    expect(Object.keys(created).sort()).toEqual(
      [
        "createdAt",
        "createdByHumanId",
        "description",
        "introText",
        "name",
        "ownerId",
        "ownerScope",
        "purpose",
        "questions",
      ].sort(),
    );
  });

  it("normalizes a legacy option shape into the canonical pair", async () => {
    const harness = makeHarness({
      existingQuestions: [
        {
          id: "q-3",
          type: "SINGLE_CHOICE",
          label: "Set length",
          description: null,
          options: ["30 min", "45 min"] as never,
          isRequired: false,
          order: 0,
        },
      ],
    });

    await saveFormAsApplicationTemplate(harness.deps, input());

    const created =
      harness.mocks.applicationFormTemplates.create.mock.calls[0]![0];
    expect(created.questions[0]!.options).toEqual([
      { id: "opt-1", label: "30 min" },
      { id: "opt-2", label: "45 min" },
    ]);
  });

  it("refuses a form whose choice question has lost its options (a template apply would reject)", async () => {
    const harness = makeHarness({
      existingQuestions: [
        {
          id: "q-4",
          type: "SINGLE_CHOICE",
          label: "Set length",
          description: null,
          options: [],
          isRequired: false,
          order: 0,
        },
      ],
    });

    await expect(
      saveFormAsApplicationTemplate(harness.deps, input()),
      // `parseInput`'s zod rejection, i.e. the SAME refusal a hand-authored
      // template with an option-less choice question gets.
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(
      harness.mocks.applicationFormTemplates.create,
    ).not.toHaveBeenCalled();
  });

  it("saves an empty (intro-only) form rather than failing on work-in-progress", async () => {
    const harness = makeHarness({
      form: { id: FORM_ID, introText: "Just an intro" },
      existingQuestions: [],
    });

    const result = await saveFormAsApplicationTemplate(harness.deps, input());

    expect(result.questionCount).toBe(0);
  });

  it("refuses when the event has no application form at all", async () => {
    const harness = makeHarness({ form: null });

    await expect(
      saveFormAsApplicationTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "FORM_NOT_FOUND" });
  });

  it("refuses a name already used in the destination library", async () => {
    const harness = makeHarness({
      existingQuestions: FORM_QUESTIONS,
      nameCollision: makeTemplate({ name: "Our open call" }),
    });

    await expect(
      saveFormAsApplicationTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NAME_TAKEN" });
  });

  it("refuses an actor who cannot edit the SOURCE event", async () => {
    const harness = makeHarness({ membershipRole: null });

    await expect(
      saveFormAsApplicationTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(
      harness.mocks.applicationFormTemplates.create,
    ).not.toHaveBeenCalled();
  });

  it("refuses an org EDITOR writing into a DIFFERENT org's library", async () => {
    // The event check passes (EDITOR of ORG_ID) — only the destination check
    // stops this, which is exactly why both run.
    const harness = makeHarness({
      membershipRole: "EDITOR",
      existingQuestions: FORM_QUESTIONS,
    });

    await expect(
      saveFormAsApplicationTemplate(
        harness.deps,
        input({ ownerId: OTHER_ORG_ID }),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("refuses writing into another HUMAN's library", async () => {
    const harness = makeHarness({ existingQuestions: FORM_QUESTIONS });

    await expect(
      saveFormAsApplicationTemplate(
        harness.deps,
        input({
          ownerScope: "HUMAN",
          ownerId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        }),
      ),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("audits the snapshot with its source event", async () => {
    const harness = makeHarness({ existingQuestions: FORM_QUESTIONS });

    await saveFormAsApplicationTemplate(harness.deps, input());

    expect(harness.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "application_form_template",
        action: "saved_from_event",
        data: expect.objectContaining({
          sourceEventId: EVENT_ID,
          sourceFormId: FORM_ID,
          questionCount: 2,
        }),
      }),
    );
  });

  it("replays a repeated clientKey instead of creating a second template", async () => {
    const harness = makeHarness({ existingQuestions: FORM_QUESTIONS });

    const first = await saveFormAsApplicationTemplate(harness.deps, input());
    const second = await saveFormAsApplicationTemplate(harness.deps, input());

    expect(second).toEqual(first);
    expect(
      harness.mocks.applicationFormTemplates.create,
    ).toHaveBeenCalledTimes(1);
  });
});

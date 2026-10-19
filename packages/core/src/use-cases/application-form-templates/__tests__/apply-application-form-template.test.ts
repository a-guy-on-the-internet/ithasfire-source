import { describe, expect, it } from "vitest";

import { applyApplicationFormTemplate } from "../apply-application-form-template";
import {
  ACTOR_ID,
  EVENT_ID,
  FORM_ID,
  ORG_ID,
  TEMPLATE_ID,
  makeHarness,
  makeTemplate,
} from "./harness";

function input(overrides: Record<string, unknown> = {}) {
  return {
    actorHumanId: ACTOR_ID,
    eventId: EVENT_ID,
    templateId: TEMPLATE_ID,
    clientKey: "apply-form-template-key",
    ...overrides,
  };
}

describe("applyApplicationFormTemplate — fork-on-use", () => {
  it("creates question ROWS matching the template's questions, in order", async () => {
    const harness = makeHarness();

    const result = await applyApplicationFormTemplate(harness.deps, input());

    expect(result.created).toEqual(["Act name", "Proposed set length"]);
    expect(result.createdQuestionIds).toHaveLength(2);
    expect(result.formId).toBe(FORM_ID);

    const calls =
      harness.mocks.eventApplications.upsertQuestion.mock.calls.map(
        ([arg]) => arg,
      );
    expect(calls).toEqual([
      {
        formId: FORM_ID,
        type: "SHORT_TEXT",
        label: "Act name",
        description: null,
        options: null,
        isRequired: true,
        order: 0,
      },
      {
        formId: FORM_ID,
        type: "SINGLE_CHOICE",
        label: "Proposed set length",
        description: null,
        options: [
          { id: "opt-1", label: "30 min" },
          { id: "opt-2", label: "45 min" },
        ],
        isRequired: false,
        order: 1,
      },
    ]);
    // No `questionId` on any call — these are CREATES, never updates of an
    // existing row.
    for (const call of calls) {
      expect(call).not.toHaveProperty("questionId");
    }
  });

  it("copies the template's introText onto the event's form", async () => {
    const harness = makeHarness();

    await applyApplicationFormTemplate(harness.deps, input());

    expect(harness.mocks.eventApplications.upsertForm).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      purpose: "ATTEND",
      updatedByHumanId: ACTOR_ID,
      introText: "Tell us about your act.",
    });
  });

  it("still applies a PERFORM template onto the ATTEND form (open calls step 2 is behaviour-neutral)", async () => {
    // The seeded performer template is PERFORM now, but organizers keep
    // using it from the attendee builder until step 11 gives open calls
    // their own picker. Its questions are copied exactly as before.
    const harness = makeHarness({
      template: makeTemplate({ purpose: "PERFORM" }),
    });

    const result = await applyApplicationFormTemplate(harness.deps, input());

    expect(result.created).toHaveLength(2);
    expect(harness.mocks.eventApplications.upsertForm).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: EVENT_ID, purpose: "ATTEND" }),
    );
  });

  it("omits introText entirely when the template has none, so an organizer's intro survives", async () => {
    const harness = makeHarness({
      template: makeTemplate({ introText: null }),
      form: { id: FORM_ID, introText: "Our own intro" },
    });

    await applyApplicationFormTemplate(harness.deps, input());

    const payload =
      harness.mocks.eventApplications.upsertForm.mock.calls[0]![0];
    // ABSENT, not null: upsertForm's presence semantics mean an absent key
    // leaves the stored value alone, while null would CLEAR it.
    expect(Object.keys(payload)).not.toContain("introText");
  });

  it("APPENDS after existing questions instead of replacing them", async () => {
    const harness = makeHarness({
      existingQuestions: [
        {
          id: "existing-1",
          type: "SHORT_TEXT",
          label: "Your name",
          description: null,
          options: null,
          isRequired: true,
          order: 0,
        },
        {
          id: "existing-2",
          type: "LONG_TEXT",
          label: "Why?",
          description: null,
          options: null,
          isRequired: false,
          order: 3,
        },
      ],
    });

    await applyApplicationFormTemplate(harness.deps, input());

    const orders =
      harness.mocks.eventApplications.upsertQuestion.mock.calls.map(
        ([arg]) => arg.order,
      );
    // Starts after the highest existing order (3), never at 0.
    expect(orders).toEqual([4, 5]);
    // Nothing existing was deleted or overwritten.
    expect(
      harness.mocks.eventApplications.upsertQuestion,
    ).toHaveBeenCalledTimes(2);
  });

  it("REFUSES when the event already has submissions", async () => {
    const harness = makeHarness({ submissionCount: 1 });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "APPLICATION_SUBMISSIONS_EXIST" });

    expect(harness.mocks.eventApplications.upsertForm).not.toHaveBeenCalled();
    expect(
      harness.mocks.eventApplications.upsertQuestion,
    ).not.toHaveBeenCalled();
  });

  it("blocks on MID-FLIGHT statuses only — PENDING and WAITLISTED", async () => {
    const harness = makeHarness();

    await applyApplicationFormTemplate(harness.deps, input());

    // Decided (APPROVED/REJECTED) and closed-out (WITHDRAWN/EXPIRED)
    // submissions must NOT block: apply is append-only and every submission
    // renders from its own D3 `questionsSnapshot`. Blocking on them would
    // permanently bar an event that ran one decided open call from ever
    // using a template again — a harsher rule than the one guarding
    // upsertEventApplicationQuestion, which can delete a live question.
    expect(
      harness.mocks.eventApplications.countSubmissions,
    ).toHaveBeenCalledWith({
      eventId: EVENT_ID,
      purpose: "ATTEND",
      statuses: ["PENDING", "WAITLISTED"],
    });
    const statuses = harness.mocks.eventApplications.countSubmissions.mock
      .calls[0]![0].statuses as string[];
    for (const decided of ["APPROVED", "REJECTED", "WITHDRAWN", "EXPIRED"]) {
      expect(statuses).not.toContain(decided);
    }
  });

  it("applies onto an event whose only submissions are already decided", async () => {
    // The round-two case: twelve applicants, all reviewed, organizer reopens.
    // `countSubmissions` is filtered to the mid-flight set, so it reports 0.
    const harness = makeHarness({ submissionCount: 0 });

    const result = await applyApplicationFormTemplate(harness.deps, input());

    expect(result.created).toHaveLength(2);
  });

  it("applies a PLATFORM catalogue template for any authorized event editor", async () => {
    const harness = makeHarness({
      template: makeTemplate({
        isPlatform: true,
        ownerId: null,
        createdByHumanId: null,
      }),
    });

    const result = await applyApplicationFormTemplate(harness.deps, input());

    expect(result.created).toHaveLength(2);
  });

  it("refuses a MIS-SHAPED platform row (flag set WITH an ownerId) — fails closed", async () => {
    const harness = makeHarness({
      template: makeTemplate({ isPlatform: true, ownerId: ORG_ID }),
    });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("refuses a mis-shaped row with a null ownerId but no platform flag", async () => {
    const harness = makeHarness({
      template: makeTemplate({ isPlatform: false, ownerId: null }),
    });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("refuses an owned template belonging to another org", async () => {
    const harness = makeHarness({
      template: makeTemplate({
        ownerId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      }),
    });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "ORGANIZATION_NOT_FOUND" });
    expect(
      harness.mocks.eventApplications.upsertQuestion,
    ).not.toHaveBeenCalled();
  });

  it("refuses an archived template", async () => {
    const harness = makeHarness({
      template: makeTemplate({ archivedAt: new Date("2026-08-05T00:00:00Z") }),
    });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "TEMPLATE_ARCHIVED" });
  });

  it("refuses a missing template", async () => {
    const harness = makeHarness({ template: null });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
  });

  it("refuses an actor who cannot edit the event, even for a platform template", async () => {
    const harness = makeHarness({
      template: makeTemplate({
        isPlatform: true,
        ownerId: null,
        createdByHumanId: null,
      }),
      membershipRole: null,
    });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("refuses an org VIEWER (read access is not edit access)", async () => {
    const harness = makeHarness({ membershipRole: "VIEWER" });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("refuses an event that is not APPLICATION-gated", async () => {
    const harness = makeHarness({ event: { gateType: "NONE" } });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "EVENT_NOT_APPLICATION_GATED" });
  });

  it("refuses a COMMUNITY (ownerless) listing", async () => {
    const harness = makeHarness({ event: { stewardship: "COMMUNITY" } });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("refuses a legacy choice question whose options were lost", async () => {
    const harness = makeHarness({
      template: makeTemplate({
        questions: [
          {
            type: "SINGLE_CHOICE",
            label: "Set length",
            description: null,
            options: [],
            isRequired: false,
          },
        ],
      }),
    });

    await expect(
      applyApplicationFormTemplate(harness.deps, input()),
    ).rejects.toMatchObject({ code: "OPTIONS_REQUIRED" });
  });

  it("normalizes a legacy option shape before forking it into a row", async () => {
    const harness = makeHarness({
      template: makeTemplate({
        questions: [
          {
            type: "MULTI_CHOICE",
            label: "Booth needs",
            description: null,
            options: ["Table", "Power"] as never,
            isRequired: false,
          },
        ],
      }),
    });

    await applyApplicationFormTemplate(harness.deps, input());

    expect(
      harness.mocks.eventApplications.upsertQuestion.mock.calls[0]![0].options,
    ).toEqual([
      { id: "opt-1", label: "Table" },
      { id: "opt-2", label: "Power" },
    ]);
  });

  it("audits the apply against the event", async () => {
    const harness = makeHarness();

    await applyApplicationFormTemplate(harness.deps, input());

    expect(harness.mocks.audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "event",
        entityId: EVENT_ID,
        action: "application_form_template_applied",
        data: expect.objectContaining({
          templateId: TEMPLATE_ID,
          formId: FORM_ID,
          actorHumanId: ACTOR_ID,
        }),
      }),
    );
  });

  it("replays the same result for a repeated clientKey without re-creating rows", async () => {
    const harness = makeHarness();

    const first = await applyApplicationFormTemplate(harness.deps, input());
    const second = await applyApplicationFormTemplate(harness.deps, input());

    expect(second).toEqual(first);
    expect(
      harness.mocks.eventApplications.upsertQuestion,
    ).toHaveBeenCalledTimes(2);
  });

  it("rejects a reused clientKey carrying a different payload", async () => {
    const harness = makeHarness();

    await applyApplicationFormTemplate(harness.deps, input());

    await expect(
      applyApplicationFormTemplate(
        harness.deps,
        input({ templateId: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_CONFLICT" });
  });
});

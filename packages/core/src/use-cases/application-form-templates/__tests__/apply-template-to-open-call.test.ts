/**
 * Open calls v1, step 3 — an open call can start from a PERFORM template
 * (FR-001). The attendee apply (ATTEND form) is covered, unchanged, by
 * apply-application-form-template.test.ts.
 */
import { describe, expect, it } from "vitest";

import type { ClockPort } from "@th/ports/clock";
import type { ApplicationFormTemplateRecord } from "@th/types";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";
import {
  OC_EDITOR_ID,
  OC_EVENT_ID,
  OC_SERIES_ID,
  OC_STRANGER_ID,
  createOpenCallWorld,
} from "@th/test-utils/fakes/open-calls";

import { applyApplicationFormTemplateToOpenCall } from "../apply-application-form-template";

const TEMPLATE_ID = "90000000-0000-4000-8000-000000000001";

const template = (
  overrides: Partial<ApplicationFormTemplateRecord> = {},
): ApplicationFormTemplateRecord => ({
  id: TEMPLATE_ID,
  ownerScope: "ORGANIZATION",
  ownerId: null,
  name: "Performer / artist application",
  description: null,
  purpose: "PERFORM",
  introText: "Tell us about your act",
  questions: [
    { type: "SHORT_TEXT", label: "Act name", isRequired: true },
    {
      type: "SINGLE_CHOICE",
      label: "Set length",
      isRequired: false,
      options: [
        { id: "a", label: "20 min" },
        { id: "b", label: "40 min" },
      ],
    },
  ],
  isPlatform: true,
  archivedAt: null,
  createdByHumanId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...overrides,
});

function setup(t: ApplicationFormTemplateRecord = template()) {
  const world = createOpenCallWorld();
  (world.repos as unknown as Record<string, unknown>).applicationFormTemplates = {
    getById: async (id: string) => (id === t.id ? t : null),
  };
  const idempotency = createFakeIdempotencyPort();
  const deps = {
    repos: world.repos,
    clock: world.clock as unknown as ClockPort,
    idempotency,
  };
  return { world, deps, idempotency };
}

describe("applyApplicationFormTemplateToOpenCall", () => {
  it("forks a PERFORM template onto an event call", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });

    const out = await applyApplicationFormTemplateToOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      formId: call.id,
      templateId: TEMPLATE_ID,
      clientKey: "client-key-1",
    });

    expect(out.formId).toBe(call.id);
    expect(out.created).toEqual(["Act name", "Set length"]);
    expect(world.questions.filter((q) => q.formId === call.id)).toHaveLength(2);
    expect(call.introText).toBe("Tell us about your act");
    // Pay is untouched by a template.
    expect(call.payKind).toBe("UNPAID");
  });

  it("works on a series call under series edit rights", async () => {
    const { world, deps } = setup();
    world.addSeries();
    const call = world.addForm({ purpose: "PERFORM", seriesId: OC_SERIES_ID });
    await expect(
      applyApplicationFormTemplateToOpenCall(deps, {
        actorHumanId: OC_STRANGER_ID,
        formId: call.id,
        templateId: TEMPLATE_ID,
        clientKey: "client-key-2",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    const out = await applyApplicationFormTemplateToOpenCall(deps, {
      actorHumanId: OC_EDITOR_ID,
      formId: call.id,
      templateId: TEMPLATE_ID,
      clientKey: "client-key-3",
    });
    expect(out.createdQuestionIds).toHaveLength(2);
  });

  it("an ATTEND template never crosses over", async () => {
    const { world, deps } = setup(template({ purpose: "ATTEND" }));
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    await expect(
      applyApplicationFormTemplateToOpenCall(deps, {
        actorHumanId: OC_EDITOR_ID,
        formId: call.id,
        templateId: TEMPLATE_ID,
        clientKey: "client-key-4",
      }),
    ).rejects.toMatchObject({ code: "TEMPLATE_NOT_FOUND" });
    expect(world.questions).toHaveLength(0);
  });

  it("the call must exist; an ATTEND form id is not a call", async () => {
    const { world, deps } = setup();
    world.addEvent({ gateType: "APPLICATION" });
    const attend = world.addForm({ purpose: "ATTEND", eventId: OC_EVENT_ID });
    await expect(
      applyApplicationFormTemplateToOpenCall(deps, {
        actorHumanId: OC_EDITOR_ID,
        formId: attend.id,
        templateId: TEMPLATE_ID,
        clientKey: "client-key-5",
      }),
    ).rejects.toMatchObject({ code: "OPEN_CALL_NOT_FOUND" });
  });

  it("refuses while an application is pending, and fails the idempotency key", async () => {
    const { world, deps, idempotency } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    world.addSubmission(call.id, "PENDING");
    await expect(
      applyApplicationFormTemplateToOpenCall(deps, {
        actorHumanId: OC_EDITOR_ID,
        formId: call.id,
        templateId: TEMPLATE_ID,
        clientKey: "client-key-6",
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_SUBMISSIONS_EXIST" });
    expect(idempotency.__mocks.fail).toHaveBeenCalledTimes(1);
    expect(world.questions).toHaveLength(0);
  });

  it("replays the same clientKey without forking twice", async () => {
    const { world, deps } = setup();
    world.addEvent();
    const call = world.addForm({ purpose: "PERFORM", eventId: OC_EVENT_ID });
    const input = {
      actorHumanId: OC_EDITOR_ID,
      formId: call.id,
      templateId: TEMPLATE_ID,
      clientKey: "client-key-7",
    };
    const first = await applyApplicationFormTemplateToOpenCall(deps, input);
    const second = await applyApplicationFormTemplateToOpenCall(deps, input);
    expect(second).toEqual(first);
    expect(world.questions).toHaveLength(2);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { EventRecord, Repos } from "@th/ports/repos";

import { getPublicEventApplicationForm } from "../get-public-event-application-form";

const EVENT_ID = "50000000-0000-4000-8000-000000000005";
const FORM_ID = "b0000000-0000-4000-8000-00000000000b";
const QUESTION_ID = "c0000000-0000-4000-8000-00000000000c";
const NOW = new Date("2025-12-03T12:00:00Z");

const buildEvent = (overrides: Partial<EventRecord> = {}): EventRecord =>
  ({
    id: EVENT_ID,
    orgId: "60000000-0000-4000-8000-000000000006",
    humanId: null,
    title: "Gated Event",
    status: "PUBLISHED",
    visibility: "PUBLIC",
    gateType: "APPLICATION",
    slug: "gated-event",
    ...overrides,
  }) as unknown as EventRecord;

/**
 * The FULL organizer-facing form record. Every field the public projection is
 * supposed to drop is present here on purpose — the exact-shape assertions
 * below are what stop a future `...form` spread from re-leaking them.
 */
const buildForm = (overrides: Record<string, unknown> = {}) => ({
  id: FORM_ID,
  eventId: EVENT_ID,
  introText: "Tell us about your act.",
  defaults: {
    includeName: true,
    includeReason: true,
    includeSocialLinks: true,
  },
  opensAt: new Date("2025-12-01T00:00:00Z"),
  closesAt: new Date("2025-12-09T00:00:00Z"),
  maxSubmissions: 25,
  autoApprove: true,
  updatedByHumanId: "70000000-0000-4000-8000-000000000007",
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const buildQuestion = (overrides: Record<string, unknown> = {}) => ({
  id: QUESTION_ID,
  formId: FORM_ID,
  type: "SHORT_TEXT",
  label: "Act name",
  description: "As it should appear on the poster",
  options: null,
  isRequired: true,
  order: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

const createDeps = () => {
  const events = { getById: vi.fn() };
  const eventApplications = {
    getForm: vi.fn(),
    listQuestions: vi.fn().mockResolvedValue([]),
  };

  const repos = { events, eventApplications } as unknown as Pick<
    Repos,
    "events" | "eventApplications"
  >;

  return { repos, events, eventApplications };
};

describe("getPublicEventApplicationForm", () => {
  let deps: ReturnType<typeof createDeps>;

  beforeEach(() => {
    deps = createDeps();
  });

  const call = () =>
    getPublicEventApplicationForm({ repos: deps.repos }, { eventId: EVENT_ID });

  it("returns the form definition for a PUBLISHED, APPLICATION-gated event", async () => {
    deps.events.getById.mockResolvedValue(buildEvent());
    deps.eventApplications.getForm.mockResolvedValue(buildForm());
    deps.eventApplications.listQuestions.mockResolvedValue([
      buildQuestion(),
      buildQuestion({
        id: "c0000000-0000-4000-8000-00000000000d",
        type: "SINGLE_CHOICE",
        label: "Set length",
        description: null,
        options: [{ id: "30", label: "30 min" }],
        isRequired: false,
        order: 1,
      }),
    ]);

    const result = await call();

    // EXACT shape — not `toMatchObject`. This is the leak assertion: any new
    // key on the output (or a spread of the form record) fails here.
    expect(result).toEqual({
      eventId: EVENT_ID,
      introText: "Tell us about your act.",
      opensAt: new Date("2025-12-01T00:00:00Z"),
      closesAt: new Date("2025-12-09T00:00:00Z"),
      questions: [
        {
          id: QUESTION_ID,
          type: "SHORT_TEXT",
          label: "Act name",
          description: "As it should appear on the poster",
          options: null,
          isRequired: true,
          order: 0,
        },
        {
          id: "c0000000-0000-4000-8000-00000000000d",
          type: "SINGLE_CHOICE",
          label: "Set length",
          description: null,
          options: [{ id: "30", label: "30 min" }],
          isRequired: false,
          order: 1,
        },
      ],
    });
  });

  it("leaks NO organizer-only field (defaults / maxSubmissions / autoApprove / provenance)", async () => {
    deps.events.getById.mockResolvedValue(buildEvent());
    deps.eventApplications.getForm.mockResolvedValue(buildForm());
    deps.eventApplications.listQuestions.mockResolvedValue([buildQuestion()]);

    const result = (await call()) as Record<string, unknown>;

    for (const organizerOnly of [
      "id",
      "defaults",
      "maxSubmissions",
      "autoApprove",
      "updatedByHumanId",
      "createdAt",
      "updatedAt",
    ]) {
      expect(result).not.toHaveProperty(organizerOnly);
    }
    // Questions carry no form id / timestamps either — only what the gate
    // needs to render and what `submitApplication` keys answers on.
    expect(Object.keys(result.questions as object[])).toHaveLength(1);
    for (const organizerOnly of ["formId", "createdAt", "updatedAt"]) {
      expect((result.questions as Record<string, unknown>[])[0]).not.toHaveProperty(
        organizerOnly,
      );
    }
  });

  it.each(["DRAFT", "CANCELLED", "COMPLETED", "ARCHIVED"] as const)(
    "collapses a %s event to EVENT_NOT_FOUND",
    async (status) => {
      deps.events.getById.mockResolvedValue(buildEvent({ status }));
      deps.eventApplications.getForm.mockResolvedValue(buildForm());

      await expect(call()).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
      // Never even reads the form for an ineligible event.
      expect(deps.eventApplications.getForm).not.toHaveBeenCalled();
    },
  );

  it.each(["NONE", "PASSWORD"] as const)(
    "collapses a %s-gated event to EVENT_NOT_FOUND",
    async (gateType) => {
      deps.events.getById.mockResolvedValue(buildEvent({ gateType }));
      deps.eventApplications.getForm.mockResolvedValue(buildForm());

      await expect(call()).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
      expect(deps.eventApplications.getForm).not.toHaveBeenCalled();
    },
  );

  it("collapses a missing event to EVENT_NOT_FOUND", async () => {
    deps.events.getById.mockResolvedValue(null);

    await expect(call()).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("collapses an eligible event with NO form to the SAME EVENT_NOT_FOUND (not an oracle)", async () => {
    deps.events.getById.mockResolvedValue(buildEvent());
    deps.eventApplications.getForm.mockResolvedValue(null);

    await expect(call()).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("serves a PRIVATE application-gated event — visibility is deliberately not a gate here", async () => {
    // The organizer hands out the link and strangers apply; this is the whole
    // point of the endpoint (spec D5).
    deps.events.getById.mockResolvedValue(buildEvent({ visibility: "PRIVATE" }));
    deps.eventApplications.getForm.mockResolvedValue(
      buildForm({ introText: null, opensAt: null, closesAt: null }),
    );
    deps.eventApplications.listQuestions.mockResolvedValue([]);

    await expect(call()).resolves.toEqual({
      eventId: EVENT_ID,
      introText: null,
      opensAt: null,
      closesAt: null,
      questions: [],
    });
  });

  it("rejects an unknown input key (strict schema)", async () => {
    await expect(
      getPublicEventApplicationForm(
        { repos: deps.repos },
        { eventId: EVENT_ID, viewerHumanId: "sneaky" },
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    expect(deps.events.getById).not.toHaveBeenCalled();
  });
});

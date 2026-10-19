import { describe, expect, it, vi } from "vitest";

import type { EventEditSuggestionRecord } from "@th/ports/repos/event-edit-suggestions";
import type { EventRecord } from "@th/ports/repos/events";
import type { CreateNotificationInput } from "@th/ports/repos/notifications";

import {
  notifySuggestionReviewed,
  notifySuggestionSubmitted,
  type SuggestionNotificationDeps,
} from "./suggestion-notifications";

const EVENT_ID = "b1000000-0000-4000-8000-000000000001";
const SUGGESTION_ID = "b2000000-0000-4000-8000-000000000002";
const SUBMITTER_ID = "b3000000-0000-4000-8000-000000000003";
const MODERATOR_ID = "b4000000-0000-4000-8000-000000000004";
const OWNER_ID = "b5000000-0000-4000-8000-000000000005";

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    title: "Jazz Brunch",
    slug: "jazz-brunch",
    stewardship: "COMMUNITY",
    orgId: null,
    humanId: null,
    ...overrides,
  } as unknown as EventRecord;
}

const suggestion = {
  id: SUGGESTION_ID,
  submitterHumanId: SUBMITTER_ID,
} as unknown as EventEditSuggestionRecord;

function makeDeps() {
  const create = vi
    .fn<[CreateNotificationInput], Promise<{ id: string; createdAt: Date }>>()
    .mockResolvedValue({ id: "n1", createdAt: new Date() });
  const reportError = vi.fn();
  const warn = vi.fn();
  const deps = {
    repos: {
      notifications: { create },
      authz: {
        listHumanIdsByStaffRole: vi.fn().mockResolvedValue([MODERATOR_ID]),
      },
    },
    logger: { warn },
    reportError,
  } as unknown as SuggestionNotificationDeps;
  return { deps, create, reportError, warn };
}

function onlyRow(create: ReturnType<typeof makeDeps>["create"]) {
  expect(create).toHaveBeenCalledTimes(1);
  return create.mock.calls[0]![0];
}

/**
 * Everything about each row is pinned exactly as it was before the rows
 * carried a template; the template and metadata.variant are the additions.
 */
describe("suggestion notifications — stored rows", () => {
  it("submitted, community listing → moderator queue action", async () => {
    const { deps, create } = makeDeps();
    await notifySuggestionSubmitted(deps, { event: event(), suggestion });
    expect(onlyRow(create)).toEqual({
      humanId: MODERATOR_ID,
      title: "New edit suggestion",
      body: 'A visitor suggested changes to "Jazz Brunch".',
      kind: "INFO",
      metadata: {
        eventId: EVENT_ID,
        suggestionId: SUGGESTION_ID,
        variant: "community.suggestion-received",
      },
      tags: ["community", "suggestion"],
      action: { label: "Review suggestion", route: "/moderate/suggestions" },
      template: {
        key: "community.suggestion-received",
        version: "1",
        variables: {
          eventId: EVENT_ID,
          suggestionId: SUGGESTION_ID,
          eventTitle: "Jazz Brunch",
          moderatorQueue: true,
        },
      },
    });
  });

  it("submitted, personal event → no action", async () => {
    const { deps, create } = makeDeps();
    await notifySuggestionSubmitted(deps, {
      event: event({ stewardship: "OWNER" as EventRecord["stewardship"], humanId: OWNER_ID }),
      suggestion,
    });
    const row = onlyRow(create);
    expect(row.humanId).toBe(OWNER_ID);
    expect(row.title).toBe("New edit suggestion");
    expect(row.body).toBe('A visitor suggested changes to "Jazz Brunch".');
    expect(row.action).toBeNull();
    expect(row.template?.variables).toMatchObject({ moderatorQueue: false });
  });

  it("approved, with skipped fields and a note", async () => {
    const { deps, create } = makeDeps();
    await notifySuggestionReviewed(deps, {
      event: event(),
      suggestion,
      decision: "APPROVE",
      reviewNote: "Thanks!",
      conflictedFields: ["title", "startsAt"],
    });
    expect(onlyRow(create)).toEqual({
      humanId: SUBMITTER_ID,
      title: "Your suggestion was approved",
      body: 'Your suggested changes to "Jazz Brunch" were approved and applied. Some fields had changed since you submitted and were skipped: title, startsAt. Reviewer note: Thanks!',
      kind: "SUCCESS",
      metadata: {
        eventId: EVENT_ID,
        suggestionId: SUGGESTION_ID,
        decision: "APPROVE",
        variant: "community.suggestion-reviewed",
      },
      tags: ["suggestion"],
      action: { label: "View event", route: "/events/jazz-brunch" },
      template: {
        key: "community.suggestion-reviewed",
        version: "1",
        variables: {
          eventId: EVENT_ID,
          suggestionId: SUGGESTION_ID,
          eventTitle: "Jazz Brunch",
          eventRoute: "/events/jazz-brunch",
          decision: "APPROVE",
          reviewNote: "Thanks!",
          conflictedFields: ["title", "startsAt"],
        },
      },
    });
  });

  it("approved, plain", async () => {
    const { deps, create } = makeDeps();
    await notifySuggestionReviewed(deps, {
      event: event(),
      suggestion,
      decision: "APPROVE",
      reviewNote: null,
      conflictedFields: [],
    });
    expect(onlyRow(create).body).toBe(
      'Your suggested changes to "Jazz Brunch" were approved and applied.',
    );
  });

  it("rejected with a note, no slug → no action", async () => {
    const { deps, create } = makeDeps();
    await notifySuggestionReviewed(deps, {
      event: event({ slug: null } as Partial<EventRecord>),
      suggestion,
      decision: "REJECT",
      reviewNote: "Not accurate.",
      conflictedFields: [],
    });
    const row = onlyRow(create);
    expect(row.title).toBe("Your suggestion was reviewed");
    expect(row.body).toBe(
      'Your suggested changes to "Jazz Brunch" were reviewed but not applied. Reviewer note: Not accurate.',
    );
    expect(row.kind).toBe("INFO");
    expect(row.action).toBeNull();
    expect(row.template?.variables).toMatchObject({ eventRoute: null });
  });
});

describe("suggestion notifications — failures", () => {
  it("template not stored: row still written, warned and reported (guarded)", async () => {
    const { deps, create, reportError, warn } = makeDeps();
    reportError.mockImplementation(() => {
      throw new Error("reporter down");
    });
    await notifySuggestionReviewed(deps, {
      event: event(),
      suggestion,
      decision: "REJECT",
      reviewNote: "n".repeat(20_000),
      conflictedFields: [],
    });
    const row = onlyRow(create);
    expect(row.title).toBe("Your suggestion was reviewed");
    expect(row.template).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "comms.direct_in_app.template_skipped",
      expect.objectContaining({
        variant: "community.suggestion-reviewed",
        reason: "oversized",
      }),
    );
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a failed write is swallowed, warned and reported", async () => {
    const { deps, create, reportError, warn } = makeDeps();
    const boom = new Error("db down");
    create.mockRejectedValueOnce(boom);
    await expect(
      notifySuggestionSubmitted(deps, { event: event(), suggestion }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      "suggestion.in_app_failed",
      expect.objectContaining({ humanId: MODERATOR_ID }),
    );
    expect(reportError).toHaveBeenCalledWith(boom, {
      tags: { useCase: "community.suggestionNotifications" },
      extra: { humanId: MODERATOR_ID },
    });
  });
});

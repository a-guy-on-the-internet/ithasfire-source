import { describe, expect, it, vi } from "vitest";

import {
  listMyEditSuggestions,
  type ListMyEditSuggestionsDeps,
} from "../list-my-edit-suggestions";
import type { EventEditSuggestionWithEventContext } from "@th/ports/repos/event-edit-suggestions";
import { EVENT_ID, USER_ID, makeSuggestion } from "./helpers";

function withContext(
  overrides: Partial<EventEditSuggestionWithEventContext> = {},
): EventEditSuggestionWithEventContext {
  return {
    ...makeSuggestion({ submitterHumanId: USER_ID }),
    eventTitle: "Weekly Open Mic",
    eventSlug: "event/us/austin/weekly-open-mic-2026-08-01-2000--abc123",
    ...overrides,
  };
}

function buildDeps(
  overrides: {
    items?: EventEditSuggestionWithEventContext[];
    nextCursor?: string | null;
  } = {},
) {
  const listBySubmitter = vi.fn(async () => ({
    items: overrides.items ?? [withContext()],
    nextCursor: "nextCursor" in overrides ? overrides.nextCursor! : "cursor-2",
  }));

  const deps: ListMyEditSuggestionsDeps = {
    repos: {
      eventEditSuggestions: { listBySubmitter },
    } as unknown as ListMyEditSuggestionsDeps["repos"],
  };

  return { deps, listBySubmitter };
}

describe("listMyEditSuggestions", () => {
  it("queries listBySubmitter with the actor's id + cursor/limit", async () => {
    const { deps, listBySubmitter } = buildDeps();

    await listMyEditSuggestions(deps, {
      actorHumanId: USER_ID,
      cursor: "cursor-1",
      limit: 5,
    });

    expect(listBySubmitter).toHaveBeenCalledWith({
      submitterHumanId: USER_ID,
      cursor: "cursor-1",
      limit: 5,
    });
  });

  it("defaults limit to 20 and cursor to null when omitted", async () => {
    const { deps, listBySubmitter } = buildDeps();

    await listMyEditSuggestions(deps, { actorHumanId: USER_ID });

    expect(listBySubmitter).toHaveBeenCalledWith({
      submitterHumanId: USER_ID,
      cursor: null,
      limit: 20,
    });
  });

  it("maps rows to the output contract (title/slug + all statuses) and passes through nextCursor", async () => {
    const pending = withContext({
      id: "00000000-0000-4000-8000-0000000000b1",
      status: "PENDING",
    });
    const approved = withContext({
      id: "00000000-0000-4000-8000-0000000000b2",
      status: "APPROVED",
      reviewedAt: new Date("2026-07-02T00:00:00.000Z"),
      reviewNote: "Looks good",
    });
    const rejected = withContext({
      id: "00000000-0000-4000-8000-0000000000b3",
      status: "REJECTED",
      reviewedAt: new Date("2026-07-03T00:00:00.000Z"),
      conflictedFields: ["title"],
      eventSlug: null,
    });

    const { deps } = buildDeps({
      items: [pending, approved, rejected],
      nextCursor: "cursor-9",
    });

    const result = await listMyEditSuggestions(deps, {
      actorHumanId: USER_ID,
    });

    expect(result.nextCursor).toBe("cursor-9");
    expect(result.items).toHaveLength(3);

    expect(result.items[0]).toEqual({
      id: pending.id,
      eventId: EVENT_ID,
      eventTitle: "Weekly Open Mic",
      eventSlug: pending.eventSlug,
      status: "PENDING",
      fields: pending.fields,
      baseVersion: pending.baseVersion,
      conflictedFields: null,
      reviewNote: null,
      createdAt: pending.createdAt,
      reviewedAt: null,
    });

    expect(result.items[1]).toMatchObject({
      status: "APPROVED",
      reviewNote: "Looks good",
      reviewedAt: approved.reviewedAt,
    });

    expect(result.items[2]).toMatchObject({
      status: "REJECTED",
      eventSlug: null,
      conflictedFields: ["title"],
    });

    // Submitter-only fields are never leaked in the contract.
    expect(result.items[0]).not.toHaveProperty("submitterIp");
    expect(result.items[0]).not.toHaveProperty("submitterIpHash");
    expect(result.items[0]).not.toHaveProperty("submitterHumanId");
  });

  it("passes through a null nextCursor on the last page", async () => {
    const { deps } = buildDeps({ nextCursor: null });

    const result = await listMyEditSuggestions(deps, {
      actorHumanId: USER_ID,
    });

    expect(result.nextCursor).toBeNull();
  });
});

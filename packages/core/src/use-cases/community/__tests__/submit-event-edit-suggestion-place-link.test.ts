import { describe, expect, it, vi } from "vitest";

import {
  submitEventEditSuggestion,
  type SubmitEventEditSuggestionDeps,
} from "../submit-event-edit-suggestion";
import {
  EVENT_ID,
  NOW,
  makeClock,
  makeCommunityEvent,
  makeContentFilter,
} from "./helpers";

/**
 * The place link (`placeId`) is a moderator direct-edit field only. A public
 * edit suggestion carrying it is refused at submit, and no suggestion row is
 * written. Kept in its own file: `submit-event-edit-suggestion.test.ts` has
 * unrelated work in progress.
 */

const PLACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function buildDeps() {
  const create = vi.fn();
  const countPendingByIp = vi.fn(async () => 0);
  const audit = { log: vi.fn() };
  const notificationsCreate = vi.fn(async () => ({ id: "n", createdAt: NOW }));
  const txRepos = {
    eventEditSuggestions: { create, countPendingByIp },
    audit,
  };
  const deps: SubmitEventEditSuggestionDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
      events: {
        getById: vi.fn(async () => makeCommunityEvent({ placeId: null })),
        getContent: vi.fn(async () => null),
      },
      images: {
        getById: vi.fn(async () => null),
        listByEventId: vi.fn(async () => []),
      },
      eventEditSuggestions: { create, countPendingByIp },
      notifications: { create: notificationsCreate },
      organizations: { listMembers: vi.fn(async () => ({ items: [], total: 0 })) },
      authz: { listHumanIdsByStaffRole: vi.fn(async () => []) },
    } as unknown as SubmitEventEditSuggestionDeps["repos"],
    clock: makeClock(),
    contentFilter: makeContentFilter(),
    identitySecret: "k".repeat(48),
    reportError: vi.fn(),
  };
  return { deps, create, audit, notificationsCreate };
}

describe("submitEventEditSuggestion with a placeId", () => {
  it.each([
    ["alone", { placeId: PLACE_ID }],
    ["with a title", { placeId: PLACE_ID, title: "Better title" }],
    ["as null (unlink)", { placeId: null, title: "Better title" }],
  ])(
    "refuses placeId %s as an unsupported field and writes no suggestion",
    async (_label, fields) => {
      const { deps, create, audit, notificationsCreate } = buildDeps();

      await expect(
        submitEventEditSuggestion(deps, { eventId: EVENT_ID, fields }),
      ).rejects.toMatchObject({
        code: "EDIT_SUGGESTION_INVALID_FIELDS",
        meta: { reason: "unsupported_fields", fields: ["placeId"] },
      });
      expect(create).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
      expect(notificationsCreate).not.toHaveBeenCalled();
    },
  );
});

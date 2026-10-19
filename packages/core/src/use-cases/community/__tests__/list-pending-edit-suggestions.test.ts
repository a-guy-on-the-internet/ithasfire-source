import { describe, expect, it, vi } from "vitest";

import {
  listPendingEditSuggestions,
  type ListPendingEditSuggestionsDeps,
} from "../list-pending-edit-suggestions";
import type { EventRecord } from "@th/ports/repos/events";
import type { EventEditSuggestionRecord } from "@th/ports/repos/event-edit-suggestions";
import type { OrgMembership } from "@th/ports/repos/authz";
import {
  ADMIN_ID,
  EVENT_ID,
  MODERATOR_ID,
  ORG_ID,
  OWNER_ID,
  USER_ID,
  makeCommunityEvent,
  makeOrgEvent,
  makePersonalEvent,
  makeStaffAuthz,
  makeSuggestion,
} from "./helpers";

function buildDeps(
  overrides: {
    suggestions?: EventEditSuggestionRecord[];
    events?: EventRecord[];
    membership?: OrgMembership | null;
    rolesByHuman?: Record<string, string[]>;
    scopeEvent?: EventRecord | null;
    humanNames?: Record<string, string | null>;
  } = {},
) {
  const suggestions = overrides.suggestions ?? [makeSuggestion()];
  const events = overrides.events ?? [makeCommunityEvent()];

  const listPending = vi.fn(async () => ({
    items: suggestions,
    nextCursor: "cursor-2",
  }));
  const getByIds = vi.fn(async (ids: string[]) =>
    ids.map((id) => ({ id, name: overrides.humanNames?.[id] ?? null })),
  );
  const findManyByIds = vi.fn(async (ids: string[]) =>
    events.filter((event) => ids.includes(event.id)),
  );
  const getById = vi.fn(async () =>
    overrides.scopeEvent !== undefined
      ? overrides.scopeEvent
      : (events[0] ?? null),
  );
  const getOrgMembership = vi.fn(async () =>
    overrides.membership !== undefined ? overrides.membership : null,
  );

  const deps: ListPendingEditSuggestionsDeps = {
    repos: {
      eventEditSuggestions: { listPending },
      events: { findManyByIds, getById },
      humans: { getByIds },
      authz: { getOrgMembership, getHumanDelegation: vi.fn(async () => null) },
    } as unknown as ListPendingEditSuggestionsDeps["repos"],
    authz: makeStaffAuthz(
      overrides.rolesByHuman ?? {
        [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
        [ADMIN_ID]: ["ADMIN"],
      },
    ),
  };

  return { deps, listPending, findManyByIds, getByIds };
}

describe("listPendingEditSuggestions", () => {
  it("community scope: moderator sees the queue hydrated with event context", async () => {
    const { deps, listPending } = buildDeps();

    const result = await listPendingEditSuggestions(deps, {
      actorHumanId: MODERATOR_ID,
      scope: { kind: "community" },
      limit: 10,
    });

    expect(listPending).toHaveBeenCalledWith({
      scope: { kind: "community" },
      cursor: null,
      limit: 10,
    });
    expect(result.items[0]!.event).toMatchObject({
      id: EVENT_ID,
      title: "Weekly Open Mic",
      status: "PUBLISHED",
    });
    expect(result.nextCursor).toBe("cursor-2");
  });

  it("carries the listing's status, so the queue can mark a taken-down one", async () => {
    const { deps } = buildDeps({
      events: [makeCommunityEvent({ status: "CANCELLED" })],
    });

    const result = await listPendingEditSuggestions(deps, {
      actorHumanId: MODERATOR_ID,
      scope: { kind: "community" },
    });

    expect(result.items[0]!.event?.status).toBe("CANCELLED");
  });

  it("resolves signed-in submitter display names; anonymous stays unnamed", async () => {
    const NAMED_ID = "00000000-0000-4000-8000-0000000000a1";
    const ANON_SUG_ID = "00000000-0000-4000-8000-0000000000a2";
    const named = makeSuggestion({ id: NAMED_ID, submitterHumanId: USER_ID });
    const anon = makeSuggestion({ id: ANON_SUG_ID, submitterHumanId: null });
    const { deps, getByIds } = buildDeps({
      suggestions: [named, anon],
      humanNames: { [USER_ID]: "Jane Doe" },
    });

    const result = await listPendingEditSuggestions(deps, {
      actorHumanId: MODERATOR_ID,
      scope: { kind: "community" },
      limit: 10,
    });

    // Only the signed-in submitter is looked up (batched), never the anon one.
    expect(getByIds).toHaveBeenCalledWith([USER_ID]);
    const nameById = new Map(
      result.items.map((item) => [item.suggestion.id, item.submitterName]),
    );
    expect(nameById.get(NAMED_ID)).toBe("Jane Doe");
    expect(nameById.get(ANON_SUG_ID)).toBeNull();
  });

  it("community scope: non-moderator gets STAFF_ONLY", async () => {
    const { deps, listPending } = buildDeps();

    await expect(
      listPendingEditSuggestions(deps, {
        actorHumanId: USER_ID,
        scope: { kind: "community" },
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
    expect(listPending).not.toHaveBeenCalled();
  });

  it("org scope: requires ORG_EDIT_ROLES membership", async () => {
    const { deps } = buildDeps({ membership: null });

    await expect(
      listPendingEditSuggestions(deps, {
        actorHumanId: MODERATOR_ID,
        scope: { kind: "org", orgId: ORG_ID },
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
  });

  it("org scope: an org editor can read the inbox", async () => {
    const { deps, listPending } = buildDeps({
      membership: { orgId: ORG_ID, humanId: USER_ID, role: "EDITOR" },
      events: [makeOrgEvent()],
      suggestions: [makeSuggestion()],
    });

    await listPendingEditSuggestions(deps, {
      actorHumanId: USER_ID,
      scope: { kind: "org", orgId: ORG_ID },
    });

    expect(listPending).toHaveBeenCalledWith(
      expect.objectContaining({ scope: { kind: "org", orgId: ORG_ID } }),
    );
  });

  it("event scope (personal): owner only", async () => {
    const personal = makePersonalEvent();
    const { deps } = buildDeps({
      scopeEvent: personal,
      events: [personal],
    });

    await expect(
      listPendingEditSuggestions(deps, {
        actorHumanId: OWNER_ID,
        scope: { kind: "event", eventId: EVENT_ID },
      }),
    ).resolves.toBeTruthy();

    await expect(
      listPendingEditSuggestions(deps, {
        actorHumanId: USER_ID,
        scope: { kind: "event", eventId: EVENT_ID },
      }),
    ).rejects.toMatchObject({ code: "NOT_RESOURCE_OWNER" });
  });

  it("event scope (community): routes to the moderator check", async () => {
    const community = makeCommunityEvent();
    const { deps } = buildDeps({ scopeEvent: community, events: [community] });

    await expect(
      listPendingEditSuggestions(deps, {
        actorHumanId: MODERATOR_ID,
        scope: { kind: "event", eventId: EVENT_ID },
      }),
    ).resolves.toBeTruthy();

    await expect(
      listPendingEditSuggestions(deps, {
        actorHumanId: USER_ID,
        scope: { kind: "event", eventId: EVENT_ID },
      }),
    ).rejects.toMatchObject({ code: "STAFF_ONLY" });
  });

  it("event scope: missing event 404s", async () => {
    const { deps } = buildDeps({ scopeEvent: null });

    await expect(
      listPendingEditSuggestions(deps, {
        actorHumanId: MODERATOR_ID,
        scope: { kind: "event", eventId: EVENT_ID },
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });
});

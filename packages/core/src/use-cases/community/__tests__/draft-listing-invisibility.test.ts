import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { ok } from "@th/ports/search/types";

import { withSearchIndexFence } from "@th/test-utils/fakes/search-index-fence";
import { buildSearchIndex as buildSearchIndexFenced } from "../../search/build-search-index";

/** The fixtures below predate the index-write fence; give them its surface. */
const buildSearchIndex: typeof buildSearchIndexFenced = (deps, input) =>
  buildSearchIndexFenced(
    { ...deps, repos: withSearchIndexFence(deps.repos) },
    input,
  );
import { getPublicEventBody } from "../../events/get-public-event-body";
import { getSuggestionBase } from "../get-suggestion-base";
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

// No viewer here holds a staff role.
const noStaffRead = { hasStaffRole: async () => ({ allowed: false }) };

/**
 * A DRAFT community listing must be GENUINELY invisible — not "not linked
 * anywhere yet", but absent from every surface that could surface it.
 *
 * These are regression pins, not assumptions. Each one drives the REAL use
 * case that guards a surface with a DRAFT COMMUNITY event and asserts the
 * refusal, so a future change that loosens one of those guards fails here
 * rather than quietly publishing someone's half-written listing.
 *
 * Surfaces pinned:
 *  1. the public body read (`getPublicEventBody`) — the page content;
 *  2. the anonymous edit-suggestion surface, on BOTH halves: hydration
 *     (`getSuggestionBase`) and submit (`submitEventEditSuggestion`);
 *  3. search / discovery (`buildSearchIndex`) — not merely "not upserted" but
 *     actively REMOVED.
 */

const DRAFT_SLUG = "event/us/austin/weekly-open-mic-2026-08-01-2000--abc123";

function makeDraftListing(overrides: Partial<EventRecord> = {}): EventRecord {
  return makeCommunityEvent({
    status: "DRAFT",
    publishedAt: null,
    ...overrides,
  });
}

// ── 1. Public read ───────────────────────────────────────────────────────────

describe("a DRAFT community listing is not publicly readable", () => {
  const makeReadRepos = (event: EventRecord | null) =>
    ({
      events: {
        resolveBySlug: vi.fn(async () => ({
          eventId: EVENT_ID,
          currentSlug: DRAFT_SLUG,
          redirect: false,
        })),
        getById: vi.fn(async () => event),
        getContent: vi.fn(async () => ({ version: 1, sections: [] })),
      },
      images: { listByEventId: vi.fn(async () => []) },
    }) as unknown as Repos;

  it("getPublicEventBody refuses it as NOT_FOUND", async () => {
    const repos = makeReadRepos(makeDraftListing());

    // The unknown-slug error exactly (N3): EVENT_NOT_PUBLISHED would confirm
    // to a stranger that the slug is a real, unpublished event.
    await expect(
      getPublicEventBody({ repos, authz: noStaffRead }, { slug: DRAFT_SLUG }),
    ).rejects.toMatchObject({
      code: "EVENT_NOT_FOUND",
      meta: { via: "slug" },
    });
  });

  it("…and serves the SAME listing once it is PUBLISHED (the guard is the status, not the fixture)", async () => {
    const repos = makeReadRepos(makeCommunityEvent({ status: "PUBLISHED" }));

    await expect(
      getPublicEventBody({ repos, authz: noStaffRead }, { slug: DRAFT_SLUG }),
    ).resolves.toMatchObject({ eventId: EVENT_ID });
  });
});

// ── 2. Edit suggestions ──────────────────────────────────────────────────────

describe("a DRAFT community listing accepts no edit suggestions", () => {
  it("getSuggestionBase collapses it to EVENT_NOT_FOUND (no draft oracle)", async () => {
    const repos = {
      events: {
        getById: vi.fn(async () => makeDraftListing()),
        getContent: vi.fn(async () => null),
        resolveBySlug: vi.fn(async () => null),
      },
      images: { listByEventId: vi.fn(async () => []) },
    } as unknown as Repos;

    await expect(
      getSuggestionBase({ repos }, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("submitEventEditSuggestion collapses it to EVENT_NOT_FOUND and creates nothing", async () => {
    const create = vi.fn();
    const deps = {
      repos: {
        tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({ eventEditSuggestions: { create }, audit: { log: vi.fn() } }),
        ),
        events: {
          getById: vi.fn(async () => makeDraftListing()),
          getContent: vi.fn(async () => null),
        },
        images: { getById: vi.fn(), listByEventId: vi.fn(async () => []) },
        eventEditSuggestions: {
          create,
          countPendingByIp: vi.fn(async () => 0),
        },
      } as unknown as SubmitEventEditSuggestionDeps["repos"],
      clock: makeClock(),
      contentFilter: makeContentFilter(),
    } satisfies SubmitEventEditSuggestionDeps;

    await expect(
      submitEventEditSuggestion(deps, {
        eventId: EVENT_ID,
        fields: { title: "Better title" },
      }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
    expect(create).not.toHaveBeenCalled();
  });
});

// ── 3. Search / discovery ────────────────────────────────────────────────────

describe("a DRAFT community listing does not enter search/discovery", () => {
  const buildIndexRepos = (event: EventRecord) =>
    ({
      events: {
        getById: vi.fn(async () => event),
        getPopularityStats: vi.fn(async () => []),
        listTicketTypesForEventIds: vi.fn(async () => []),
      },
      payoutTerms: { listByEvent: vi.fn(async () => []) },
      feePolicies: { resolveEffective: vi.fn(async () => null) },
      images: {
        getPrimaryImageRefs: vi.fn(
          async () => new Map<string, { publicUrl: string; key: string }>(),
        ),
      },
      imageModerationRecords: { resolveByKeys: vi.fn(async () => new Map()) },
      categories: { getById: vi.fn(async () => null) },
    }) as unknown as Repos;

  const runIndex = async (event: EventRecord) => {
    const upsertDocuments = vi.fn(async ({ documents }) =>
      ok({ indexed: documents.length }),
    );
    const deleteDocuments = vi.fn(async () => ok(undefined));
    await buildSearchIndex(
      {
        clock: { now: () => NOW },
        repos: buildIndexRepos(event),
        search: {
          ensureIndexes: vi.fn(async () => ok(undefined)),
          upsertDocuments,
          deleteDocuments,
        } as never,
      },
      { eventIds: [EVENT_ID] },
    );
    return { upsertDocuments, deleteDocuments };
  };

  it("is REMOVED from the index, never upserted", async () => {
    const { upsertDocuments, deleteDocuments } = await runIndex(
      makeDraftListing(),
    );

    expect(upsertDocuments).not.toHaveBeenCalled();
    // Upsert-or-REMOVE: absence is enforced, not merely assumed.
    expect(deleteDocuments).toHaveBeenCalledWith({
      ids: [`event_${EVENT_ID}`],
    });
  });

  it("…and IS indexed once published (the guard is the status, not the fixture)", async () => {
    const { upsertDocuments, deleteDocuments } = await runIndex(
      makeCommunityEvent({ status: "PUBLISHED" }),
    );

    expect(deleteDocuments).not.toHaveBeenCalled();
    const types = upsertDocuments.mock.calls.flatMap(([call]) =>
      call.documents.map((doc: { type: string }) => doc.type),
    );
    expect(types).toContain("event");
  });
});

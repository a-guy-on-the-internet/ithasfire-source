import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Repos, TxRepos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import type { MultiSearchPort } from "@th/ports/search/multi-index.port";
import {
  DEFAULT_ACTOR_ID,
  DEFAULT_EVENT_ID,
  DEFAULT_ORG_ID,
  DEFAULT_PLACE_ID,
  makeCreateEventTestContext,
} from "@th/test-utils";
import { createInMemorySearchReindexPending } from "@th/test-utils/fakes/search-reindex-pending";
import { makeStubEventRecord } from "@th/test-utils/fakes/stub-records";

import {
  configureLocationObfuscation,
  resetLocationObfuscationForTests,
} from "../../../lib/location/obfuscation-key";
import { buildPlaceRecord } from "../../booking-requests/__tests__/helpers";
import { updatePage } from "../../entity-pages/update-page";
import { saveEventForOrg } from "../../events/save-event-for-org";
import { updateEventAccessControls } from "../../events/update-event-access-controls";
import { togglePlaceDirectoryListing } from "../../place-reviews/toggle-place-directory-listing";

// ─────────────────────────────────────────────────────────────────────────────
// Every write that changes something a search document shows must MARK the
// entity in its own transaction (`markForSearchReindex`), so the refresh
// commits with the edit. Part 1 pins it statically for every file that
// refreshes the index after a write; part 2 drives the main write paths and
// checks the mark lands inside the transaction.
// ─────────────────────────────────────────────────────────────────────────────

const USE_CASES = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...sourceFiles(path));
    } else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** Files outside the search module that refresh the index after a write. */
const REINDEX_CALLERS = sourceFiles(USE_CASES)
  .filter((file) => !relative(USE_CASES, file).startsWith("search/"))
  .filter((file) => {
    const src = readFileSync(file, "utf8");
    return /\b(run)?[rR]eindexAfterMutation\(/.test(src);
  })
  .map((file) => relative(USE_CASES, file))
  .sort();

/**
 * Writes that change an indexed field but have no search port for an
 * immediate pass: they only mark, and the scheduled drain refreshes them.
 */
const MARK_ONLY_WRITERS = [
  "categories/set-event-category.ts",
  "community/refresh-recurring-event-dates.ts",
  "events/confirm-venue-event.ts",
  "events/regenerate-event-slug.ts",
  "events/withdraw-venue-confirmation.ts",
  "orgs/update-org.ts",
  "places/review-place-verification.ts",
  "places/set-place-directory-listing.ts",
  "places/update-place-status.ts",
  "places/update-place-verification-status.ts",
  "ticket-types/delete-ticket-type.ts",
  "ticket-types/upsert-ticket-type.ts",
];

describe("every index-refreshing write also marks (table-driven)", () => {
  it("finds the callers (guards the scan itself)", () => {
    expect(REINDEX_CALLERS.length).toBeGreaterThanOrEqual(20);
    expect(REINDEX_CALLERS).toContain("events/_shared/save-event-shared.ts");
    expect(REINDEX_CALLERS).toContain("places/upsert-place.ts");
  });

  it.each(REINDEX_CALLERS)("%s marks for search reindex", (file) => {
    const src = readFileSync(join(USE_CASES, file), "utf8");
    expect(
      /\bmarkForSearchReindex\(/.test(src),
      `${file} refreshes the search index after a write but never calls ` +
        "markForSearchReindex inside the write's transaction. A failed or " +
        "starved post-commit refresh would then be lost until the nightly " +
        "full reindex. Mark the entity in the same repos.tx as the write.",
    ).toBe(true);
  });

  it.each(MARK_ONLY_WRITERS)("%s marks for search reindex", (file) => {
    const src = readFileSync(join(USE_CASES, file), "utf8");
    expect(/\bmarkForSearchReindex\(\s*tx\b/.test(src)).toBe(true);
  });
});

// ─── Part 2: behaviour on the main write paths ──────────────────────────────

const NOW = new Date("2026-09-30T12:00:00.000Z");

/**
 * Wrap `repos.tx` so the callback's repos carry `pending`, and log where the
 * transaction opens and commits — a mark between the two ran inside it.
 */
function trackTx<R extends { tx: Repos["tx"] }>(
  repos: R,
  log: string[],
  pending?: TxRepos["searchReindexPending"],
): void {
  const original = repos.tx;
  repos.tx = (async (
    fn: (tx: TxRepos) => Promise<unknown>,
    o?: Parameters<Repos["tx"]>[1],
  ) => {
    log.push("tx:open");
    const out = await original(
      (tx) => fn(pending ? { ...tx, searchReindexPending: pending } : tx),
      o,
    );
    log.push("tx:commit");
    return out;
  }) as Repos["tx"];
}

function spyPending(log: string[]) {
  const pending = createInMemorySearchReindexPending();
  const mark = pending.mark.bind(pending);
  pending.mark = vi.fn(async (targets, at) => {
    log.push(
      `mark:${targets.map((t) => `${t.entityType}:${t.entityId}`).join(",")}`,
    );
    return mark(targets, at);
  });
  return pending;
}

describe("saveEvent marks a PUBLISHED event in its transaction", () => {
  beforeEach(() => {
    configureLocationObfuscation({ secret: "marks-write-paths-secret" });
  });
  afterEach(() => {
    resetLocationObfuscationForTests();
  });

  function published(overrides: Partial<EventRecord> = {}): EventRecord {
    return makeStubEventRecord({
      id: DEFAULT_EVENT_ID,
      orgId: DEFAULT_ORG_ID,
      humanId: null,
      title: "Late Show",
      status: "PUBLISHED",
      stewardship: "OWNED",
      visibility: "PUBLIC",
      gateType: "NONE",
      locationMode: "EXACT",
      locationRadiusMeters: null,
      timezone: "America/Chicago",
      startsAt: new Date("2026-12-10T01:00:00.000Z"),
      endsAt: new Date("2026-12-10T04:00:00.000Z"),
      placeId: DEFAULT_PLACE_ID,
      addressText: "1604 8th Ave S, Nashville, TN 37203",
      countryCode: "US",
      region: "TN",
      locality: "Nashville",
      postalCode: "37203",
      lat: 36.1395,
      lng: -86.7825,
      slug: "late-show",
      publishedAt: new Date("2026-09-01T00:00:00.000Z"),
      admissionTaxRateBps: 925,
      ...overrides,
    } as Partial<EventRecord>);
  }

  function run(existing: EventRecord) {
    const ctx = makeCreateEventTestContext({
      now: NOW,
      place: buildPlaceRecord({
        id: DEFAULT_PLACE_ID,
        formattedAddress: "1604 8th Ave S, Nashville, TN 37203",
        addressLine1: "1604 8th Ave S",
        city: "Nashville",
        region: "TN",
        postalCode: "37203",
        lat: 36.1395,
        lng: -86.7825,
        locationMode: "EXACT",
        locationRadiusMeters: null,
        orgIdsWithAccess: [DEFAULT_ORG_ID],
      }),
      existingEvent: existing,
    });
    const log: string[] = [];
    trackTx(ctx.deps.repos, log, spyPending(log));
    const search = {
      ensureIndexes: vi.fn(async () => ({ ok: true as const })),
      upsertDocuments: vi.fn(async () => ({
        ok: true as const,
        value: { indexed: 1 },
      })),
      deleteDocuments: vi.fn(async () => ({
        ok: true as const,
        value: undefined,
      })),
    } as unknown as MultiSearchPort;
    const save = saveEventForOrg(
      // The shared fake's repo types lag the ports; the runtime shape is what
      // every save-event test uses.
      { ...ctx.deps, search } as unknown as Parameters<
        typeof saveEventForOrg
      >[0],
      {
        actorHumanId: DEFAULT_ACTOR_ID,
        orgId: DEFAULT_ORG_ID,
        eventId: DEFAULT_EVENT_ID,
        title: "Late Show (moved to the big room)",
        startsAt: "2026-12-10T01:00:00.000Z",
        endsAt: "2026-12-10T04:00:00.000Z",
        location: { placeId: DEFAULT_PLACE_ID },
        clientKey: `key-${Math.random()}`,
      },
    );
    return { save, log };
  }

  it("a title edit on a published event marks it before commit", async () => {
    const h = run(published());
    await h.save;

    const markAt = h.log.indexOf(`mark:event:${DEFAULT_EVENT_ID}`);
    expect(markAt).toBeGreaterThan(h.log.indexOf("tx:open"));
    expect(markAt).toBeLessThan(h.log.indexOf("tx:commit"));
  });

  it("a DRAFT has no document: no mark", async () => {
    const h = run(published({ status: "DRAFT", publishedAt: null }));
    await h.save;

    expect(h.log.some((l) => l.startsWith("mark:"))).toBe(false);
  });
});

describe("updateEventAccessControls marks visibility/gate changes — loosening too", () => {
  function setup(start: Partial<EventRecord>) {
    let row = makeStubEventRecord({
      id: DEFAULT_EVENT_ID,
      orgId: DEFAULT_ORG_ID,
      humanId: null,
      status: "PUBLISHED",
      stewardship: "OWNED",
      gateType: "NONE",
      visibility: "PUBLIC",
      locationMode: "EXACT",
      placeId: null,
      lat: 36.1,
      lng: -86.7,
      passwordHash: null,
      ...start,
    } as Partial<EventRecord>);
    const log: string[] = [];
    const tx = {
      events: {
        getById: vi.fn(async () => row),
        updateVisibility: vi.fn(
          async (i: { visibility: EventRecord["visibility"] }) => {
            row = { ...row, visibility: i.visibility };
            return row;
          },
        ),
        updateGateType: vi.fn(async () => row),
        updateWaitlistSettings: vi.fn(async () => row),
      },
      places: { getById: vi.fn(async () => null) },
      authz: {
        getOrgMembership: vi.fn(async () => ({
          orgId: DEFAULT_ORG_ID,
          humanId: DEFAULT_ACTOR_ID,
          role: "OWNER",
        })),
      },
      audit: { log: vi.fn(async () => undefined) },
      searchReindexPending: spyPending(log),
    } as unknown as TxRepos;
    const repos = {
      tx: vi.fn(async (fn: (t: TxRepos) => Promise<unknown>) => fn(tx)),
    } as unknown as Repos;
    trackTx(repos, log);
    return { repos, log };
  }

  it("PRIVATE → PUBLIC (a loosening, which used to wait for the nightly run) is marked in the transaction", async () => {
    const h = setup({ visibility: "PRIVATE" });

    await updateEventAccessControls(
      { repos: h.repos, clock: { now: () => NOW } },
      {
        actorHumanId: DEFAULT_ACTOR_ID,
        eventId: DEFAULT_EVENT_ID,
        visibility: "PUBLIC",
      },
    );

    expect(h.log).toEqual([
      "tx:open",
      `mark:event:${DEFAULT_EVENT_ID}`,
      "tx:commit",
    ]);
  });

  it("a waitlist-only change touches nothing indexed: no mark", async () => {
    const h = setup({});

    await updateEventAccessControls(
      { repos: h.repos, clock: { now: () => NOW } },
      {
        actorHumanId: DEFAULT_ACTOR_ID,
        eventId: DEFAULT_EVENT_ID,
        waitlist: { status: "DISABLED" },
      },
    );

    expect(h.log.some((l) => l.startsWith("mark:"))).toBe(false);
  });
});

describe("mark-and-write share one transaction on the formerly tx-less writers", () => {
  it("togglePlaceDirectoryListing: place write, audit and mark commit together", async () => {
    const log: string[] = [];
    const place = buildPlaceRecord({ id: DEFAULT_PLACE_ID });
    const repos = {
      places: {
        getById: vi.fn(async () => place),
        setDirectoryListing: vi.fn(async () => {
          log.push("place.setDirectoryListing");
          return { changed: true };
        }),
      },
      audit: { log: vi.fn(async () => void log.push("audit")) },
      searchReindexPending: spyPending(log),
    } as unknown as Repos & { tx: Repos["tx"] };
    repos.tx = (async (fn: (t: TxRepos) => Promise<unknown>) => {
      log.push("tx:open");
      const out = await fn(repos);
      log.push("tx:commit");
      return out;
    }) as Repos["tx"];

    await togglePlaceDirectoryListing(
      {
        repos,
        authz: { hasStaffRole: vi.fn(async () => ({ allowed: true })) },
        clock: { now: () => NOW },
      },
      {
        placeId: DEFAULT_PLACE_ID,
        actorHumanId: DEFAULT_ACTOR_ID,
        listedInDirectory: false,
      },
    );

    expect(log).toEqual([
      "tx:open",
      "place.setDirectoryListing",
      "audit",
      `mark:place:${DEFAULT_PLACE_ID}`,
      "tx:commit",
    ]);
  });

  it("updatePage: a HUMAN page edit marks the human in the page write's transaction", async () => {
    const log: string[] = [];
    const page = {
      id: "page-1",
      ownerType: "HUMAN",
      ownerId: DEFAULT_ACTOR_ID,
      slug: "jane",
      displayName: "Jane",
      bio: null,
      avatarUrl: null,
      bannerUrl: null,
      visibility: "PUBLIC",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const repos = {
      entityPages: {
        getByOwner: vi.fn(async () => page),
        isSlugAvailable: vi.fn(async () => true),
        recordSlugHistory: vi.fn(async () => void log.push("slug.history")),
        upsert: vi.fn(async (data: object) => {
          log.push("page.upsert");
          return { ...page, ...data };
        }),
      },
      searchReindexPending: spyPending(log),
    } as unknown as Repos & { tx: Repos["tx"] };
    repos.tx = (async (fn: (t: TxRepos) => Promise<unknown>) => {
      log.push("tx:open");
      const out = await fn(repos);
      log.push("tx:commit");
      return out;
    }) as Repos["tx"];

    await updatePage(
      {
        repos,
        clock: { now: () => NOW },
        authz: { canManagePlace: vi.fn() } as never,
        storage: { getObjectUrl: vi.fn() },
      },
      {
        actorHumanId: DEFAULT_ACTOR_ID,
        ownerType: "HUMAN",
        ownerId: DEFAULT_ACTOR_ID,
        slug: "jane-doe",
        visibility: "PRIVATE",
      },
    );

    expect(log).toEqual([
      "tx:open",
      "slug.history",
      "page.upsert",
      `mark:human:${DEFAULT_ACTOR_ID}`,
      "tx:commit",
    ]);
  });
});

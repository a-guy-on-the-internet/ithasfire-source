import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";
import { createFakeIdempotencyPort } from "@th/test-utils/fakes/idempotency";

import {
  makeLineupNoticeHooks,
  recordLineupNoticeOwed,
} from "../../event-humans/notify-lineup-notices";
import {
  publishCommunityListing,
  type PublishCommunityListingDeps,
} from "../publish-community-listing";
import {
  ADMIN_ID,
  EVENT_ID,
  MODERATOR_ID,
  makeClock,
  makeCommunityEvent,
  makeStaffAuthz,
} from "./helpers";

// Owner ruling "option A" (2026-09-30): community listings never go through
// publishEvent (it refuses RSVP events), so a person put on a DRAFT listing's
// lineup is told HERE, on the real DRAFT → PUBLISHED flip — and never on the
// idempotent replays.

const ROW = "a0000000-0000-4000-8000-00000000000a";
const PERSON = "40000000-0000-4000-8000-000000000004";
const VALID_INPUT = { actorHumanId: MODERATOR_ID, eventId: EVENT_ID };

type Shape = "draft" | "already-published" | "cas-lost-published";

function buildDeps(shape: Shape, lineup: "real" | "throwing" = "real") {
  const draft = makeCommunityEvent({ status: "DRAFT", publishedAt: null });
  const published = {
    ...draft,
    status: "PUBLISHED",
    publishedAt: new Date("2026-06-01T00:00:00.000Z"),
  } as EventRecord;
  const state = { event: shape === "already-published" ? published : draft };
  const getById = vi.fn(async () => state.event);
  const publishCommunityListingIfDraft = vi.fn(async ({ publishedAt }: { publishedAt: Date }) => {
    if (shape === "cas-lost-published") {
      state.event = published; // a concurrent publish won the row
      return null;
    }
    state.event = { ...draft, status: "PUBLISHED", publishedAt } as EventRecord;
    return state.event;
  });
  const txRepos = {
    events: { getById, publishCommunityListingIfDraft },
    calendars: { findById: vi.fn(async () => null) },
    audit: { log: vi.fn() },
    // Inert stand-ins for tx repos concurrent (uncommitted) workstreams
    // write in this tx; harmless at HEAD.
    searchReindexPending: { mark: vi.fn(async () => undefined) },
    entityPages: { getByOwner: vi.fn(async () => null) },
    entityEventNotices: { enqueue: vi.fn() },
  };

  const idempotency = createFakeIdempotencyPort();
  const notify = vi.fn(async (_input: any) => ({ ok: true, email: { status: "sent" } }));
  const reportError = vi.fn();
  const hooks = makeLineupNoticeHooks({
    repos: {
      events: { getById, listTicketTypes: vi.fn(async () => []) },
      eventHumans: {
        getById: vi.fn(),
        listByEvent: vi.fn(async () => [
          {
            id: ROW,
            eventId: EVENT_ID,
            humanId: PERSON,
            externalName: null,
            externalUrl: null,
            role: "HOST",
            customRoleLabel: null,
            sortOrder: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            profileSlug: null,
            humanDisplayName: null,
          },
        ]),
      },
      humans: {
        getById: vi.fn(async (id: string) => ({ id, name: "Mod Erator" })),
        listEmailVerifiedIds: vi.fn(async (ids: readonly string[]) => [...ids]),
      },
      organizations: { getById: vi.fn() },
      entityPages: { getByOwner: vi.fn(async () => null) },
    } as any,
    idempotency,
    notify: notify as any,
    publicAppUrl: "https://ithasfire.com",
    reportError,
  });
  const dispatch = vi.fn(
    lineup === "throwing"
      ? async () => {
          throw new Error("sweep exploded");
        }
      : hooks.dispatch,
  );

  const deps: PublishCommunityListingDeps = {
    repos: {
      tx: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txRepos)),
    } as unknown as PublishCommunityListingDeps["repos"],
    authz: makeStaffAuthz({
      [MODERATOR_ID]: ["COMMUNITY_MODERATOR"],
      [ADMIN_ID]: ["ADMIN"],
    }),
    clock: makeClock(),
    lineupNotices: { dispatch },
    reportError,
  };
  return { deps, dispatch, notify, idempotency, reportError };
}

async function owe(idempotency: ReturnType<typeof createFakeIdempotencyPort>) {
  // What attachEventHuman writes before its tx when a moderator puts PERSON
  // on the DRAFT listing's lineup.
  await recordLineupNoticeOwed(
    { idempotency },
    { eventHumanId: ROW, addedByHumanId: MODERATOR_ID, via: "attach" },
  );
}

describe("publishCommunityListing — lineup notice sweep", () => {
  it("DRAFT → PUBLISHED tells an owed person, once, before the publish returns", async () => {
    const h = buildDeps("draft");
    await owe(h.idempotency);

    const result = await publishCommunityListing(h.deps, VALID_INPUT);

    expect(result.changed).toBe(true);
    expect(h.dispatch).toHaveBeenCalledWith({ kind: "published", eventId: EVENT_ID });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify.mock.calls[0]![0]).toMatchObject({
      humanId: PERSON,
      variant: "event.lineup-added",
      payload: {
        eventHumanId: ROW,
        roleLabel: "Host",
        // Ownerless listing: nobody to tell on a leave, so no such promise.
        organiserWillBeTold: false,
      },
    });
  });

  it("the idempotent replay (already PUBLISHED) runs no sweep", async () => {
    const h = buildDeps("already-published");
    await owe(h.idempotency);
    const result = await publishCommunityListing(h.deps, VALID_INPUT);
    expect(result.changed).toBe(false);
    expect(h.dispatch).not.toHaveBeenCalled();
    expect(h.notify).not.toHaveBeenCalled();
  });

  it("the CAS-lost replay (a concurrent publish won) runs no sweep", async () => {
    const h = buildDeps("cas-lost-published");
    await owe(h.idempotency);
    const result = await publishCommunityListing(h.deps, VALID_INPUT);
    expect(result.changed).toBe(false);
    expect(h.dispatch).not.toHaveBeenCalled();
  });

  it("a failing sweep never fails the publish — it is reported", async () => {
    const h = buildDeps("draft", "throwing");
    await expect(publishCommunityListing(h.deps, VALID_INPUT)).resolves.toMatchObject({
      changed: true,
    });
    expect(h.reportError).toHaveBeenCalledTimes(1);
    expect(h.reportError.mock.calls[0]![1]).toMatchObject({
      tags: { useCase: "publishCommunityListing", stage: "lineup_notice" },
      extra: { eventId: EVENT_ID },
    });
  });
});

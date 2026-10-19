import { describe, expect, it, vi } from "vitest";

import type { EventRecord } from "@th/ports/repos/events";

import { getBannedOwnerHolderAccess } from "../get-banned-owner-holder-access";

// Owner ruling (ban-that-sticks): a TICKET HOLDER keeps a banned owner's event
// page on the web. The web 404 asks this once; only "holder + the ban is the
// ONLY reason it is hidden" gets an answer, everything else is the same null.

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const HOLDER = "22222222-2222-4222-8222-222222222222";
const STRANGER = "33333333-3333-4333-8333-333333333333";
const SLUG = "event/us/nashville/show--abc";

function deps(event: Partial<EventRecord> | null) {
  const getById = vi.fn(async () =>
    event === null
      ? null
      : ({
          id: EVENT_ID,
          status: "PUBLISHED",
          publishedAt: new Date("2026-09-01"),
          ownerBanned: true,
          ...event,
        } as EventRecord),
  );
  return {
    getById,
    deps: {
      repos: {
        events: {
          resolveBySlug: vi.fn(async (slug: string) =>
            slug === SLUG
              ? { eventId: EVENT_ID, currentSlug: SLUG, redirect: false }
              : null,
          ),
          getById,
        },
        tickets: {
          viewerHoldsActiveTicketForEvent: vi.fn(
            async (_e: string, humanId: string) => humanId === HOLDER,
          ),
        },
      },
    } as unknown as Parameters<typeof getBannedOwnerHolderAccess>[0],
  };
}

describe("getBannedOwnerHolderAccess", () => {
  it("answers a holder of an event hidden only by the ban, reading WITH the owner standing", async () => {
    const { deps: d, getById } = deps({});
    await expect(
      getBannedOwnerHolderAccess(d, { slug: SLUG, viewerHumanId: HOLDER }),
    ).resolves.toEqual({ eventId: EVENT_ID, currentSlug: SLUG });
    expect(getById).toHaveBeenCalledWith(EVENT_ID, { withOwnerStanding: true });
  });

  it.each([
    ["an anonymous viewer", {}, null, SLUG],
    ["a signed-in stranger (no ticket)", {}, STRANGER, SLUG],
    ["an unknown slug", {}, HOLDER, "event/us/nope--zzz"],
    [
      "an event whose owner is NOT banned",
      { ownerBanned: false },
      HOLDER,
      SLUG,
    ],
    [
      "a DRAFT (hidden for another reason too)",
      { status: "DRAFT", publishedAt: null },
      HOLDER,
      SLUG,
    ],
  ])("refuses %s with the same null", async (_l, event, viewer, slug) => {
    const { deps: d } = deps(event as Partial<EventRecord>);
    await expect(
      getBannedOwnerHolderAccess(d, { slug, viewerHumanId: viewer }),
    ).resolves.toBeNull();
  });

  it("never asks the ticket lookup for an anonymous viewer", async () => {
    const { deps: d } = deps({});
    await getBannedOwnerHolderAccess(d, { slug: SLUG });
    expect(d.repos.events.resolveBySlug).not.toHaveBeenCalled();
    expect(d.repos.tickets.viewerHoldsActiveTicketForEvent).not.toHaveBeenCalled();
  });
});

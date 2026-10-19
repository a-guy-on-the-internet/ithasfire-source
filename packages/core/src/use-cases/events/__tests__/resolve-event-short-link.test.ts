import { describe, expect, it, vi } from "vitest";

import type { Repos } from "@th/ports/repos";
import type { EventRecord } from "@th/ports/repos/events";
import { createTestLogger } from "@th/test-utils/fakes/logger";

import {
  resolveEventShortLink,
  type ResolveEventShortLinkDeps,
} from "../resolve-event-short-link";

const EVENT_ID = "11111111-1111-4111-8111-111111111111";
const SHORT_ID = "wqsdk6pxzi";
const SLUG =
  "ithas-fire-demo-org/us/general/lower-east-side-charity-fundraiser-2026-10-30-0200--wqsdk6pxzi";
const LIVE_AT = new Date("2026-09-01T00:00:00.000Z");
const NOT_FOUND = { code: "EVENT_NOT_FOUND", meta: { via: "slug" } };

function makeEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: EVENT_ID,
    slug: SLUG,
    shortId: SHORT_ID,
    status: "PUBLISHED",
    publishedAt: LIVE_AT,
    ...overrides,
  } as unknown as EventRecord;
}

function makeDeps(opts: { event?: EventRecord | null } = {}) {
  const event = "event" in opts ? (opts.event ?? null) : makeEvent();
  const events = {
    resolveByShortId: vi.fn(async (shortId: string) =>
      event && event.shortId === shortId && event.slug
        ? { eventId: event.id, currentSlug: event.slug }
        : null,
    ),
    getById: vi.fn(async (id: string) => (event?.id === id ? event : null)),
  };
  const logger = createTestLogger();
  const deps: ResolveEventShortLinkDeps = {
    repos: { events } as unknown as Repos,
    logger,
  };
  return { deps, events, logger };
}

describe("resolveEventShortLink", () => {
  it("resolves a PUBLISHED event's short ID to its current slug", async () => {
    const { deps, events, logger } = makeDeps();

    await expect(
      resolveEventShortLink(deps, { shortId: SHORT_ID }),
    ).resolves.toEqual({ currentSlug: SLUG });
    expect(events.resolveByShortId).toHaveBeenCalledWith(SHORT_ID);
    expect(events.getById).toHaveBeenCalledWith(EVENT_ID);
    expect(logger.info).toHaveBeenCalledWith("event.short_link_resolved", {
      shortId: SHORT_ID,
      eventId: EVENT_ID,
    });
  });

  it.each(["CANCELLED", "COMPLETED", "ARCHIVED"] as const)(
    "resolves a %s event that was live (links to it are already out)",
    async (status) => {
      const { deps } = makeDeps({ event: makeEvent({ status }) });

      await expect(
        resolveEventShortLink(deps, { shortId: SHORT_ID }),
      ).resolves.toEqual({ currentSlug: SLUG });
    },
  );

  it("withholds a DRAFT: its short ID is computable from the event's UUID", async () => {
    const { deps, logger } = makeDeps({
      event: makeEvent({ status: "DRAFT", publishedAt: null }),
    });

    await expect(
      resolveEventShortLink(deps, { shortId: SHORT_ID }),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(logger.info).toHaveBeenCalledWith("event.short_link_withheld", {
      shortId: SHORT_ID,
      eventId: EVENT_ID,
    });
  });

  it.each(["CANCELLED", "ARCHIVED"] as const)(
    "withholds a %s event that never went live",
    async (status) => {
      const { deps } = makeDeps({
        event: makeEvent({ status, publishedAt: null }),
      });

      await expect(
        resolveEventShortLink(deps, { shortId: SHORT_ID }),
      ).rejects.toMatchObject(NOT_FOUND);
    },
  );

  it("an unknown short ID is the same EVENT_NOT_FOUND", async () => {
    const { deps, events } = makeDeps({ event: null });

    await expect(
      resolveEventShortLink(deps, { shortId: "zzzzzzzzzz" }),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(events.resolveByShortId).toHaveBeenCalledWith("zzzzzzzzzz");
    expect(events.getById).not.toHaveBeenCalled();
  });

  it.each([
    ["too short", "wqsdk6"],
    ["too long", "wqsdk6pxzi1"],
    ["bad characters", "wqsdk-pxzi"],
    ["punctuation", "wqsdk6pxz!"],
  ])(
    "rejects a non-short-ID (%s) WITHOUT asking the repo",
    async (_label, shortId) => {
      const { deps, events } = makeDeps();

      await expect(
        resolveEventShortLink(deps, { shortId }),
      ).rejects.toMatchObject(NOT_FOUND);
      expect(events.resolveByShortId).not.toHaveBeenCalled();
    },
  );

  it("never pads a short prefix into some other event's ID", async () => {
    // `sanitizeShortId("ab")` is `ab00000000`; a lookup must not follow it.
    const { deps, events } = makeDeps({
      event: makeEvent({ shortId: "ab00000000" }),
    });

    await expect(
      resolveEventShortLink(deps, { shortId: "ab" }),
    ).rejects.toMatchObject(NOT_FOUND);
    expect(events.resolveByShortId).not.toHaveBeenCalled();
  });

  it("normalises an uppercase short ID (and surrounding whitespace)", async () => {
    const { deps, events } = makeDeps();

    await expect(
      resolveEventShortLink(deps, { shortId: ` ${SHORT_ID.toUpperCase()} ` }),
    ).resolves.toEqual({ currentSlug: SLUG });
    expect(events.resolveByShortId).toHaveBeenCalledWith(SHORT_ID);
  });

  it("rejects unknown input keys (strict schema)", async () => {
    const { deps } = makeDeps();

    await expect(
      resolveEventShortLink(deps, { shortId: SHORT_ID, viewerHumanId: "x" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

/**
 * A community moderator's page image (subject PLACE, moderator place page
 * spec R5) is named and linked in the uploader's moderation notices: the
 * place's name, linked to its page. The notice copy names "the page", not
 * "the event".
 */

import { describe, expect, it, vi } from "vitest";

import { renderNotification } from "../../comms/renderers";
import { resolveImageModerationSubject } from "../image-moderation-subject";

const PLACE_ID = "place-1";
const RECORD = { id: "rec-1", subjectType: "PLACE" as const, subjectId: PLACE_ID };

function logger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn() } as never;
}

function repos(opts: {
  place?: { name: string } | null;
  page?: { slug: string; visibility: string } | null;
  throws?: boolean;
}) {
  return {
    events: { getById: vi.fn(async () => null) },
    places: {
      getById: vi.fn(async () => {
        if (opts.throws) throw new Error("db down");
        return opts.place === undefined
          ? { id: PLACE_ID, name: "The Room" }
          : opts.place;
      }),
    },
    entityPages: {
      getByOwner: vi.fn(async () =>
        opts.page === undefined
          ? { slug: "the-room", visibility: "PUBLIC" }
          : opts.page,
      ),
    },
  } as never;
}

describe("resolveImageModerationSubject: PLACE", () => {
  it("names the place and links its page", async () => {
    const r = repos({});
    const result = await resolveImageModerationSubject({
      record: RECORD,
      repos: r,
      appBaseUrl: "https://ithasfire.com/",
      logger: logger(),
    });
    expect(result).toEqual({
      subjectTitle: "The Room",
      subjectUrl: "https://ithasfire.com/p/the-room",
    });
    expect((r as { events: { getById: unknown } }).events.getById).not.toHaveBeenCalled();
  });

  it("gives the name without a link for a PRIVATE page or with no base URL", async () => {
    await expect(
      resolveImageModerationSubject({
        record: RECORD,
        repos: repos({ page: { slug: "the-room", visibility: "PRIVATE" } }),
        appBaseUrl: "https://ithasfire.com",
        logger: logger(),
      }),
    ).resolves.toEqual({ subjectTitle: "The Room", subjectUrl: null });
    await expect(
      resolveImageModerationSubject({
        record: RECORD,
        repos: repos({}),
        appBaseUrl: null,
        logger: logger(),
      }),
    ).resolves.toEqual({ subjectTitle: "The Room", subjectUrl: null });
  });

  it("answers nulls with no lookup when the caller passed no places / entityPages", async () => {
    const events = { getById: vi.fn(async () => null) };
    await expect(
      resolveImageModerationSubject({
        record: RECORD,
        repos: { events } as never,
        appBaseUrl: "https://ithasfire.com",
        logger: logger(),
      }),
    ).resolves.toEqual({ subjectTitle: null, subjectUrl: null });
    expect(events.getById).not.toHaveBeenCalled();
  });

  it("a failed lookup degrades to nulls and is reported", async () => {
    const reportError = vi.fn();
    const log = logger();
    await expect(
      resolveImageModerationSubject({
        record: RECORD,
        repos: repos({ throws: true }),
        appBaseUrl: "https://ithasfire.com",
        logger: log,
        reportError,
      }),
    ).resolves.toEqual({ subjectTitle: null, subjectUrl: null });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "db down" }),
      expect.objectContaining({
        tags: { area: "image-moderation", reason: "subject-lookup-failed" },
      }),
    );
  });
});

describe("image moderation notices for a PLACE subject", () => {
  const payload = {
    recordId: "66666666-6666-4666-8666-666666666666",
    kind: "PAGE_MEDIA",
    subjectType: "PLACE",
    subjectId: PLACE_ID,
    subjectTitle: "The Room",
    subjectUrl: "https://ithasfire.com/p/the-room",
    imageUrl: "https://cdn.ithasfire.com/entity-pages/place/place-1/x.jpg",
    helpUrl: "https://ithasfire.com/help",
  } as const;
  const ctx = { now: new Date("2026-10-16T00:00:00.000Z") } as const;

  it.each([
    ["image.moderation.held", payload],
    ["image.moderation.approved", { ...payload, note: null }],
    ["image.moderation.rejected", { ...payload, note: null }],
  ] as const)("%s links the page, not 'the event', and offers no event action", (variant, input) => {
    const result = renderNotification(variant, input, ctx);
    expect(result.email?.text).toContain(
      "View the page: https://ithasfire.com/p/the-room",
    );
    expect(result.email?.text).not.toContain("View the event");
    expect(result.inApp?.action ?? null).toBeNull();
    expect(result.inApp?.body).toContain("The Room");
  });
});

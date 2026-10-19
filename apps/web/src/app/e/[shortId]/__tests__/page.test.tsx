import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route shell for `/e/[shortId]` (event short links). Pins: a TEMPORARY
 * redirect (never `permanentRedirect`) to the multi-segment canonical path,
 * query params carried along, the 404 for a withheld / unknown event, and no
 * API call at all for something that is not a short ID.
 */

const mocks = vi.hoisted(() => ({
  resolvePublicEventShortLink: vi.fn(),
  permanentRedirect: vi.fn(),
}));

class NotFoundSignal extends Error {}
class RedirectSignal extends Error {
  constructor(public readonly to: string) {
    super(`redirect:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("not-found");
  },
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  permanentRedirect: mocks.permanentRedirect,
}));

vi.mock("@/server/events", () => ({
  resolvePublicEventShortLink: mocks.resolvePublicEventShortLink,
}));

import EventShortLinkPage from "../page";

const SLUG =
  "ithas-fire-demo-org/us/general/lower-east-side-charity-fundraiser-2026-10-30-0200--wqsdk6pxzi";

function render(shortId: string, searchParams: Record<string, string> = {}) {
  return EventShortLinkPage({
    params: Promise.resolve({ shortId }),
    searchParams: Promise.resolve(searchParams),
  });
}

beforeEach(() => {
  mocks.resolvePublicEventShortLink.mockReset();
  mocks.permanentRedirect.mockReset();
});

describe("/e/[shortId]", () => {
  it("307s to the canonical page, slashes intact", async () => {
    mocks.resolvePublicEventShortLink.mockResolvedValue({ currentSlug: SLUG });

    await expect(render("wqsdk6pxzi")).rejects.toMatchObject({
      to: `/events/${SLUG}`,
    });
    expect(mocks.resolvePublicEventShortLink).toHaveBeenCalledWith(
      "wqsdk6pxzi",
    );
    expect(mocks.permanentRedirect).not.toHaveBeenCalled();
  });

  it("carries the query string along", async () => {
    mocks.resolvePublicEventShortLink.mockResolvedValue({ currentSlug: SLUG });

    await expect(
      render("wqsdk6pxzi", { ref: "flyer", utm_source: "sms" }),
    ).rejects.toMatchObject({
      to: `/events/${SLUG}?ref=flyer&utm_source=sms`,
    });
  });

  it("lowercases the ID before resolving", async () => {
    mocks.resolvePublicEventShortLink.mockResolvedValue({ currentSlug: SLUG });

    await expect(render("WQSDK6PXZI")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mocks.resolvePublicEventShortLink).toHaveBeenCalledWith(
      "wqsdk6pxzi",
    );
  });

  it("404s when the event is withheld or unknown", async () => {
    mocks.resolvePublicEventShortLink.mockResolvedValue(null);

    await expect(render("zzzzzzzzzz")).rejects.toBeInstanceOf(NotFoundSignal);
  });

  it.each(["ab", "wqsdk6pxzi1", "wqsdk-pxzi"])(
    "404s %s without asking the API",
    async (shortId) => {
      await expect(render(shortId)).rejects.toBeInstanceOf(NotFoundSignal);
      expect(mocks.resolvePublicEventShortLink).not.toHaveBeenCalled();
    },
  );
});

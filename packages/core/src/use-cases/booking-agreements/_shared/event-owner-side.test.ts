import { describe, expect, it } from "vitest";

import { LEGACY_OWNER_SIDE } from "../../../lib/legacy-place-values";
import {
  defaultEventOwnerSideForIntent,
  eventOwnerSideSchema,
  resolveEventOwnerSide,
} from "./event-owner-side";

describe("defaultEventOwnerSideForIntent", () => {
  it("PERFORM → the venue hosts the act, so the venue owns the show", () => {
    expect(defaultEventOwnerSideForIntent("PERFORM")).toBe("place");
  });

  it("RENT / USE → the requester runs their own night, so the requester owns it", () => {
    expect(defaultEventOwnerSideForIntent("RENT")).toBe("requester");
    expect(defaultEventOwnerSideForIntent("USE")).toBe("requester");
  });

  it("fails CLOSED on an unknown intent instead of quietly handing the event to the requester", () => {
    // The requester side is the one that skips cloning the venue's default
    // PayoutTerms, so a malformed row must throw rather than land there.
    expect(() =>
      defaultEventOwnerSideForIntent(undefined as unknown as "PERFORM"),
    ).toThrow(
      expect.objectContaining({
        code: "INTERNAL",
        meta: { intent: "undefined" },
      }),
    );
    expect(() =>
      defaultEventOwnerSideForIntent("SUBLET" as unknown as "PERFORM"),
    ).toThrow(
      expect.objectContaining({ code: "INTERNAL", meta: { intent: "SUBLET" } }),
    );
  });
});

describe("resolveEventOwnerSide", () => {
  it("the venue's override wins over the intent default", () => {
    expect(resolveEventOwnerSide({ intent: "PERFORM" }, "requester")).toBe(
      "requester",
    );
    expect(resolveEventOwnerSide({ intent: "RENT" }, "place")).toBe("place");
  });

  it("null / undefined override falls back to the intent default", () => {
    expect(resolveEventOwnerSide({ intent: "PERFORM" }, null)).toBe("place");
    expect(resolveEventOwnerSide({ intent: "USE" }, undefined)).toBe(
      "requester",
    );
  });
});

describe("eventOwnerSideSchema (an input boundary)", () => {
  it("takes the place spelling and the requester", () => {
    expect(eventOwnerSideSchema.parse("place")).toBe("place");
    expect(eventOwnerSideSchema.parse("requester")).toBe("requester");
  });

  it("reads the pre-2026-10-18 spelling an older web build sends as place", () => {
    expect(eventOwnerSideSchema.parse(LEGACY_OWNER_SIDE)).toBe("place");
  });

  it("refuses anything else", () => {
    expect(eventOwnerSideSchema.safeParse("act").success).toBe(false);
    expect(eventOwnerSideSchema.safeParse("PLACE").success).toBe(false);
  });
});

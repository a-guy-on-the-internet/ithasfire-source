import { describe, expect, it } from "vitest";

import {
  DEFAULT_EMBED_VIEW,
  parseEmbedView,
  resolveEmbedBrowseView,
} from "../embed-view";

describe("parseEmbedView", () => {
  it("accepts every valid view", () => {
    expect(parseEmbedView("list")).toBe("list");
    expect(parseEmbedView("calendar")).toBe("calendar");
  });

  it("returns null (not the default) for anything unrecognised", () => {
    // Null is load-bearing: FR-003 needs an unknown value to FALL THROUGH to
    // the next signal, not to short-circuit the precedence at "list".
    expect(parseEmbedView("map")).toBeNull();
    expect(parseEmbedView("List")).toBeNull();
    expect(parseEmbedView("")).toBeNull();
    expect(parseEmbedView(null)).toBeNull();
    expect(parseEmbedView(undefined)).toBeNull();
  });
});

describe("resolveEmbedBrowseView (FR-003 precedence)", () => {
  it("falls back to list with no param and no config", () => {
    // NFR-001: a pre-migration row on a bare /embed/<id> renders today's grid.
    expect(resolveEmbedBrowseView({})).toBe("list");
    expect(
      resolveEmbedBrowseView({ viewParam: null, configuredDefaultView: null }),
    ).toBe("list");
    expect(resolveEmbedBrowseView({})).toBe(DEFAULT_EMBED_VIEW);
  });

  it("uses the stored default when the URL says nothing", () => {
    expect(resolveEmbedBrowseView({ configuredDefaultView: "calendar" })).toBe(
      "calendar",
    );
    expect(resolveEmbedBrowseView({ configuredDefaultView: "list" })).toBe(
      "list",
    );
  });

  it("lets an explicit ?view= param beat the stored default", () => {
    expect(
      resolveEmbedBrowseView({
        viewParam: "calendar",
        configuredDefaultView: "list",
      }),
    ).toBe("calendar");
    expect(
      resolveEmbedBrowseView({
        viewParam: "list",
        configuredDefaultView: "calendar",
      }),
    ).toBe("list");
  });

  it("ignores an unknown ?view= value and falls through to the config", () => {
    expect(
      resolveEmbedBrowseView({
        viewParam: "map",
        configuredDefaultView: "calendar",
      }),
    ).toBe("calendar");
    // …and all the way to the fallback when there is no config either.
    expect(resolveEmbedBrowseView({ viewParam: "map" })).toBe("list");
  });

  it("ignores an unrecognised STORED value rather than throwing", () => {
    // `defaultView` is a bare string column, so a value written by a newer
    // deploy must degrade, never white-screen a live embed.
    expect(resolveEmbedBrowseView({ configuredDefaultView: "week" })).toBe(
      "list",
    );
  });

  it("pins the calendar route regardless of param or config", () => {
    // /embed/calendar/[embedId] is a permanent alias — a live contract on
    // third-party sites that NEVER consults defaultView.
    expect(resolveEmbedBrowseView({ routeView: "calendar" })).toBe("calendar");
    expect(
      resolveEmbedBrowseView({
        routeView: "calendar",
        configuredDefaultView: "list",
      }),
    ).toBe("calendar");
    expect(
      resolveEmbedBrowseView({
        routeView: "calendar",
        viewParam: "list",
        configuredDefaultView: "list",
      }),
    ).toBe("calendar");
  });
});

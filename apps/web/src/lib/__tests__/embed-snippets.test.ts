import { describe, expect, it } from "vitest";

import type { EmbedSnippetOptions } from "../embed-snippets";
import {
  BOOKING_FORM_DEFAULT_HEIGHT,
  CALENDAR_DEFAULT_HEIGHT,
  MEMBERSHIPS_DEFAULT_HEIGHT,
  HF_STUB_LINE,
  buildBookingIframeSnippet,
  buildBookingSnippet,
  buildMembershipsIframeSnippet,
  buildCalendarIframeSnippet,
  buildCalendarReactSnippet,
  buildEmbedQueryString,
  buildEmbedWidgetUrl,
  buildTicketsIframeSnippet,
  buildTicketsModalSnippet,
  buildTicketsSdkSnippet,
} from "../embed-snippets";
import { parseEmbedScope } from "../embed-scope";

const SITE = "https://ithasfire.com";
const ID = "11111111-2222-3333-4444-555555555555";

describe("buildEmbedQueryString", () => {
  it("returns an empty string (not a bare '?') when there is nothing to append", () => {
    expect(buildEmbedQueryString()).toBe("");
    expect(buildEmbedQueryString({ themeEntries: [], scope: "own" })).toBe("");
  });

  it("omits the default scope so snippets stay clean", () => {
    expect(buildEmbedQueryString({ scope: "own" })).toBe("");
  });

  it("includes a non-default scope", () => {
    expect(buildEmbedQueryString({ scope: "venues" })).toBe("?scope=venues");
    expect(buildEmbedQueryString({ scope: "all" })).toBe("?scope=all");
  });

  it("ignores scope when the subject type doesn't support it", () => {
    expect(buildEmbedQueryString({ scope: null })).toBe("");
  });

  it("combines theme params with scope", () => {
    expect(
      buildEmbedQueryString({
        themeEntries: [["brandColor", "FF0000"]],
        scope: "venues",
      }),
    ).toBe("?brandColor=FF0000&scope=venues");
  });

  it("omits the default 'list' view and emits a calendar one", () => {
    // Same server-default omission rule as scope: a snippet with no ?view=
    // follows the embed's stored defaultView (FR-003).
    expect(buildEmbedQueryString({ view: "list" })).toBe("");
    expect(buildEmbedQueryString({ view: null })).toBe("");
    expect(buildEmbedQueryString({ view: "calendar" })).toBe("?view=calendar");
    expect(buildEmbedQueryString({ scope: "venues", view: "calendar" })).toBe(
      "?scope=venues&view=calendar",
    );
  });
});

describe("buildEmbedWidgetUrl", () => {
  it("targets the tickets widget by default", () => {
    expect(buildEmbedWidgetUrl(SITE, ID)).toBe(`${SITE}/embed/${ID}`);
  });

  it("targets the booking form when book is set", () => {
    expect(buildEmbedWidgetUrl(SITE, ID, { book: true })).toBe(
      `${SITE}/embed/book/${ID}`,
    );
  });

  it("appends a non-default scope", () => {
    expect(buildEmbedWidgetUrl(SITE, ID, { scope: "all" })).toBe(
      `${SITE}/embed/${ID}?scope=all`,
    );
  });

  it("appends ?view=calendar but omits the default list view", () => {
    expect(buildEmbedWidgetUrl(SITE, ID, { view: "calendar" })).toBe(
      `${SITE}/embed/${ID}?view=calendar`,
    );
    expect(buildEmbedWidgetUrl(SITE, ID, { view: "list" })).toBe(
      `${SITE}/embed/${ID}`,
    );
    expect(buildEmbedWidgetUrl(SITE, ID, { view: null })).toBe(
      `${SITE}/embed/${ID}`,
    );
  });

  it("never puts a view param on the booking form or the calendar alias", () => {
    // The booking form has no views at all (D-004), and the alias route
    // already pins the calendar — repeating it there would be noise.
    expect(buildEmbedWidgetUrl(SITE, ID, { book: true, view: "calendar" })).toBe(
      `${SITE}/embed/book/${ID}`,
    );
    expect(
      buildEmbedWidgetUrl(SITE, ID, { calendar: true, view: "calendar" }),
    ).toBe(`${SITE}/embed/calendar/${ID}`);
  });
});

describe("buildTicketsSdkSnippet", () => {
  it("emits no dangling comma when there are no optional props", () => {
    const snippet = buildTicketsSdkSnippet(SITE, ID);
    expect(snippet).toContain(`    container: "#hf-embed-${ID}"\n  });`);
    expect(snippet).not.toContain("scope");
    expect(snippet).not.toContain("theme");
  });

  it("comma-joins optional theme and scope props", () => {
    const snippet = buildTicketsSdkSnippet(SITE, ID, {
      themeEntries: [["brandColor", "FF0000"]],
      scope: "venues",
    });
    expect(snippet).toContain(`    container: "#hf-embed-${ID}",`);
    expect(snippet).toContain(`    theme: { brandColor: "FF0000" },`);
    expect(snippet).toContain(`    scope: "venues"\n  });`);
  });

  it("starts with the async-safe stub so the SDK can drain the queue", () => {
    expect(buildTicketsSdkSnippet(SITE, ID).startsWith(HF_STUB_LINE)).toBe(true);
  });

  it("emits the SDK view option for calendar only — this is the calendar's first SDK distribution", () => {
    const calendar = buildTicketsSdkSnippet(SITE, ID, { view: "calendar" });
    expect(calendar).toContain(`    container: "#hf-embed-${ID}",`);
    expect(calendar).toContain(`    view: "calendar"\n  });`);
    expect(buildTicketsSdkSnippet(SITE, ID, { view: "list" })).not.toContain(
      "view",
    );
  });
});

describe("buildTicketsModalSnippet", () => {
  it("carries scope through to the modal variant", () => {
    const snippet = buildTicketsModalSnippet(SITE, ID, { scope: "all" });
    expect(snippet).toContain(`    triggerText: "Get Tickets",`);
    expect(snippet).toContain(`    scope: "all"\n  });`);
  });

  it("keeps the trailing prop comma-free when scope is default", () => {
    const snippet = buildTicketsModalSnippet(SITE, ID, { scope: "own" });
    expect(snippet).toContain(`    triggerText: "Get Tickets"\n  });`);
  });

  it("renames the trigger and carries the view for a calendar modal", () => {
    const snippet = buildTicketsModalSnippet(SITE, ID, { view: "calendar" });
    expect(snippet).toContain(`    triggerText: "View calendar",`);
    expect(snippet).toContain(`    view: "calendar"\n  });`);
  });
});

describe("buildTicketsIframeSnippet", () => {
  it("puts scope in the iframe src", () => {
    const snippet = buildTicketsIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: 600,
      options: { scope: "venues" },
    });
    expect(snippet).toContain(`src="${SITE}/embed/${ID}?scope=venues"`);
    expect(snippet).toContain(`height="600"`);
  });

  it("pins the calendar view on the CANONICAL route, keeping resize + payment", () => {
    // FR-008: the events tab emits ONE snippet set; the calendar is a param on
    // /embed/<id>, not the legacy /embed/calendar/ path.
    const snippet = buildTicketsIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: CALENDAR_DEFAULT_HEIGHT,
      options: { view: "calendar" },
    });
    expect(snippet).toContain(`src="${SITE}/embed/${ID}?view=calendar"`);
    expect(snippet).toContain(`height="${CALENDAR_DEFAULT_HEIGHT}"`);
    expect(snippet).toContain(`allow="payment"`);
    // hf-resize.js matches iframe[src*="/embed/"], so ?view= auto-resizes too.
    expect(snippet).toContain(
      `<script src="${SITE}/embed/hf-resize.js" data-origin="${SITE}" async></script>`,
    );
  });
});

describe("buildBookingSnippet", () => {
  // The exact shape BookingEmbedSection shipped before the builders were
  // shared — both doors onto a place subject must keep emitting this.
  it("matches the shipped booking-button snippet byte-for-byte", () => {
    expect(buildBookingSnippet(SITE, ID)).toBe(
      [
        HF_STUB_LINE,
        `<script src="${SITE}/embed/hf-embed.js" async></script>`,
        `<div id="hf-book-${ID}"></div>`,
        `<script>`,
        `  HF.createWidget({`,
        `    embedId: "${ID}",`,
        `    container: "#hf-book-${ID}",`,
        `    widget: "booking",`,
        `    mode: "modal",`,
        `    triggerText: "Request to book"`,
        `  });`,
        `</script>`,
      ].join("\n"),
    );
  });

  it("carries theme overrides", () => {
    const snippet = buildBookingSnippet(SITE, ID, {
      themeEntries: [["brandColor", "00FF00"]],
    });
    expect(snippet).toContain(`    triggerText: "Request to book",`);
    expect(snippet).toContain(`    theme: { brandColor: "00FF00" }\n  });`);
  });
});

describe("buildBookingIframeSnippet", () => {
  it("targets /embed/book/ with the given height and the resize script", () => {
    const snippet = buildBookingIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: BOOKING_FORM_DEFAULT_HEIGHT,
    });
    expect(snippet).toContain(`src="${SITE}/embed/book/${ID}"`);
    expect(snippet).toContain(`height="${BOOKING_FORM_DEFAULT_HEIGHT}"`);
    expect(snippet).toContain(`title="Request to book"`);
    expect(snippet).toContain(`id="hf-embed-${ID}"`);
    expect(snippet).toContain(
      `<script src="${SITE}/embed/hf-resize.js" data-origin="${SITE}" async></script>`,
    );
  });

  it("omits allow=\"payment\" — the booking form takes no payment", () => {
    const snippet = buildBookingIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: BOOKING_FORM_DEFAULT_HEIGHT,
    });
    expect(snippet).not.toContain(`allow="payment"`);
  });

  it("carries theme overrides in the URL", () => {
    const snippet = buildBookingIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: 600,
      options: { themeEntries: [["brandColor", "00FF00"]] },
    });
    expect(snippet).toContain(`src="${SITE}/embed/book/${ID}?brandColor=00FF00"`);
  });

  it("never emits scope, even if smuggled past the Omit type", () => {
    const snippet = buildBookingIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: 600,
      // Untyped callers (JS hosts) could still pass scope — it must not leak.
      options: { scope: "all" } as Omit<EmbedSnippetOptions, "scope">,
    });
    expect(snippet).toContain(`src="${SITE}/embed/book/${ID}"`);
    expect(snippet).not.toContain("scope");
  });
});

describe("buildCalendarIframeSnippet", () => {
  it("targets /embed/calendar/ and keeps the resize script + payment allow", () => {
    const snippet = buildCalendarIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: CALENDAR_DEFAULT_HEIGHT,
    });
    expect(snippet).toContain(`src="${SITE}/embed/calendar/${ID}"`);
    expect(snippet).toContain(`height="${CALENDAR_DEFAULT_HEIGHT}"`);
    // The calendar drives the SAME in-iframe checkout — payment must be
    // allowed, and hf-resize.js (matches src*="/embed/") must be included.
    expect(snippet).toContain(`allow="payment"`);
    expect(snippet).toContain(
      `<script src="${SITE}/embed/hf-resize.js" data-origin="${SITE}" async></script>`,
    );
  });

  it("carries theme entries and a non-default scope on the URL", () => {
    const snippet = buildCalendarIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: 700,
      options: { themeEntries: [["brandColor", "00FF00"]], scope: "all" },
    });
    expect(snippet).toContain(
      `src="${SITE}/embed/calendar/${ID}?brandColor=00FF00&scope=all"`,
    );
  });

  it("omits the default 'own' scope from the URL", () => {
    const snippet = buildCalendarIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: 700,
      options: { scope: "own" },
    });
    expect(snippet).toContain(`src="${SITE}/embed/calendar/${ID}"`);
  });
});

describe("buildCalendarReactSnippet", () => {
  it("renders the prebuilt src with a numeric height and calendar title", () => {
    const src = buildEmbedWidgetUrl(SITE, ID, { calendar: true, scope: "all" });
    const snippet = buildCalendarReactSnippet({ embedId: ID, src, height: 700 });
    expect(snippet).toContain(`src="${SITE}/embed/calendar/${ID}?scope=all"`);
    expect(snippet).toContain(`height={700}`);
    expect(snippet).toContain(`title="Events calendar"`);
    expect(snippet).toContain(`allow="payment"`);
  });
});

describe("buildMembershipsIframeSnippet", () => {
  it("targets /embed/memberships/ with the resize script and NO allow=payment", () => {
    const snippet = buildMembershipsIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: MEMBERSHIPS_DEFAULT_HEIGHT,
    });
    expect(snippet).toContain(`src="${SITE}/embed/memberships/${ID}"`);
    expect(snippet).toContain(`height="${MEMBERSHIPS_DEFAULT_HEIGHT}"`);
    expect(snippet).toContain(`title="Membership"`);
    expect(snippet).toContain(`id="hf-embed-${ID}"`);
    // The widget takes no payment — joining links out to the /p page.
    expect(snippet).not.toContain(`allow="payment"`);
    expect(snippet).toContain(
      `<script src="${SITE}/embed/hf-resize.js" data-origin="${SITE}" async></script>`,
    );
  });

  it("carries theme overrides in the iframe URL", () => {
    const snippet = buildMembershipsIframeSnippet({
      siteUrl: SITE,
      embedId: ID,
      height: 480,
      options: { themeEntries: [["brandColor", "00FF00"]] },
    });
    expect(snippet).toContain(
      `src="${SITE}/embed/memberships/${ID}?brandColor=00FF00"`,
    );
  });
});

describe("buildEmbedWidgetUrl — memberships", () => {
  it("targets the memberships widget when the flag is set", () => {
    expect(buildEmbedWidgetUrl(SITE, ID, { memberships: true })).toBe(
      `${SITE}/embed/memberships/${ID}`,
    );
  });
});

describe("buildEmbedWidgetUrl — calendar", () => {
  it("targets the calendar view when calendar is set", () => {
    expect(buildEmbedWidgetUrl(SITE, ID, { calendar: true })).toBe(
      `${SITE}/embed/calendar/${ID}`,
    );
  });

  it("book wins over calendar if both are (incorrectly) set", () => {
    // Defensive pin: the two flags are mutually exclusive at every call site;
    // if that ever breaks, the booking form is the safer landing.
    expect(buildEmbedWidgetUrl(SITE, ID, { calendar: true, book: true })).toBe(
      `${SITE}/embed/book/${ID}`,
    );
  });
});

describe("parseEmbedScope", () => {
  it("accepts every valid scope", () => {
    expect(parseEmbedScope("own")).toBe("own");
    expect(parseEmbedScope("venues")).toBe("venues");
    expect(parseEmbedScope("all")).toBe("all");
  });

  it("falls back to the default on junk rather than throwing", () => {
    // A live widget must never white-screen on a hand-edited URL.
    expect(parseEmbedScope("nonsense")).toBe("own");
    expect(parseEmbedScope("")).toBe("own");
    expect(parseEmbedScope(null)).toBe("own");
    expect(parseEmbedScope(undefined)).toBe("own");
    expect(parseEmbedScope("OWN")).toBe("own");
  });
});

import { describe, expect, it } from "vitest";

import {
  confirmedDomainFor,
  displayForFormat,
  formatForDisplay,
  isDomainAlreadyListed,
  normaliseEmbedDomain,
  resizeNoteFor,
  type SnippetFormat,
} from "../embed-format.helpers";

describe("displayForFormat", () => {
  it("maps every inline format to Inline and Modal to Button", () => {
    expect(displayForFormat("html")).toBe("inline");
    expect(displayForFormat("react")).toBe("inline");
    expect(displayForFormat("sdk")).toBe("inline");
    expect(displayForFormat("modal")).toBe("modal");
  });
});

describe("formatForDisplay", () => {
  it("Inline selects HTML; Button selects Modal", () => {
    expect(formatForDisplay("inline")).toBe("html");
    expect(formatForDisplay("modal")).toBe("modal");
  });

  it("round-trips: a Display pick never lands on a format of the other kind", () => {
    for (const display of ["inline", "modal"] as const) {
      expect(displayForFormat(formatForDisplay(display))).toBe(display);
    }
  });
});

describe("resizeNoteFor", () => {
  const events = (format: SnippetFormat) =>
    resizeNoteFor({ variant: "events", format, bookingMode: "modal" });

  it("events: HTML relies on hf-resize.js, SDK sizes itself, React is fixed, Modal has no frame", () => {
    expect(events("html")).toBe("hfResize");
    expect(events("sdk")).toBe("sdk");
    expect(events("react")).toBe("fixedReact");
    expect(events("modal")).toBeNull();
  });

  it("booking: the inline form resizes, the button has no frame (format is ignored)", () => {
    expect(
      resizeNoteFor({
        variant: "booking",
        format: "react",
        bookingMode: "inline",
      }),
    ).toBe("hfResize");
    expect(
      resizeNoteFor({
        variant: "booking",
        format: "html",
        bookingMode: "modal",
      }),
    ).toBeNull();
  });

  it("memberships always resizes via hf-resize.js", () => {
    expect(
      resizeNoteFor({
        variant: "memberships",
        format: "modal",
        bookingMode: "modal",
      }),
    ).toBe("hfResize");
  });
});

describe("normaliseEmbedDomain (mirrors core coerceEmbedDomainToHostname)", () => {
  it("reduces scheme, path, port, trailing slash and case to the hostname", () => {
    expect(normaliseEmbedDomain("https://Foo.com/events?x=1")).toBe("foo.com");
    expect(normaliseEmbedDomain("foo.com/")).toBe("foo.com");
    expect(normaliseEmbedDomain("  FOO.com:8080 ")).toBe("foo.com");
    expect(normaliseEmbedDomain("www.foo.com")).toBe("www.foo.com");
  });

  it("lowercases before parsing, like the server schema (non-special schemes keep case in URL)", () => {
    expect(normaliseEmbedDomain("myapp://Foo.com")).toBe("foo.com");
  });

  it("returns null for empty or unparseable input", () => {
    expect(normaliseEmbedDomain("   ")).toBeNull();
    expect(normaliseEmbedDomain("http://")).toBeNull();
  });
});

describe("isDomainAlreadyListed", () => {
  const listed = [{ domain: "foo.com" }];

  it("matches a listed hostname typed with a scheme, path or capitals", () => {
    expect(isDomainAlreadyListed("https://foo.com", listed)).toBe(true);
    expect(isDomainAlreadyListed("FOO.com/page", listed)).toBe(true);
  });

  it("ignores REVOKED rows: re-adding a revoked domain counts as new", () => {
    expect(
      isDomainAlreadyListed("foo.com", [
        { domain: "foo.com", status: "REVOKED" },
      ]),
    ).toBe(false);
    expect(
      isDomainAlreadyListed("foo.com", [
        { domain: "foo.com", status: "REVOKED" },
        { domain: "foo.com", status: "ACTIVE" },
      ]),
    ).toBe(true);
  });

  it("does not match a different host or empty input", () => {
    expect(isDomainAlreadyListed("bar.com", listed)).toBe(false);
    expect(isDomainAlreadyListed("www.foo.com", listed)).toBe(false);
    expect(isDomainAlreadyListed("", listed)).toBe(false);
  });
});

describe("confirmedDomainFor", () => {
  const added = { subjectKey: "organization:o1", domain: "foo.com" };

  it("shows the domain while its row is active under the same subject", () => {
    expect(
      confirmedDomainFor(added, "organization:o1", [{ domain: "foo.com" }]),
    ).toBe("foo.com");
  });

  it("hides under a different subject", () => {
    expect(
      confirmedDomainFor(added, "event:e1", [{ domain: "foo.com" }]),
    ).toBeNull();
  });

  it("hides once the row is revoked (no longer active)", () => {
    expect(
      confirmedDomainFor(added, "organization:o1", [{ domain: "bar.com" }]),
    ).toBeNull();
  });

  it("hides when nothing was added", () => {
    expect(
      confirmedDomainFor(null, "organization:o1", [{ domain: "foo.com" }]),
    ).toBeNull();
  });
});

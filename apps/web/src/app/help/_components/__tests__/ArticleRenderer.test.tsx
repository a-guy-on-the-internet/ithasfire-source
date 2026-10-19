import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ArticleRenderer } from "../ArticleRenderer";
import { slugifyHeading } from "../../_lib/heading-slug";

/** Rendered through the real plugin chain, like the help article page. */
function headingIds(markdown: string): string[] {
  const html = renderToStaticMarkup(<ArticleRenderer content={markdown} />);
  return [...html.matchAll(/<h[1-6][^>]*\sid="([^"]*)"/g)].map((m) => m[1]!);
}

describe("ArticleRenderer heading ids", () => {
  it("gives h2 and h3 GitHub-style ids", () => {
    expect(
      headingIds("## Refunds and chargebacks\n\n### If a dispute is lost"),
    ).toEqual(["refunds-and-chargebacks", "if-a-dispute-is-lost"]);
  });

  it("slugs the text of bold, code and link children", () => {
    expect(headingIds("## Set **a cap**, or `instant` [approval](/x)")).toEqual(
      ["set-a-cap-or-instant-approval"],
    );
  });

  it("strips punctuation but keeps hyphens", () => {
    expect(headingIds("## Why is part of my payout held back?")).toEqual([
      "why-is-part-of-my-payout-held-back",
    ]);
    expect(headingIds("## Hiding a venue's address")).toEqual([
      "hiding-a-venues-address",
    ]);
    expect(headingIds("## Password-protect an event")).toEqual([
      "password-protect-an-event",
    ]);
  });

  it("dedupes repeated headings within one article", () => {
    expect(headingIds("## Fees\n\n## Fees\n\n### Fees")).toEqual([
      "fees",
      "fees-1",
      "fees-2",
    ]);
  });

  it("does not carry dedupe state across renders", () => {
    expect(headingIds("## Fees")).toEqual(["fees"]);
    expect(headingIds("## Fees")).toEqual(["fees"]);
  });

  it("keeps an explicit id from raw HTML", () => {
    expect(headingIds('<h2 id="custom">Other text</h2>')).toEqual(["custom"]);
  });
});

describe("slugifyHeading", () => {
  it("matches GitHub for non-ASCII and runs of spaces", () => {
    expect(slugifyHeading("Café  Menü")).toBe("café--menü");
    expect(slugifyHeading("Spaces & calendars: which is which")).toBe(
      "spaces--calendars-which-is-which",
    );
  });
});

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ArticleRenderer } from "../ArticleRenderer";

/**
 * Rendered through the REAL renderer — same remark/rehype plugin chain and the
 * same `div[data-callout]` → `Callout` override the help pages use — so a
 * regression here is a regression on the page, not on an isolated AST.
 */
function render(markdown: string): string {
  return renderToStaticMarkup(<ArticleRenderer content={markdown} />);
}

/** Visible text only, with the tag soup and the "Tip"/"Heads up" chip removed. */
function calloutText(html: string, kind: string): string | null {
  const marker = html.indexOf(`data-callout-rendered="${kind}"`);
  if (marker === -1) return null;
  // Past the `<aside …>` opening tag, so its attributes don't survive the
  // tag strip below as stray text.
  const start = html.indexOf(">", marker) + 1;
  const end = html.indexOf("</aside>", start);
  const body = html.slice(start, end === -1 ? undefined : end);
  return body
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("callout rendering", () => {
  it("renders a plain fence as a callout", () => {
    const html = render(":::tip\nKeep these to one paragraph.\n:::");
    expect(calloutText(html, "tip")).toBe("TipKeep these to one paragraph.");
    expect(html).not.toContain(":::");
  });

  it.each(["tip", "warning", "action"] as const)(
    "renders the %s variant",
    (kind) => {
      const html = render(`:::${kind}\nBody.\n:::`);
      expect(html).toContain(`data-callout-rendered="${kind}"`);
    },
  );

  /**
   * The regression this file exists for. The previous plugin flattened the
   * fence's children to a string keeping only `text` and `break` nodes and
   * mapping everything else to `""`, so every bolded phrase and every link
   * inside a callout was DELETED, not merely unstyled: "Requests expire **14
   * days** after they're sent" shipped as "Requests expire after they're
   * sent". ~25 shipped callouts were affected.
   */
  it("keeps bold text inside a callout", () => {
    const html = render(
      ":::warning\nRequests expire **14 days** after they're sent.\n:::",
    );
    expect(calloutText(html, "warning")).toContain(
      "Requests expire 14 days after they",
    );
    expect(html).toContain("14 days</strong>");
  });

  it("keeps links inside a callout", () => {
    const html = render(
      ":::tip\nSee [refunds](/help/buying-tickets/refunds) for the rules.\n:::",
    );
    expect(calloutText(html, "tip")).toContain("See refunds for the rules.");
    expect(html).toContain('href="/help/buying-tickets/refunds"');
  });

  it("keeps emphasis and inline code inside a callout", () => {
    const html = render(
      ":::tip\nCan list *fewer* rows — set `brandColor` first.\n:::",
    );
    expect(calloutText(html, "tip")).toContain(
      "Can list fewer rows — set brandColor first.",
    );
    expect(html).toContain("fewer</em>");
    expect(html).toContain("brandColor</code>");
  });

  it("keeps markup that opens the body", () => {
    const html = render(":::tip\n**Save** as you go.\n:::");
    expect(calloutText(html, "tip")).toBe("TipSave as you go.");
  });

  it("keeps markup that closes the body", () => {
    const html = render(":::tip\nStart with **Add role**\n:::");
    expect(calloutText(html, "tip")).toBe("TipStart with Add role");
  });

  /** Close marker after a hard break (previous line ended with two spaces). */
  it("handles a hard break before the close marker", () => {
    const html = render(":::tip\nFirst **line**  \n:::");
    expect(calloutText(html, "tip")).toContain("First line");
    expect(html).not.toContain(":::");
  });

  it("renders a multi-line body as one callout", () => {
    const html = render(":::tip\nOne **two**\nthree four.\n:::");
    expect((html.match(/data-callout-rendered/g) ?? []).length).toBe(1);
    expect(calloutText(html, "tip")).toContain("One two three four.");
  });

  it("leaves ordinary paragraphs alone", () => {
    const html = render("Just a **paragraph** with a fence-free body.");
    expect(html).not.toContain("data-callout-rendered");
    expect(html).toContain("paragraph</strong>");
  });

  it("leaves an unterminated fence alone rather than half-transforming it", () => {
    const html = render(":::tip\nNo close marker here.");
    expect(html).not.toContain("data-callout-rendered");
    expect(html).toContain(":::tip");
  });

  it("ignores an unknown fence kind", () => {
    const html = render(":::danger\nNot a callout kind.\n:::");
    expect(html).not.toContain("data-callout-rendered");
  });
});

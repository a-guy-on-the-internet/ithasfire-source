import { describe, expect, it } from "vitest";
import type { EventBody, EventPageBlock } from "@th/schema";

import { eventBodyToHtml } from "../event-body-to-html";

/**
 * eventBodyToHtml — escaping of user-authored block values.
 *
 * The output of this function is injected into the public event page via
 * dangerouslySetInnerHTML, and bodies can be proposed by anonymous
 * visitors, so image alt/src and CTA href/label must never reach the HTML
 * string unescaped.
 */

function bodyWith(blocks: EventPageBlock[]): EventBody {
  return { layoutId: "default", blocks };
}

describe("eventBodyToHtml escaping", () => {
  it("escapes image alt so attribute breakout is inert", () => {
    const html = eventBodyToHtml(
      bodyWith([
        {
          id: "b1",
          type: "image",
          asset: { assetId: "a1" },
          alt: 'x" onmouseover="alert(1)',
        },
      ]),
      { a1: "https://cdn.example.com/a.jpg" },
    );

    expect(html).toContain('alt="x&quot; onmouseover=&quot;alert(1)"');
    expect(html).not.toContain('onmouseover="alert');
  });

  it("escapes image src attribute values", () => {
    const html = eventBodyToHtml(
      bodyWith([{ id: "b1", type: "image", asset: { assetId: "a1" } }]),
      { a1: 'https://cdn.example.com/a.jpg?w=100&h=50" onerror="alert(1)' },
    );

    expect(html).toContain(
      'src="https://cdn.example.com/a.jpg?w=100&amp;h=50&quot; onerror=&quot;alert(1)"',
    );
    expect(html).not.toContain('onerror="alert');
  });

  it("escapes CTA labels so element injection is inert", () => {
    const html = eventBodyToHtml(
      bodyWith([
        {
          id: "b1",
          type: "cta",
          label: "<img src=x onerror=alert(1)>",
          href: "https://example.com",
          variant: "primary",
        },
      ]),
    );

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;</a>");
    expect(html).not.toContain("<img");
  });

  it("neutralizes javascript: CTA hrefs to #", () => {
    const html = eventBodyToHtml(
      bodyWith([
        {
          id: "b1",
          type: "cta",
          label: "Click",
          href: "javascript:alert(1)",
          variant: "primary",
        },
      ]),
    );

    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });

  it("neutralizes backslash protocol-relative CTA hrefs to #", () => {
    const html = eventBodyToHtml(
      bodyWith([
        {
          id: "b1",
          type: "cta",
          label: "Click",
          href: "/" + String.fromCharCode(92) + "evil.example.com",
          variant: "primary",
        },
      ]),
    );

    expect(html).toContain('href="#"');
    expect(html).not.toContain("evil.example.com");
  });

  it("preserves safe CTA hrefs (attribute-encoded)", () => {
    const html = eventBodyToHtml(
      bodyWith([
        {
          id: "b1",
          type: "cta",
          label: "Tickets",
          href: "https://example.com/tickets?a=1&b=2",
          variant: "secondary",
        },
        {
          id: "b2",
          type: "cta",
          label: "Lineup",
          href: "/events/foo-bar",
          variant: "primary",
        },
      ]),
    );

    expect(html).toContain('href="https://example.com/tickets?a=1&amp;b=2"');
    expect(html).toContain('href="/events/foo-bar"');
  });
});

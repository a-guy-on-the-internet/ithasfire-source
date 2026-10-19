import { describe, expect, it } from "vitest";

import { extractSuggestionBodyPreview } from "../suggestion-body-preview";

const richTextBlock = (texts: string[]) => ({
  type: "richText",
  doc: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: texts.map((text) => ({ type: "text", text })),
      },
    ],
  },
});

describe("extractSuggestionBodyPreview", () => {
  it("extracts text from a v1 sections body", () => {
    const body = {
      version: 1,
      sections: [
        {
          layout: {
            type: "singleColumn",
            columns: [
              { blocks: [richTextBlock(["Open mic", "every Tuesday"])] },
            ],
          },
        },
      ],
    };
    expect(extractSuggestionBodyPreview(body)).toBe("Open mic every Tuesday");
  });

  it("extracts text from a legacy flat-blocks body, including cta labels and image alt", () => {
    const body = {
      blocks: [
        richTextBlock(["Bring an instrument."]),
        { type: "cta", label: "Sign up", href: "https://example.com" },
        { type: "image", asset: { assetId: "a" }, alt: "Stage photo" },
      ],
    };
    expect(extractSuggestionBodyPreview(body)).toBe(
      "Bring an instrument. Sign up Stage photo",
    );
  });

  it("includes an image block's caption, which the page shows under the image", () => {
    const body = {
      blocks: [
        {
          type: "richText",
          doc: {
            type: "doc",
            content: [
              {
                type: "imageBlock",
                attrs: { src: "https://x/a.jpg", caption: "Doors at seven" },
              },
              {
                type: "imageBlock",
                attrs: { src: "https://x/b.jpg", caption: null },
              },
            ],
          },
        },
      ],
    };
    expect(extractSuggestionBodyPreview(body)).toBe("Doors at seven");
  });

  it("truncates long text with an ellipsis", () => {
    const body = { blocks: [richTextBlock(["word ".repeat(100)])] };
    const preview = extractSuggestionBodyPreview(body, 50);
    expect(preview).not.toBeNull();
    expect(preview!.length).toBeLessThanOrEqual(51);
    expect(preview!.endsWith("…")).toBe(true);
  });

  it("returns null for null, non-objects, and text-free bodies", () => {
    expect(extractSuggestionBodyPreview(null)).toBeNull();
    expect(extractSuggestionBodyPreview("plain string")).toBeNull();
    expect(
      extractSuggestionBodyPreview({ blocks: [{ type: "spacer", size: "md" }] }),
    ).toBeNull();
  });

  it("never throws on malformed structures", () => {
    expect(
      extractSuggestionBodyPreview({
        sections: [{ layout: { columns: [{ blocks: [null, 42, "x"] }] } }],
        blocks: "not-an-array",
      }),
    ).toBeNull();
  });
});

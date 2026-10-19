import { describe, expect, it } from "vitest";

import { normalizeEventBodyToRendered } from "../normalize";

describe("normalizeEventBodyToRendered", () => {
  it("normalizes legacy body into v1 sections", () => {
    const legacy = {
      layoutId: "default",
      blocks: [
        {
          id: "b1",
          type: "spacer",
          size: "md",
        },
      ],
    };

    const result = normalizeEventBodyToRendered(legacy);
    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.body.version).toBe(1);
    expect(result.body.sections).toHaveLength(1);
    const section = result.body.sections[0];
    expect(section).toBeTruthy();
    if (!section) return;

    expect(section.layout.type).toBe("singleColumn");
    expect(section.layout.columns).toHaveLength(1);
    const col = section.layout.columns[0];
    expect(col).toBeTruthy();
    if (!col) return;

    expect(col.blocks).toHaveLength(1);
    const block = col.blocks[0];
    expect(block).toBeTruthy();
    if (!block) return;

    expect(block.type).toBe("spacer");
  });

  it("keeps v1 two-column ratio and blocks", () => {
    const v1 = {
      version: 1,
      sections: [
        {
          id: "s1",
          kind: "section",
          style: {
            background: "default",
            density: "normal",
            maxWidth: "prose",
            textAlign: "left",
          },
          layout: {
            type: "twoColumn",
            ratio: "33/67",
            columns: [
              {
                blocks: [
                  {
                    id: "l1",
                    type: "cta",
                    label: "Buy",
                    href: "https://example.com",
                  },
                ],
              },
              { blocks: [{ id: "r1", type: "spacer", size: "lg" }] },
            ],
          },
        },
      ],
    };

    const result = normalizeEventBodyToRendered(v1);
    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.body.sections).toHaveLength(1);
    const s1 = result.body.sections[0];
    expect(s1).toBeTruthy();
    if (!s1) return;

    expect(s1.layout.type).toBe("twoColumn");
    if (s1.layout.type !== "twoColumn") return;

    expect(s1.layout.ratio).toBe("33/67");
    expect(s1.layout.columns).toHaveLength(2);
    const left = s1.layout.columns[0];
    const right = s1.layout.columns[1];
    expect(left?.blocks?.[0]?.type).toBe("cta");
    expect(right?.blocks?.[0]?.type).toBe("spacer");
  });

  it("handles unknown block kinds without throwing", () => {
    const v1 = {
      version: 1,
      sections: [
        {
          id: "s1",
          kind: "section",
          style: {
            background: "default",
            density: "normal",
            maxWidth: "prose",
            textAlign: "left",
          },
          layout: {
            type: "singleColumn",
            columns: [
              {
                blocks: [
                  {
                    id: "x",
                    type: "mystery",
                  },
                ],
              },
            ],
          },
        },
      ],
    };

    const result = normalizeEventBodyToRendered(v1);
    expect(result.ok).toBe(true);

    if (!result.ok) return;

    expect(result.body.sections).toHaveLength(1);
    const section = result.body.sections[0];
    expect(section).toBeTruthy();
    if (!section) return;

    expect(section.layout.columns).toHaveLength(1);
    const block = section.layout.columns[0]?.blocks?.[0];
    expect(block?.type).toBe("unknown");
  });
});

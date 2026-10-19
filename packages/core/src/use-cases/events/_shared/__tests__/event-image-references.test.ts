import { describe, expect, it } from "vitest";

import { collectReferencedImageIds } from "../event-image-references";

/** The id set alone, for the majority of cases that don't care about truncation. */
const idsOf = (body: unknown): Set<string> =>
  collectReferencedImageIds(body).ids;

/**
 * This walker is a garbage-collection oracle: `sweepOrphanedUploads` deletes
 * blobs it does not return. Every test here is really asserting the same
 * asymmetry — a miss is unrecoverable data loss, an over-collection costs a few
 * KB — so the suite leans hard on "does it still find the id when the shape is
 * strange".
 */
describe("collectReferencedImageIds", () => {
  it("returns nothing for empty / non-object bodies", () => {
    expect(idsOf(null)).toEqual(new Set());
    expect(idsOf(undefined)).toEqual(new Set());
    expect(idsOf("a string")).toEqual(new Set());
    expect(idsOf(42)).toEqual(new Set());
    expect(idsOf({})).toEqual(new Set());
  });

  it("finds an id in the v1 sections → columns → blocks shape", () => {
    const body = {
      sections: [
        {
          layout: {
            columns: [
              { blocks: [{ type: "image", asset: { assetId: "img-1" } }] },
            ],
          },
        },
      ],
    };
    expect(idsOf(body)).toEqual(new Set(["img-1"]));
  });

  it("finds an id inside a nested ProseMirror doc", () => {
    const body = {
      sections: [
        {
          layout: {
            columns: [
              {
                blocks: [
                  {
                    type: "richText",
                    doc: {
                      type: "doc",
                      content: [
                        {
                          type: "paragraph",
                          content: [
                            { type: "imageBlock", attrs: { imageId: "img-2" } },
                          ],
                        },
                      ],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    expect(idsOf(body)).toEqual(new Set(["img-2"]));
  });

  it("finds every id across a mixed body", () => {
    const body = {
      sections: [
        {
          layout: {
            columns: [
              {
                blocks: [
                  { type: "image", asset: { assetId: "a" } },
                  {
                    type: "richText",
                    doc: { content: [{ type: "imageBlock", attrs: { imageId: "b" } }] },
                  },
                ],
              },
            ],
          },
        },
      ],
    };
    expect(idsOf(body)).toEqual(new Set(["a", "b"]));
  });

  // ── The shape-agnostic guarantees ────────────────────────────────────────

  it("finds ids in a shape it has never seen", () => {
    const body = {
      version: 99,
      widgets: [{ kind: "gallery", items: [{ imageId: "future-1" }] }],
    };
    expect(idsOf(body)).toEqual(new Set(["future-1"]));
  });

  it("finds an id at the very top level", () => {
    expect(idsOf({ imageId: "top" })).toEqual(
      new Set(["top"]),
    );
  });

  it("finds ids buried under arbitrary intermediate keys", () => {
    const body = { a: { b: { c: [{ d: { assetId: "deep" } }] } } };
    expect(idsOf(body)).toEqual(new Set(["deep"]));
  });

  it("collects a heroImageId embedded in the body too", () => {
    expect(idsOf({ heroImageId: "hero-1" })).toEqual(
      new Set(["hero-1"]),
    );
  });

  it("deduplicates repeated references", () => {
    const body = { a: { imageId: "x" }, b: { imageId: "x" } };
    expect(idsOf(body)).toEqual(new Set(["x"]));
  });

  // ── Robustness: a malformed body must not throw or silently return empty ──

  it("ignores non-string and blank reference values", () => {
    const body = {
      one: { imageId: 123 },
      two: { imageId: null },
      three: { imageId: "" },
      four: { imageId: "   " },
      five: { imageId: "real" },
    };
    expect(idsOf(body)).toEqual(new Set(["real"]));
  });

  it("trims surrounding whitespace so a padded id still matches", () => {
    expect(idsOf({ imageId: "  padded  " })).toEqual(
      new Set(["padded"]),
    );
  });

  it("survives a cyclic body without hanging", () => {
    const body: Record<string, unknown> = { imageId: "cyclic-1" };
    body.self = body;
    expect(idsOf(body)).toEqual(new Set(["cyclic-1"]));
  });

  it("walks arrays of arrays", () => {
    expect(idsOf({ rows: [[{ imageId: "grid-1" }]] })).toEqual(
      new Set(["grid-1"]),
    );
  });

  // ── Truncation is REPORTED, never silently swallowed ─────────────────────
  //
  // A partial walk returns a partial id set, which is indistinguishable from
  // "references nothing" — and that difference is a deletion. So the depth cap
  // must be visible to the caller.

  it("reports truncated:false for an ordinary body", () => {
    const result = collectReferencedImageIds({ a: { imageId: "x" } });
    expect(result.truncated).toBe(false);
  });

  it("survives a body nested past the depth cap without throwing", () => {
    let node: Record<string, unknown> = { imageId: "too-deep" };
    for (let i = 0; i < 200; i++) node = { child: node };
    expect(() => collectReferencedImageIds(node)).not.toThrow();
  });

  it("reports truncated:true when the depth cap cut the walk short", () => {
    let node: Record<string, unknown> = { imageId: "too-deep" };
    for (let i = 0; i < 200; i++) node = { child: node };

    const result = collectReferencedImageIds(node);

    // The id was NOT found — and the caller is told so, rather than being
    // handed an empty set that reads like proof of non-reference.
    expect(result.ids.has("too-deep")).toBe(false);
    expect(result.truncated).toBe(true);
  });

  it("still collects shallow ids while flagging a deep sibling branch", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 200; i++) deep = { child: deep };

    const result = collectReferencedImageIds({
      shallow: { imageId: "found" },
      deep,
    });

    expect(result.ids.has("found")).toBe(true);
    expect(result.truncated).toBe(true);
  });

  // ── Forward-compatibility of the key match ───────────────────────────────

  it("matches image-reference keys it was not explicitly taught", () => {
    const body = {
      a: { posterImageId: "poster-1" },
      b: { coverAssetId: "cover-1" },
      c: { mediaId: "media-1" },
      d: { backgroundImageID: "bg-1" },
    };
    expect(idsOf(body)).toEqual(
      new Set(["poster-1", "cover-1", "media-1", "bg-1"]),
    );
  });

  it("collects every id from a plural/array reference key", () => {
    // A gallery block is the most likely next image-bearing shape.
    const body = {
      widgets: [{ type: "gallery", imageIds: ["g-1", "g-2", "g-3"] }],
    };
    expect(idsOf(body)).toEqual(new Set(["g-1", "g-2", "g-3"]));
  });

  it("matches snake_case reference keys", () => {
    expect(idsOf({ a: { hero_image_id: "snake-1" } })).toEqual(
      new Set(["snake-1"]),
    );
  });

  it("collects BOTH halves of a mixed string/object reference array", () => {
    // The trap: bailing out of the descent because one element was a string
    // would report the object's id as positively unreferenced — and delete it.
    const body = {
      mediaIds: ["img-a", { assetId: "img-b", crop: { x: 0 } }],
    };
    expect(idsOf(body)).toEqual(new Set(["img-a", "img-b"]));
  });

  it("collects from a bare collection key holding string ids", () => {
    expect(idsOf({ gallery: { images: ["bare-1", "bare-2"] } })).toEqual(
      new Set(["bare-1", "bare-2"]),
    );
  });

  it("keeps walking a reference key whose value is an object, not a string", () => {
    // Unrecognised value shape under a matching key must not be read as
    // "references nothing" — recurse instead.
    const body = { imageId: { nested: { imageId: "buried" } } };
    expect(idsOf(body)).toEqual(new Set(["buried"]));
  });

  it("does not match unrelated id-shaped keys", () => {
    const body = { a: { eventId: "evt-1" }, b: { humanId: "h-1" } };
    expect(idsOf(body)).toEqual(new Set());
  });
});

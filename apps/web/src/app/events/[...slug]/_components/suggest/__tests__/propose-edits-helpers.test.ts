import { describe, expect, it } from "vitest";

import type { ProseMirrorDoc } from "@th/schema";

import { toDateTimeLocalValue } from "@/app/admin/[slug]/events/new/_components/event-builder-helpers";

import {
  buildProposedContent,
  computeProposeDiff,
  extractRichTextDoc,
  isEmptyRichTextDoc,
  jsonDeepEqual,
  type ProposeBaseFields,
  type ProposeEditsFormValues,
} from "../propose-edits-helpers";

const emptyDoc = (): ProseMirrorDoc =>
  ({ type: "doc", content: [{ type: "paragraph" }] }) as ProseMirrorDoc;

const textDoc = (text: string): ProseMirrorDoc =>
  ({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  }) as ProseMirrorDoc;

/**
 * The same text, shaped the way the ProseEditor (TipTap) emits it after its
 * mount-time normalization: default `attrs.textAlign: null` filled in on the
 * paragraph. Structurally UNEQUAL to {@link textDoc} despite identical text.
 */
const normalizedTextDoc = (text: string): ProseMirrorDoc =>
  ({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { textAlign: null },
        content: [{ type: "text", text }],
      },
    ],
  }) as ProseMirrorDoc;

const legacyBody = (doc: ProseMirrorDoc) => ({
  layoutId: "default",
  blocks: [{ id: "block-1", type: "richText", doc }],
});

const baseFields = (
  overrides: Partial<ProposeBaseFields> = {},
): ProposeBaseFields => ({
  title: "Tuesday open mic",
  content: legacyBody(textDoc("Bring an instrument.")),
  // 19:00 wall-clock in America/Chicago (CDT, UTC-5).
  startsAt: "2026-08-04T00:00:00.000Z",
  endsAt: "2026-08-04T02:00:00.000Z",
  timezone: "America/Chicago",
  addressText: "123 Main St, Austin, TX",
  countryCode: "US",
  region: "TX",
  locality: "Austin",
  postalCode: "78701",
  lat: 30.2672,
  lng: -97.7431,
  categoryId: "0d4bd6f4-9a8f-4d6e-9c1a-2f6a0b8f3c11",
  heroImageId: null,
  ageLimit: null,
  ...overrides,
});

/** Form values that exactly mirror `baseFields()` (an untouched form). */
const untouchedValues = (
  base: ProposeBaseFields = baseFields(),
): ProposeEditsFormValues => ({
  title: base.title,
  startsAtLocal: "2026-08-03T19:00",
  endsAtLocal: "2026-08-03T21:00",
  timezone: base.timezone,
  addressText: base.addressText ?? "",
  geo: null,
  categoryId: base.categoryId ?? "",
  ageLimitRaw: base.ageLimit != null ? String(base.ageLimit) : "",
  bodyDoc: textDoc("Bring an instrument."),
  heroImageId: base.heroImageId,
});

describe("computeProposeDiff", () => {
  it("produces an EMPTY diff and no errors for an untouched form", () => {
    const result = computeProposeDiff(baseFields(), untouchedValues());
    expect(result.errors).toEqual({});
    expect(result.fields).toEqual({});
  });

  it("includes only the changed title, trimmed", () => {
    const result = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      title: "  Wednesday open mic  ",
    });
    expect(result.fields).toEqual({ title: "Wednesday open mic" });
  });

  it("errors when the title is emptied (cannot be cleared)", () => {
    const result = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      title: "   ",
    });
    expect(result.errors.title).toBe("titleRequired");
    expect(result.fields).toEqual({});
  });

  it("compares datetimes by UTC instant in the selected timezone", () => {
    const result = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      startsAtLocal: "2026-08-03T20:00",
    });
    expect(result.fields).toEqual({ startsAt: "2026-08-04T01:00:00.000Z" });
  });

  it("a timezone change alone shifts the instants (schedule diff + timezone)", () => {
    const result = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      timezone: "America/New_York",
    });
    // Same wall-clock strings, one hour earlier in UTC.
    expect(result.fields).toEqual({
      startsAt: "2026-08-03T23:00:00.000Z",
      endsAt: "2026-08-04T01:00:00.000Z",
      timezone: "America/New_York",
    });
  });

  it("errors when ends is moved before starts", () => {
    const result = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      endsAtLocal: "2026-08-03T18:00",
    });
    expect(result.errors.endsAt).toBe("endsBeforeStarts");
    expect(result.fields).toEqual({});
  });

  it("errors when clearing an existing end time (cannot be cleared)", () => {
    const result = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      endsAtLocal: "",
    });
    expect(result.errors.endsAt).toBe("endsRequired");
  });

  it("allows an event without an end to stay end-less", () => {
    const base = baseFields({ endsAt: null });
    const result = computeProposeDiff(base, {
      ...untouchedValues(base),
      endsAtLocal: "",
    });
    expect(result.errors).toEqual({});
    expect(result.fields).toEqual({});
  });

  it("an untouched form across a DST transition emits NO schedule diff", () => {
    // DST ends 2026-11-01 02:00 America/Chicago (CDT→CST). Event runs
    // 8pm Oct 31 CDT (UTC-5) → 2am Nov 1 CST (UTC-6) — the window that used
    // to break: before 2026-08-11 `toIsoInTimeZone` probed the zone once and
    // derived 07:00Z for the 2am wall clock instead of the true 08:00Z, so
    // instant math alone emitted a phantom ±1h endsAt diff. The resolver now
    // brackets the transition and gets 08:00Z, and the string-level UNTOUCHED
    // short-circuit still stands as the guard for the genuinely ambiguous
    // repeated hour. This case must stay diff-free under both.
    const base = baseFields({
      startsAt: "2026-11-01T01:00:00.000Z", // 2026-10-31T20:00 wall clock
      endsAt: "2026-11-01T08:00:00.000Z", // 2026-11-01T02:00 wall clock (CST)
    });
    // Initialize exactly as the form does: base instants rendered into the
    // base timezone as datetime-local strings.
    const startsAtLocal = toDateTimeLocalValue(base.startsAt, base.timezone);
    const endsAtLocal = toDateTimeLocalValue(base.endsAt, base.timezone);
    expect(startsAtLocal).toBe("2026-10-31T20:00");
    expect(endsAtLocal).toBe("2026-11-01T02:00");

    const result = computeProposeDiff(base, {
      ...untouchedValues(base),
      startsAtLocal,
      endsAtLocal,
    });
    expect(result.errors).toEqual({});
    expect(result.fields).toEqual({});
  });

  it("proposing an end on an end-less event includes endsAt", () => {
    const base = baseFields({ endsAt: null });
    const result = computeProposeDiff(base, {
      ...untouchedValues(base),
      endsAtLocal: "2026-08-03T21:00",
    });
    expect(result.fields).toEqual({ endsAt: "2026-08-04T02:00:00.000Z" });
  });

  it("sends the WHOLE geo group when a new place is picked", () => {
    const result = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      addressText: "500 E 6th St, Austin, TX",
      geo: {
        countryCode: "us",
        region: "TX",
        locality: "Austin",
        postalCode: "78702",
        lat: 30.2669,
        lng: -97.7333,
      },
    });
    expect(result.fields).toEqual({
      addressText: "500 E 6th St, Austin, TX",
      countryCode: "US",
      region: "TX",
      locality: "Austin",
      postalCode: "78702",
      lat: 30.2669,
      lng: -97.7333,
    });
  });

  it("errors when the address text changed without picking a suggestion", () => {
    const result = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      addressText: "somewhere else entirely",
      geo: null,
    });
    expect(result.errors.location).toBe("locationPickRequired");
    expect(result.fields).toEqual({});
  });

  it("treats a typed-then-reverted address as unchanged", () => {
    const base = baseFields();
    const result = computeProposeDiff(base, {
      ...untouchedValues(base),
      addressText: base.addressText!,
      geo: null,
    });
    expect(result.errors).toEqual({});
    expect(result.fields).toEqual({});
  });

  it("errors when a picked place has no country code", () => {
    const result = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      addressText: "Middle of the ocean",
      geo: {
        countryCode: null,
        region: null,
        locality: null,
        postalCode: null,
        lat: 0.1,
        lng: 0.1,
      },
    });
    expect(result.errors.location).toBe("countryMissing");
  });

  it("re-picking the identical location produces no diff", () => {
    const base = baseFields();
    const result = computeProposeDiff(base, {
      ...untouchedValues(base),
      geo: {
        countryCode: base.countryCode,
        region: base.region,
        locality: base.locality,
        postalCode: base.postalCode,
        lat: base.lat,
        lng: base.lng,
      },
    });
    expect(result.fields).toEqual({});
  });

  it("category can be changed and cleared (null)", () => {
    const changed = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      categoryId: "7d6a3ef2-1b0c-4f8a-a1d2-9e5b7c4d3f21",
    });
    expect(changed.fields).toEqual({
      categoryId: "7d6a3ef2-1b0c-4f8a-a1d2-9e5b7c4d3f21",
    });

    const cleared = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      categoryId: "",
    });
    expect(cleared.fields).toEqual({ categoryId: null });
  });

  it("age limit: set, clear, and reject non-numeric input", () => {
    const set = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      ageLimitRaw: "18",
    });
    expect(set.fields).toEqual({ ageLimit: 18 });

    const base = baseFields({ ageLimit: 21 });
    const cleared = computeProposeDiff(base, {
      ...untouchedValues(base),
      ageLimitRaw: "",
    });
    expect(cleared.fields).toEqual({ ageLimit: null });

    const invalid = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      ageLimitRaw: "abc",
    });
    expect(invalid.errors.ageLimit).toBe("ageLimitInvalid");
    expect(invalid.fields).toEqual({});
  });

  it("body: unchanged doc produces no content diff", () => {
    const result = computeProposeDiff(baseFields(), untouchedValues());
    expect(result.fields).not.toHaveProperty("content");
  });

  it("body: an edited doc rebuilds the EventBody preserving sibling blocks", () => {
    const base = baseFields({
      content: {
        layoutId: "default",
        blocks: [
          { id: "img-1", type: "imageBlock", imageId: "img" },
          { id: "block-1", type: "richText", doc: textDoc("Old text") },
        ],
      },
    });
    const result = computeProposeDiff(base, {
      ...untouchedValues(base),
      bodyDoc: textDoc("New text"),
    });
    expect(result.fields.content).toEqual({
      layoutId: "default",
      blocks: [
        { id: "img-1", type: "imageBlock", imageId: "img" },
        { id: "block-1", type: "richText", doc: textDoc("New text") },
      ],
    });
  });

  it("body: editor-injected default attrs alone are NOT a content change (normalized baseline)", () => {
    // The editor mounts the base body and emits it with `textAlign: null`
    // filled in — the raw stored doc lacks that attr, so diffing against the
    // raw base would (wrongly) flag `content` changed on a pristine form.
    // Passing the mount-normalized doc as the baseline fixes it.
    const base = baseFields({
      content: legacyBody(textDoc("Bring an instrument.")),
    });
    const normalizedBaseline = normalizedTextDoc("Bring an instrument.");
    const result = computeProposeDiff(
      base,
      { ...untouchedValues(base), bodyDoc: normalizedBaseline },
      normalizedBaseline,
    );
    expect(result.fields).not.toHaveProperty("content");
  });

  it("body: WITHOUT the normalized baseline, mount-normalization alone spuriously diffs (regression guard)", () => {
    // Documents the bug: diffing the normalized editor doc against the RAW
    // stored doc reports a phantom content change. The override is what
    // suppresses it.
    const base = baseFields({
      content: legacyBody(textDoc("Bring an instrument.")),
    });
    const result = computeProposeDiff(base, {
      ...untouchedValues(base),
      bodyDoc: normalizedTextDoc("Bring an instrument."),
    });
    expect(result.fields).toHaveProperty("content");
  });

  it("body: a real text edit still produces a content diff against the normalized baseline", () => {
    const base = baseFields({
      content: legacyBody(textDoc("Bring an instrument.")),
    });
    const normalizedBaseline = normalizedTextDoc("Bring an instrument.");
    const edited = normalizedTextDoc("Bring two instruments.");
    const result = computeProposeDiff(
      base,
      { ...untouchedValues(base), bodyDoc: edited },
      normalizedBaseline,
    );
    // The rebuild swaps the edited doc into the base envelope, preserving the
    // block id — the whole doc is the unit of change.
    expect(result.fields.content).toEqual({
      layoutId: "default",
      blocks: [{ id: "block-1", type: "richText", doc: edited }],
    });
  });

  it("body: empty base + normalized-empty editor baseline is NOT a change", () => {
    // Base has no body; the editor mounts an empty doc and emits its
    // normalized (non-null) form — an empty paragraph carrying default attrs —
    // as the baseline. Leaving it empty must not diff.
    const base = baseFields({ content: null });
    const normalizedEmpty = {
      type: "doc",
      content: [{ type: "paragraph", attrs: { textAlign: null } }],
    } as ProseMirrorDoc;
    const result = computeProposeDiff(
      base,
      { ...untouchedValues(base), bodyDoc: normalizedEmpty },
      normalizedEmpty,
    );
    expect(result.fields).not.toHaveProperty("content");
  });

  it("body: empty base + empty editor is NOT a change", () => {
    const base = baseFields({ content: null });
    const result = computeProposeDiff(base, {
      ...untouchedValues(base),
      bodyDoc: emptyDoc(),
    });
    expect(result.fields).toEqual({});
  });

  it("body: typing into an empty base creates a fresh single-block body", () => {
    const base = baseFields({ content: null });
    const result = computeProposeDiff(base, {
      ...untouchedValues(base),
      bodyDoc: textDoc("Hello"),
    });
    const content = result.fields.content as {
      layoutId: string;
      blocks: Array<{ type: string; doc: unknown }>;
    };
    expect(content.layoutId).toBe("default");
    expect(content.blocks).toHaveLength(1);
    expect(content.blocks[0]!.type).toBe("richText");
    expect(content.blocks[0]!.doc).toEqual(textDoc("Hello"));
  });

  it("hero: selecting a different image includes heroImageId", () => {
    const result = computeProposeDiff(baseFields(), {
      ...untouchedValues(),
      heroImageId: "b3b8b1a2-6c4d-4e5f-8a9b-0c1d2e3f4a5b",
    });
    expect(result.fields).toEqual({
      heroImageId: "b3b8b1a2-6c4d-4e5f-8a9b-0c1d2e3f4a5b",
    });
  });
});

describe("extractRichTextDoc", () => {
  it("reads the legacy flat-blocks shape", () => {
    expect(extractRichTextDoc(legacyBody(textDoc("hi")))).toEqual(
      textDoc("hi"),
    );
  });

  it("reads the v1 sections shape", () => {
    const v1 = {
      version: 1,
      sections: [
        {
          id: "s1",
          kind: "section",
          layout: {
            type: "singleColumn",
            columns: [
              {
                blocks: [{ id: "b1", type: "richText", doc: textDoc("v1") }],
              },
            ],
          },
        },
      ],
    };
    expect(extractRichTextDoc(v1)).toEqual(textDoc("v1"));
  });

  it("returns null for null / block-less bodies", () => {
    expect(extractRichTextDoc(null)).toBeNull();
    expect(extractRichTextDoc({ layoutId: "default", blocks: [] })).toBeNull();
    expect(extractRichTextDoc("junk")).toBeNull();
  });
});

describe("buildProposedContent", () => {
  it("replaces the doc inside a v1 sections body in place", () => {
    const v1 = {
      version: 1,
      sections: [
        {
          id: "s1",
          kind: "section",
          layout: {
            type: "singleColumn",
            columns: [
              {
                blocks: [
                  { id: "b1", type: "richText", doc: textDoc("old") },
                ],
              },
            ],
          },
        },
      ],
    };
    const rebuilt = buildProposedContent(v1, textDoc("new"));
    expect(extractRichTextDoc(rebuilt)).toEqual(textDoc("new"));
    // The envelope (ids, section structure) is preserved.
    expect((rebuilt as { version: number }).version).toBe(1);
    // And the input is not mutated.
    expect(extractRichTextDoc(v1)).toEqual(textDoc("old"));
  });

  it("appends a richText block into a v1 body that lacks one, preserving siblings", () => {
    const v1 = {
      version: 1,
      sections: [
        {
          id: "s1",
          kind: "section",
          layout: {
            type: "singleColumn",
            columns: [
              {
                blocks: [
                  { id: "img-1", type: "imageBlock", imageId: "img" },
                  { id: "embed-1", type: "mediaEmbed", url: "https://x" },
                ],
              },
            ],
          },
        },
      ],
    };
    const rebuilt = buildProposedContent(v1, textDoc("added")) as {
      version: number;
      sections: Array<{
        id: string;
        layout: { columns: Array<{ blocks: Array<Record<string, unknown>> }> };
      }>;
    };
    // Envelope preserved; nothing dropped or duplicated, new block appended.
    expect(rebuilt.version).toBe(1);
    expect(rebuilt.sections).toHaveLength(1);
    const blocks = rebuilt.sections[0]!.layout.columns[0]!.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({ id: "img-1", type: "imageBlock", imageId: "img" });
    expect(blocks[1]).toEqual({ id: "embed-1", type: "mediaEmbed", url: "https://x" });
    expect(blocks[2]!.type).toBe("richText");
    expect(blocks[2]!.doc).toEqual(textDoc("added"));
    expect(extractRichTextDoc(rebuilt)).toEqual(textDoc("added"));
    // Input not mutated.
    expect(v1.sections[0]!.layout.columns[0]!.blocks).toHaveLength(2);
  });

  it("appends a richText block to a legacy body that lacks one", () => {
    const base = {
      layoutId: "default",
      blocks: [{ id: "img-1", type: "imageBlock", imageId: "img" }],
    };
    const rebuilt = buildProposedContent(base, textDoc("added")) as {
      blocks: Array<{ type: string }>;
    };
    expect(rebuilt.blocks).toHaveLength(2);
    expect(rebuilt.blocks[0]!.type).toBe("imageBlock");
    expect(extractRichTextDoc(rebuilt)).toEqual(textDoc("added"));
  });
});

describe("isEmptyRichTextDoc / jsonDeepEqual", () => {
  it("detects empty docs", () => {
    expect(isEmptyRichTextDoc(null)).toBe(true);
    expect(isEmptyRichTextDoc(emptyDoc())).toBe(true);
    expect(
      isEmptyRichTextDoc({ type: "doc", content: [] } as ProseMirrorDoc),
    ).toBe(true);
    expect(isEmptyRichTextDoc(textDoc("x"))).toBe(false);
  });

  it("deep-equals structurally, ignoring key order and undefined values", () => {
    expect(jsonDeepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(jsonDeepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(jsonDeepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(jsonDeepEqual([1, 2], [2, 1])).toBe(false);
  });
});

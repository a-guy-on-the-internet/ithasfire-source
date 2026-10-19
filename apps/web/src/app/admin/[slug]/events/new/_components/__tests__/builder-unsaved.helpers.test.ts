import { describe, expect, it } from "vitest";

import {
  buildBuilderSnapshot,
  comparableBody,
  hasUnsavedChanges,
  loadedFieldsSnapshot,
  rebaseBodyOnEditorSeed,
  savedFieldsSnapshot,
  snapshotBody,
  type BuilderSnapshotFields,
} from "../builder-unsaved.helpers";

const base: BuilderSnapshotFields = {
  title: "Open mic",
  startsAt: "2026-10-20T19:00",
  endsAt: "2026-10-20T22:00",
  location: {},
  locationMode: "address",
  placeId: null,
  placement: null,
  visibilityMode: "EXACT",
  visibilityRadius: 500,
  visibilityLabel: "",
  addressRevealPreset: "DAY_BEFORE",
  addressRevealAt: "",
  eventTimezone: "America/Chicago",
  communityCategoryId: null,
  heroStaged: false,
  heroRemoved: false,
  recurrenceEnabled: false,
  recurrenceConfig: null,
};
const body = snapshotBody({ type: "doc", content: [] });
const fields = (over: Partial<BuilderSnapshotFields> = {}) =>
  buildBuilderSnapshot({ ...base, ...over });
const form = (over: Partial<BuilderSnapshotFields> = {}, b = body) => ({
  fields: fields(over),
  body: b,
});
const baselineOf = (f: { fields: string; body: string }) => ({
  fields: f.fields,
  body: f.body,
});

describe("unsaved-changes derivation", () => {
  it("is clean before a baseline exists", () => {
    expect(hasUnsavedChanges({ fields: null, body: null }, form())).toBe(
      false,
    );
    expect(hasUnsavedChanges({ fields: fields(), body: null }, form())).toBe(
      false,
    );
  });

  it("is clean when the form equals the baseline", () => {
    expect(hasUnsavedChanges(baselineOf(form()), form())).toBe(false);
  });

  it("is dirty after a field edit, and clean again when the edit is undone", () => {
    const baseline = baselineOf(form());
    expect(hasUnsavedChanges(baseline, form({ title: "Open mic!" }))).toBe(
      true,
    );
    expect(hasUnsavedChanges(baseline, form({ title: "Open mic" }))).toBe(
      false,
    );
  });

  it("is dirty after a description edit", () => {
    const written = snapshotBody({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
    expect(hasUnsavedChanges(baselineOf(form()), form({}, written))).toBe(
      true,
    );
  });

  it("counts a staged or removed hero image and a recurrence change", () => {
    const baseline = baselineOf(form());
    expect(hasUnsavedChanges(baseline, form({ heroStaged: true }))).toBe(true);
    expect(hasUnsavedChanges(baseline, form({ heroRemoved: true }))).toBe(
      true,
    );
    expect(
      hasUnsavedChanges(baseline, form({ recurrenceEnabled: true })),
    ).toBe(true);
  });
});

describe("savedFieldsSnapshot", () => {
  it("baselines what the save sent, with the consumed hero cleared", () => {
    const sent = { ...base, title: "New", heroStaged: true, heroRemoved: true };
    const baseline = { fields: savedFieldsSnapshot(sent), body };
    // After the save the hero file is cleared, so the form reads exactly this.
    expect(hasUnsavedChanges(baseline, form({ title: "New" }))).toBe(false);
  });

  it("leaves an edit typed while the save was in flight unsaved", () => {
    const sent = { ...base, title: "New" };
    const baseline = { fields: savedFieldsSnapshot(sent), body };
    expect(hasUnsavedChanges(baseline, form({ title: "Newer" }))).toBe(true);
  });
});

describe("loadedFieldsSnapshot", () => {
  const hydrated = { mode: "EXACT", radius: 500 };

  it("counts the venue ceiling clamp as an unsaved change whether it lands before or after the baseline", () => {
    const clamped = { visibilityMode: "HIDDEN", visibilityRadius: null };
    // Baseline taken before the clamp landed...
    const before = {
      fields: loadedFieldsSnapshot(base, hydrated),
      body,
    };
    // ...or after it: the same baseline either way.
    const after = {
      fields: loadedFieldsSnapshot({ ...base, ...clamped }, hydrated),
      body,
    };
    expect(after).toEqual(before);
    expect(hasUnsavedChanges(before, form(clamped))).toBe(true);
  });

  it("is clean when no clamp applies", () => {
    const baseline = { fields: loadedFieldsSnapshot(base, hydrated), body };
    expect(hasUnsavedChanges(baseline, form())).toBe(false);
  });
});

describe("editor normalisation", () => {
  const raw = snapshotBody({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "Hi" }] }],
  });
  const normalized = snapshotBody({
    type: "doc",
    content: [
      {
        type: "paragraph",
        attrs: { indent: 0 },
        content: [{ type: "text", text: "Hi" }],
      },
    ],
  });
  const seed = { raw, normalized };

  it("compares the untouched stored body in the editor's normalised shape", () => {
    expect(comparableBody(raw, seed)).toBe(normalized);
    expect(comparableBody(raw, null)).toBe(raw);
  });

  it("is clean after typing a character and deleting it", () => {
    // Baseline taken from the stored doc, then the editor reports its shape.
    const bodyBaseline = rebaseBodyOnEditorSeed(raw, seed);
    // onChange emits the normalised doc once the edit is undone.
    const current = comparableBody(normalized, seed);
    expect(
      hasUnsavedChanges(
        { fields: fields(), body: bodyBaseline },
        { fields: fields(), body: current },
      ),
    ).toBe(false);
  });

  it("does not move a baseline the body has left", () => {
    const saved = snapshotBody({ type: "doc", content: [] });
    expect(rebaseBodyOnEditorSeed(saved, seed)).toBe(saved);
  });
});

describe("snapshotBody", () => {
  const audio = (attrs: Record<string, unknown>) => ({
    type: "doc",
    content: [{ type: "audioBlock", attrs }],
  });

  it("ignores key order and null defaults", () => {
    const stored = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Hi" }],
        },
      ],
    };
    const fromEditor = {
      content: [
        {
          content: [{ text: "Hi", type: "text" }],
          attrs: { textAlign: null, level: 2 },
          type: "heading",
        },
      ],
      type: "doc",
    };
    expect(snapshotBody(fromEditor)).toBe(snapshotBody(stored));
  });

  it("ignores the URLs and transcode state the editor re-syncs from the server", () => {
    const stored = audio({
      audioUploadId: "a1",
      title: "Set",
      sourceUrl: "https://minio/a1.mp3?X-Amz-Date=1",
      status: "TRANSCODING",
      hlsPlaylistUrl: null,
    });
    const synced = audio({
      audioUploadId: "a1",
      title: "Set",
      sourceUrl: "https://minio/a1.mp3?X-Amz-Date=2",
      status: "READY",
      hlsPlaylistUrl: "https://cdn/a1.m3u8",
      uploadStartedAt: "2026-10-15T01:19:41.274Z",
    });
    expect(snapshotBody(synced)).toBe(snapshotBody(stored));
    const resolvedImage = (src: string) => ({
      type: "doc",
      content: [{ type: "imageBlock", attrs: { imageId: "i1", src, alt: "" } }],
    });
    expect(snapshotBody(resolvedImage("https://cdn/i1?sig=2"))).toBe(
      snapshotBody(resolvedImage("https://cdn/i1?sig=1")),
    );
  });

  it("still counts an authored change", () => {
    expect(snapshotBody(audio({ audioUploadId: "a1", title: "Set" }))).not.toBe(
      snapshotBody(audio({ audioUploadId: "a1", title: "Encore" })),
    );
    // An image with no upload behind it: its src is the content.
    const external = (src: string) => ({
      type: "doc",
      content: [{ type: "imageBlock", attrs: { src } }],
    });
    expect(snapshotBody(external("https://a/1.png"))).not.toBe(
      snapshotBody(external("https://a/2.png")),
    );
    // A caption is authored; no caption and a null one are the same body.
    const captioned = (caption?: string | null) => ({
      type: "doc",
      content: [
        {
          type: "imageBlock",
          attrs: { imageId: "i1", src: "https://cdn/i1", caption },
        },
      ],
    });
    expect(snapshotBody(captioned("Doors at 7"))).not.toBe(
      snapshotBody(captioned(null)),
    );
    expect(snapshotBody(captioned("Doors at 7"))).not.toBe(
      snapshotBody(captioned("Doors at 8")),
    );
    expect(snapshotBody(captioned(null))).toBe(snapshotBody(captioned()));
    const aligned = (textAlign: string | null) => ({
      type: "doc",
      content: [{ type: "paragraph", attrs: { textAlign } }],
    });
    expect(snapshotBody(aligned("center"))).not.toBe(
      snapshotBody(aligned(null)),
    );
  });
});

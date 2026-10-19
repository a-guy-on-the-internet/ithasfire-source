import { describe, expect, it } from "vitest";

import {
  buildBlockSettingsSavePayload,
  createBlockSettingsDraft,
  draftHasUnsupportedEmbedUrls,
  getEditableBlockFields,
  getObjectListFieldModel,
  hasEditableSettings,
  isUnsupportedEmbedUrl,
} from "../block-settings-model";

const configs = {
  about: {
    fields: [
      { name: "heading", labelKey: "admin.peBlockFieldHeading", kind: "text" },
      {
        name: "content",
        labelKey: "admin.peBlockFieldContent",
        kind: "richText",
      },
    ],
  },
  stats: {
    fields: [
      { name: "heading", labelKey: "admin.peBlockFieldHeading", kind: "text" },
      {
        name: "source",
        labelKey: "admin.peBlockFieldDataSource",
        kind: "readonly",
      },
    ],
  },
  html_only: {
    fields: [
      { name: "html", labelKey: "admin.peBlockFieldContent", kind: "html" },
    ],
  },
  capacity_info: {
    fields: [
      { name: "heading", labelKey: "admin.peBlockFieldHeading", kind: "text" },
      {
        name: "totalCapacity",
        labelKey: "admin.peBlockFieldTotalCapacity",
        kind: "number",
      },
      {
        name: "standing",
        labelKey: "admin.peBlockFieldStandingCapacity",
        kind: "number",
      },
      {
        name: "seated",
        labelKey: "admin.peBlockFieldSeatedCapacity",
        kind: "number",
      },
      { name: "notes", labelKey: "admin.peBlockFieldNotes", kind: "textarea" },
    ],
  },
  upcoming_events: {
    fields: [
      { name: "heading", labelKey: "admin.peBlockFieldHeading", kind: "text" },
      {
        name: "events",
        labelKey: "admin.peBlockFieldEvents",
        kind: "objectList",
      },
    ],
  },
  media_lists: {
    fields: [
      { name: "links", labelKey: "admin.peBlockFieldLinks", kind: "linkList" },
      {
        name: "photos",
        labelKey: "admin.peBlockFieldPhotos",
        kind: "imageList",
      },
    ],
  },
  music: {
    fields: [
      { name: "heading", labelKey: "admin.peBlockFieldHeading", kind: "text" },
      {
        name: "embeds",
        labelKey: "admin.peBlockFieldMusicEmbeds",
        kind: "objectList",
      },
    ],
  },
  tracks: {
    fields: [
      { name: "heading", labelKey: "admin.peBlockFieldHeading", kind: "text" },
      {
        name: "tracks",
        labelKey: "admin.peBlockFieldTracks",
        kind: "objectList",
      },
    ],
  },
} as const;

const getBlockConfig = (kind: string) => configs[kind as keyof typeof configs];

describe("block settings model", () => {
  it("derives editable settings from core block config", () => {
    expect(hasEditableSettings("about", getBlockConfig)).toBe(true);
    expect(hasEditableSettings("stats", getBlockConfig)).toBe(true);
    expect(hasEditableSettings("html_only", getBlockConfig)).toBe(false);
    expect(hasEditableSettings("missing_block_kind", getBlockConfig)).toBe(
      false,
    );

    expect(
      getEditableBlockFields("stats", getBlockConfig).map(
        (field) => field.name,
      ),
    ).toEqual(["heading"]);
  });

  it.each(["items", "videos", "mentions", "members", "embeds", "tracks", "specs"])(
    "classifies %s as an editable object list",
    (name) => {
      expect(getObjectListFieldModel({ name })).toMatchObject({
        kind: "object",
      });
    },
  );

  it.each(["requirements", "rules", "amenities", "tags"])(
    "classifies %s as an editable string list",
    (name) => {
      expect(getObjectListFieldModel({ name })).toEqual({ kind: "string" });
    },
  );

  it("keeps derived object lists readonly", () => {
    expect(getObjectListFieldModel({ name: "announcements" })).toEqual({
      kind: "readonly",
    });
    expect(getObjectListFieldModel({ name: "events" })).toEqual({
      kind: "readonly",
    });
  });

  it("stamps the embed provider from the URL host and filters blank rows on save", () => {
    const payload = buildBlockSettingsSavePayload(
      "music",
      { embeds: [] },
      {
        heading: "Listen",
        embeds: [
          { url: "https://open.spotify.com/artist/abc123" },
          { url: "  https://soundcloud.com/artist/track  " },
          // Stray trailing "Add item" row — a normal editing state, filtered
          // on save so it can never block or phantom-persist.
          { url: "" },
        ],
      },
      getBlockConfig,
    );

    expect(payload).toEqual({
      heading: "Listen",
      embeds: [
        { provider: "spotify", url: "https://open.spotify.com/artist/abc123" },
        { provider: "soundcloud", url: "https://soundcloud.com/artist/track" },
      ],
    });
  });

  it("filters blank track rows on save and preserves the heading + label", () => {
    const payload = buildBlockSettingsSavePayload(
      "tracks",
      { tracks: [] },
      {
        heading: "Key tracks",
        tracks: [
          { url: "https://open.spotify.com/track/abc123", label: "festival closer" },
          { url: "  " },
          { url: "", label: "" },
        ],
      },
      getBlockConfig,
    );

    expect(payload).toEqual({
      heading: "Key tracks",
      tracks: [
        { url: "https://open.spotify.com/track/abc123", label: "festival closer" },
      ],
    });
  });

  it("flags non-empty unsupported embed/track URLs so submit can be blocked", () => {
    // Blank rows are never "invalid" — they are a normal editing state.
    expect(isUnsupportedEmbedUrl("")).toBe(false);
    expect(isUnsupportedEmbedUrl("   ")).toBe(false);
    // Allowlisted hosts pass.
    expect(isUnsupportedEmbedUrl("https://open.spotify.com/track/x")).toBe(
      false,
    );
    // A typed-but-unsupported host is flagged, not silently dropped.
    expect(isUnsupportedEmbedUrl("https://example.com/track")).toBe(true);

    expect(
      draftHasUnsupportedEmbedUrls(
        "music",
        {
          embeds: [
            { url: "https://open.spotify.com/artist/abc123" },
            { url: "https://example.com/not-allowed" },
          ],
        },
        getBlockConfig,
      ),
    ).toBe(true);

    // Only valid + blank rows → nothing to block.
    expect(
      draftHasUnsupportedEmbedUrls(
        "tracks",
        {
          tracks: [
            { url: "https://open.spotify.com/track/abc123" },
            { url: "" },
          ],
        },
        getBlockConfig,
      ),
    ).toBe(false);
  });

  it("creates a draft with editable fields only", () => {
    expect(
      createBlockSettingsDraft(
        "stats",
        {
          heading: "Stats",
          source: "rollup",
          columnSpan: 1,
        },
        getBlockConfig,
      ),
    ).toEqual({
      heading: "Stats",
    });
  });

  it("builds a merged save payload while parsing numbers and omitting emptied numbers", () => {
    const payload = buildBlockSettingsSavePayload(
      "capacity_info",
      {
        columnSpan: 1,
        totalCapacity: 500,
        standing: 200,
        source: "capacity-feed",
      },
      {
        heading: "Capacity",
        totalCapacity: "750",
        standing: "",
        seated: "125",
        notes: "Updated after room reset.",
      },
      getBlockConfig,
    );

    expect(payload).toEqual({
      columnSpan: 1,
      heading: "Capacity",
      totalCapacity: 750,
      seated: 125,
      notes: "Updated after room reset.",
      source: "capacity-feed",
    });
    expect(payload).not.toHaveProperty("standing");
  });

  it("treats whitespace-only number drafts as omitted instead of zero", () => {
    const payload = buildBlockSettingsSavePayload(
      "capacity_info",
      { totalCapacity: 500, standing: 250 },
      { totalCapacity: "   ", standing: "0" },
      getBlockConfig,
    );

    expect(payload).toEqual({ standing: 0 });
    expect(payload).not.toHaveProperty("totalCapacity");
  });

  it("treats link and image lists as editable registry-backed fields", () => {
    expect(
      getEditableBlockFields("media_lists", getBlockConfig).map(
        (field) => field.name,
      ),
    ).toEqual(["links", "photos"]);
  });

  it("preserves existing derived object-list data instead of accepting draft JSON", () => {
    const existingEvent = {
      id: "evt_1",
      title: "Night Market",
      date: "2026-05-01",
    };
    const payload = buildBlockSettingsSavePayload(
      "upcoming_events",
      {
        columnSpan: 2,
        heading: "Upcoming",
        events: [existingEvent],
      },
      {
        heading: "Next up",
        events: [{ id: "manual", title: "Manual", date: "2026-06-01" }],
      },
      getBlockConfig,
    );

    expect(payload).toEqual({
      columnSpan: 2,
      heading: "Next up",
      events: [existingEvent],
    });
  });

  it("preserves structured object-list row data supplied by the draft", () => {
    const payload = buildBlockSettingsSavePayload(
      "media_lists",
      { columnSpan: 1 },
      {
        links: [
          { label: "Site", url: "https://example.com", style: "primary" },
        ],
        photos: [
          { url: "https://example.com/photo.jpg", focalPoint: "center" },
        ],
      },
      getBlockConfig,
    );

    expect(payload).toEqual({
      columnSpan: 1,
      links: [{ label: "Site", url: "https://example.com", style: "primary" }],
      photos: [{ url: "https://example.com/photo.jpg", focalPoint: "center" }],
    });
  });
});

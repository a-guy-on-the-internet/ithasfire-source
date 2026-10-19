import { describe, expect, it } from "vitest";

import {
  isValidBlockKind,
  getValidBlockKinds,
  normalizeBlockData,
  UNIVERSAL_BLOCK_KINDS,
  HUMAN_BLOCK_KINDS,
  PLACE_BLOCK_KINDS,
  ORG_BLOCK_KINDS,
} from "../block-kinds";
import {
  BLOCK_CONFIGS,
  getAllBlockConfigs,
  getBlockConfig,
  getBlockLabelKey,
  getDefaultBlockData,
  getDefaultBlockSpan,
  getPaletteBlockConfigs,
  getPinnedBlockKinds,
  getValidBlockConfigs,
  isPinnedBlockKind,
} from "../block-config";

const ALL_EXPORTED_BLOCK_KINDS = [
  ...UNIVERSAL_BLOCK_KINDS,
  ...HUMAN_BLOCK_KINDS,
  ...PLACE_BLOCK_KINDS,
  ...ORG_BLOCK_KINDS,
] as const;

describe("isValidBlockKind", () => {
  it.each(UNIVERSAL_BLOCK_KINDS)(
    "allows universal kind '%s' for HUMAN",
    (kind) => {
      expect(isValidBlockKind("HUMAN", kind)).toBe(true);
    },
  );

  it.each(UNIVERSAL_BLOCK_KINDS)(
    "allows universal kind '%s' for PLACE",
    (kind) => {
      expect(isValidBlockKind("PLACE", kind)).toBe(true);
    },
  );

  it.each(UNIVERSAL_BLOCK_KINDS)(
    "allows universal kind '%s' for ORGANIZATION",
    (kind) => {
      expect(isValidBlockKind("ORGANIZATION", kind)).toBe(true);
    },
  );

  it.each(HUMAN_BLOCK_KINDS)(
    "allows human-only kind '%s' for HUMAN",
    (kind) => {
      expect(isValidBlockKind("HUMAN", kind)).toBe(true);
    },
  );

  it.each(HUMAN_BLOCK_KINDS)(
    "rejects human-only kind '%s' for PLACE",
    (kind) => {
      expect(isValidBlockKind("PLACE", kind)).toBe(false);
    },
  );

  // music/video/press/genre_tags are dual-owner (HUMAN + ORGANIZATION) as of
  // the "band" org archetype — they live under HUMAN_BLOCK_KINDS for the
  // taxonomy but are valid for ORGANIZATION too (a band presents as an act).
  const ORG_SHARED_HUMAN_KINDS = [
    "music",
    "video",
    "press",
    "genre_tags",
  ] as const;
  const HUMAN_ONLY_KINDS = HUMAN_BLOCK_KINDS.filter(
    (k) => !ORG_SHARED_HUMAN_KINDS.includes(k as never),
  );

  it.each(HUMAN_ONLY_KINDS)(
    "rejects human-only kind '%s' for ORGANIZATION",
    (kind) => {
      expect(isValidBlockKind("ORGANIZATION", kind)).toBe(false);
    },
  );

  it.each(ORG_SHARED_HUMAN_KINDS)(
    "allows the dual-owner kind '%s' for ORGANIZATION (band archetype)",
    (kind) => {
      expect(isValidBlockKind("ORGANIZATION", kind)).toBe(true);
      // Still valid for HUMAN — dual-owner, not moved.
      expect(isValidBlockKind("HUMAN", kind)).toBe(true);
    },
  );

  it.each(PLACE_BLOCK_KINDS)(
    "allows place-only kind '%s' for PLACE",
    (kind) => {
      expect(isValidBlockKind("PLACE", kind)).toBe(true);
    },
  );

  // booking_info is a shared kind — dual-owner (PLACE + HUMAN) as of
  // musician-epk FR-007, and tri-owner (+ ORGANIZATION) as of the band
  // archetype. It is grouped under PLACE_BLOCK_KINDS for the taxonomy but valid
  // for HUMAN and ORGANIZATION too.
  const PLACE_ONLY_KINDS = PLACE_BLOCK_KINDS.filter((k) => k !== "booking_info");

  it.each(PLACE_ONLY_KINDS)(
    "rejects place-only kind '%s' for HUMAN",
    (kind) => {
      expect(isValidBlockKind("HUMAN", kind)).toBe(false);
    },
  );

  it("allows the dual-owner booking_info kind for HUMAN (FR-007)", () => {
    expect(isValidBlockKind("HUMAN", "booking_info")).toBe(true);
  });

  it.each(PLACE_ONLY_KINDS)(
    "rejects place-only kind '%s' for ORGANIZATION",
    (kind) => {
      expect(isValidBlockKind("ORGANIZATION", kind)).toBe(false);
    },
  );

  it("allows the tri-owner booking_info kind for ORGANIZATION (band archetype)", () => {
    expect(isValidBlockKind("ORGANIZATION", "booking_info")).toBe(true);
  });

  it.each(ORG_BLOCK_KINDS)(
    "allows org-only kind '%s' for ORGANIZATION",
    (kind) => {
      expect(isValidBlockKind("ORGANIZATION", kind)).toBe(true);
    },
  );

  it.each(ORG_BLOCK_KINDS)("rejects org-only kind '%s' for HUMAN", (kind) => {
    expect(isValidBlockKind("HUMAN", kind)).toBe(false);
  });

  it.each(ORG_BLOCK_KINDS)("rejects org-only kind '%s' for PLACE", (kind) => {
    expect(isValidBlockKind("PLACE", kind)).toBe(false);
  });

  it("rejects unknown kinds", () => {
    expect(isValidBlockKind("HUMAN", "nonexistent_kind")).toBe(false);
    expect(isValidBlockKind("PLACE", "nonexistent_kind")).toBe(false);
    expect(isValidBlockKind("ORGANIZATION", "nonexistent_kind")).toBe(false);
  });

  it("rejects custom_html_sanitized because custom HTML is unsupported", () => {
    expect(UNIVERSAL_BLOCK_KINDS).not.toContain("custom_html_sanitized");
    expect(isValidBlockKind("HUMAN", "custom_html_sanitized")).toBe(false);
    expect(isValidBlockKind("PLACE", "custom_html_sanitized")).toBe(false);
    expect(isValidBlockKind("ORGANIZATION", "custom_html_sanitized")).toBe(
      false,
    );
    expect(getBlockConfig("custom_html_sanitized")).toBeUndefined();
  });
});

describe("getValidBlockKinds", () => {
  it("returns universal + human kinds (+ dual-owner booking_info) for HUMAN", () => {
    const kinds = getValidBlockKinds("HUMAN");
    // +1 for booking_info, valid for HUMAN as of musician-epk FR-007.
    expect(kinds).toHaveLength(
      UNIVERSAL_BLOCK_KINDS.length + HUMAN_BLOCK_KINDS.length + 1,
    );
    for (const k of UNIVERSAL_BLOCK_KINDS) {
      expect(kinds).toContain(k);
    }
    for (const k of HUMAN_BLOCK_KINDS) {
      expect(kinds).toContain(k);
    }
    expect(kinds).toContain("booking_info");
  });

  it("returns universal + place kinds for PLACE", () => {
    const kinds = getValidBlockKinds("PLACE");
    expect(kinds).toHaveLength(
      UNIVERSAL_BLOCK_KINDS.length + PLACE_BLOCK_KINDS.length,
    );
  });

  it("returns universal + org kinds (+ band-archetype shared kinds) for ORGANIZATION", () => {
    const kinds = getValidBlockKinds("ORGANIZATION");
    // +4 dual-owner media kinds (music/video/press/genre_tags) and +1
    // tri-owner booking_info, all valid for ORGANIZATION as of the "band"
    // archetype.
    expect(kinds).toHaveLength(
      UNIVERSAL_BLOCK_KINDS.length + ORG_BLOCK_KINDS.length + 5,
    );
    for (const k of UNIVERSAL_BLOCK_KINDS) {
      expect(kinds).toContain(k);
    }
    for (const k of ORG_BLOCK_KINDS) {
      expect(kinds).toContain(k);
    }
    for (const k of ["music", "video", "press", "genre_tags", "booking_info"]) {
      expect(kinds).toContain(k);
    }
  });
});

describe("block config registry", () => {
  it("has a config for every exported block kind and no extra configs", () => {
    expect(Object.keys(BLOCK_CONFIGS)).toEqual(ALL_EXPORTED_BLOCK_KINDS);
    expect(getAllBlockConfigs().map((config) => config.kind)).toEqual(
      ALL_EXPORTED_BLOCK_KINDS,
    );
  });

  it.each(["HUMAN", "PLACE", "ORGANIZATION"] as const)(
    "derives valid %s block kinds from valid configs",
    (ownerType) => {
      expect(
        getValidBlockConfigs(ownerType).map((config) => config.kind),
      ).toEqual(getValidBlockKinds(ownerType));
    },
  );

  it("keeps overlapping legacy/future kinds valid but out of the add palette", () => {
    const humanPaletteKinds = getPaletteBlockConfigs("HUMAN").map(
      (config) => config.kind,
    );
    const orgPaletteKinds = getPaletteBlockConfigs("ORGANIZATION").map(
      (config) => config.kind,
    );

    expect(isValidBlockKind("HUMAN", "shows")).toBe(true);
    expect(isValidBlockKind("HUMAN", "tracks")).toBe(true);
    expect(isValidBlockKind("HUMAN", "past_shows")).toBe(true);
    expect(humanPaletteKinds).not.toContain("shows");
    expect(humanPaletteKinds).not.toContain("tracks");
    expect(humanPaletteKinds).not.toContain("past_shows");

    expect(isValidBlockKind("ORGANIZATION", "mission")).toBe(true);
    expect(isValidBlockKind("ORGANIZATION", "past_events")).toBe(true);
    expect(orgPaletteKinds).not.toContain("mission");
    expect(orgPaletteKinds).not.toContain("past_events");
  });

  it("exposes label keys and default spans for editor consumers", () => {
    expect(getBlockLabelKey("about")).toBe("admin.peBlockKindAbout");
    expect(getBlockLabelKey("custom_html_sanitized")).toBeUndefined();
    expect(getBlockLabelKey("unknown_kind")).toBeUndefined();

    expect(getDefaultBlockSpan("links")).toBe(1);
    expect(getDefaultBlockSpan("stats")).toBe(1);
    expect(getDefaultBlockSpan("booking_info")).toBe(1);
    expect(getDefaultBlockSpan("genre_tags")).toBe(1);
    expect(getDefaultBlockSpan("capacity_info")).toBe(1);
    expect(getDefaultBlockSpan("about")).toBe(2);
    expect(getDefaultBlockSpan("unknown_kind")).toBe(2);
  });

  it("returns cloned default block data", () => {
    const linksData = getDefaultBlockData("links") as { links: unknown[] };
    linksData.links.push({ label: "Website", url: "https://example.com" });

    expect(getDefaultBlockData("links")).toEqual({ links: [] });
    expect(getDefaultBlockData("unknown_kind")).toEqual({});
  });
});

// booking-review-data-weave FR-004: venue_stats is a PLACE-only,
// server-injected block. Registration is covered by the it.each blocks above
// (venue_stats is in PLACE_BLOCK_KINDS); this suite pins the anti-spoofing
// data-strip and the palette reachability.
describe("venue_stats block (booking-review-data-weave FR-004)", () => {
  it("is registered PLACE-only", () => {
    expect(PLACE_BLOCK_KINDS).toContain("venue_stats");
    expect(isValidBlockKind("PLACE", "venue_stats")).toBe(true);
    expect(isValidBlockKind("HUMAN", "venue_stats")).toBe(false);
    expect(isValidBlockKind("ORGANIZATION", "venue_stats")).toBe(false);
  });

  it("stays palette-visible so venues with an already-applied template can add it", () => {
    // Existing venue pages already have "venue" in templateAppliedCategories,
    // so template seeding never re-runs for them — the palette is their path
    // to the block.
    expect(
      getPaletteBlockConfigs("PLACE").map((config) => config.kind),
    ).toContain("venue_stats");
  });

  it("keeps only heading and drops forged snapshot/dataSource keys on write", () => {
    const result = normalizeBlockData("venue_stats", {
      heading: "What performers say",
      dataSource: "venue_stats",
      snapshot: {
        version: 1,
        headline: { reviewCountBand: "50+", wouldPlayAgainPct: 100 },
      },
      snapshotAt: "2026-01-01T00:00:00.000Z",
      reviewCount: 9999,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ heading: "What performers say" });
      expect(result.data).not.toHaveProperty("dataSource");
      expect(result.data).not.toHaveProperty("snapshot");
      expect(result.data).not.toHaveProperty("snapshotAt");
      expect(result.data).not.toHaveProperty("reviewCount");
    }
  });

  it("accepts an empty data object (heading optional)", () => {
    const result = normalizeBlockData("venue_stats", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({});
    }
  });
});

// tech_specs: the venue-side rider — a labeled spec sheet (PA / monitors /
// backline / …) + optional notes. Registration/ownership is covered by the
// PLACE_BLOCK_KINDS it.each suites above; this pins the data contract.
describe("tech_specs block (venue tech-spec sheet)", () => {
  it("is registered PLACE-only and palette-visible", () => {
    expect(PLACE_BLOCK_KINDS).toContain("tech_specs");
    expect(isValidBlockKind("PLACE", "tech_specs")).toBe(true);
    expect(isValidBlockKind("HUMAN", "tech_specs")).toBe(false);
    expect(isValidBlockKind("ORGANIZATION", "tech_specs")).toBe(false);
    expect(
      getPaletteBlockConfigs("PLACE").map((config) => config.kind),
    ).toContain("tech_specs");
  });

  it("accepts heading + labeled spec rows + notes, sanitizing free text", () => {
    const result = normalizeBlockData("tech_specs", {
      heading: "Tech specs",
      specs: [
        { label: "PA", value: "d&b line array + subs" },
        // Sanitizer strips markup from free text (stored-XSS hygiene).
        { label: "<b>Console</b>", value: "DiGiCo SD10" },
        // Blank "Add item" row passes validation; the renderer skips it.
        {},
      ],
      notes: "Full stage plot on advance.",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        heading: "Tech specs",
        specs: [
          { label: "PA", value: "d&b line array + subs" },
          { label: "Console", value: "DiGiCo SD10" },
          {},
        ],
        notes: "Full stage plot on advance.",
      });
    }
  });

  it("rejects a non-array specs payload and unknown row keys", () => {
    expect(
      normalizeBlockData("tech_specs", { specs: "PA, monitors" }).ok,
    ).toBe(false);
    expect(
      normalizeBlockData("tech_specs", {
        specs: [{ label: "PA", value: "House rig", forged: true }],
      }).ok,
    ).toBe(false);
  });

  it("accepts an empty data object (everything optional)", () => {
    const result = normalizeBlockData("tech_specs", {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Default data seeds the empty specs list.
      expect(result.data).toEqual({ specs: [] });
    }
  });
});

// ── pinned kinds (venue-track-record-and-review-switch R6 / FR-011 / FR-012) ─

describe("pinned block kinds", () => {
  it("track_record is a PLACE-only kind", () => {
    expect(PLACE_BLOCK_KINDS).toContain("track_record");
    expect(isValidBlockKind("PLACE", "track_record")).toBe(true);
    expect(isValidBlockKind("HUMAN", "track_record")).toBe(false);
    expect(isValidBlockKind("ORGANIZATION", "track_record")).toBe(false);
  });

  it("track_record is pinned and NOTHING else is", () => {
    expect(getPinnedBlockKinds()).toEqual(["track_record"]);
    for (const kind of ALL_EXPORTED_BLOCK_KINDS) {
      expect(isPinnedBlockKind(kind), kind).toBe(kind === "track_record");
    }
    expect(isPinnedBlockKind("unknown_kind")).toBe(false);
    expect(getBlockConfig("track_record")).toMatchObject({ pinned: true });
    // The two testimony siblings stay ordinary (hideable, removable).
    expect(getBlockConfig("venue_stats")).not.toHaveProperty("pinned");
    expect(getBlockConfig("audience_stats")).not.toHaveProperty("pinned");
  });

  it("track_record is seeded, not added: out of the PLACE palette but valid", () => {
    const paletteKinds = getPaletteBlockConfigs("PLACE").map((c) => c.kind);
    expect(paletteKinds).not.toContain("track_record");
    expect(getValidBlockConfigs("PLACE").map((c) => c.kind)).toContain(
      "track_record",
    );
  });

  it("strips every stored key but heading (anti-spoofing, like venue_stats)", () => {
    const result = normalizeBlockData("track_record", {
      heading: "What's happened here",
      dataSource: "track_record",
      showsHosted: 9999,
      recentActs: [{ name: "Forged Act", profileUrl: "/humans/x", timesPlayed: 50 }],
      allActsCount: 50,
      cadence: "weekly",
    });
    expect(result).toEqual({
      ok: true,
      data: { heading: "What's happened here" },
    });
  });
});

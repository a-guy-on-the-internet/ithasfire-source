import { describe, expect, it } from "vitest";

import { BLOCK_CONFIGS, isValidBlockKind } from "../block-config";
import {
  PAGE_TEMPLATES,
  findTemplateKindViolations,
  getAppliedTemplateRevision,
  getPageTemplate,
  getTemplateRevision,
  needsTemplateSeed,
  resolveCategory,
  templateAppliedMarker,
} from "../page-templates";

const UNIVERSAL_KINDS = ["about", "links", "photos", "upcoming_events"];

describe("resolveCategory", () => {
  it("HUMAN + performer enabled -> performer (the working-act middle tier)", () => {
    expect(resolveCategory("HUMAN", { performerEnabled: true })).toBe(
      "performer",
    );
  });

  it("HUMAN + performer disabled -> generic", () => {
    expect(resolveCategory("HUMAN", { performerEnabled: false })).toBe(
      "generic",
    );
  });

  it("PLACE -> venue (performer flag ignored)", () => {
    expect(resolveCategory("PLACE", { performerEnabled: true })).toBe("venue");
    expect(resolveCategory("PLACE", { performerEnabled: false })).toBe("venue");
  });

  it("ORGANIZATION -> generic (performer flag ignored)", () => {
    expect(resolveCategory("ORGANIZATION", { performerEnabled: true })).toBe(
      "generic",
    );
    expect(resolveCategory("ORGANIZATION", { performerEnabled: false })).toBe(
      "generic",
    );
  });
});

describe("page-templates registry", () => {
  it("registers exactly the expected template keys", () => {
    expect(Object.keys(PAGE_TEMPLATES).sort()).toEqual(
      [
        "HUMAN:generic",
        "HUMAN:performer",
        "HUMAN:musician",
        "PLACE:venue",
        "ORGANIZATION:generic",
        "ORGANIZATION:promoter",
        "ORGANIZATION:collective",
        "ORGANIZATION:band",
      ].sort(),
    );
  });

  it("registers every kind as valid for its owner type (no violations)", () => {
    expect(findTemplateKindViolations()).toEqual([]);
  });

  it("cross-checks each template kind with isValidBlockKind directly", () => {
    for (const [key, specs] of Object.entries(PAGE_TEMPLATES)) {
      const ownerType = key.split(":")[0] as
        | "HUMAN"
        | "PLACE"
        | "ORGANIZATION";
      for (const spec of specs) {
        expect(isValidBlockKind(ownerType, spec.kind)).toBe(true);
      }
    }
  });

  it("returns [] for an unregistered (ownerType, category) combination", () => {
    expect(getPageTemplate("HUMAN", "does-not-exist")).toEqual([]);
    expect(getPageTemplate("PLACE", "generic")).toEqual([]);
    expect(getPageTemplate("ORGANIZATION", "musician")).toEqual([]);
  });

  it("HUMAN generic stays the minimal identity floor", () => {
    expect(getPageTemplate("HUMAN", "generic").map((s) => s.kind)).toEqual(
      UNIVERSAL_KINDS,
    );
  });

  // ── Performer (working-act middle tier) ──────────────────────────────────

  it("performer template lists its kinds in the declared order", () => {
    expect(getPageTemplate("HUMAN", "performer").map((s) => s.kind)).toEqual([
      "about",
      "music",
      "video",
      "photos",
      "genre_tags",
      "upcoming_events",
      "booking_info",
      "links",
    ]);
  });

  it("performer template is self-contained (includes the universal starter blocks)", () => {
    const kinds = getPageTemplate("HUMAN", "performer").map((s) => s.kind);
    for (const universal of UNIVERSAL_KINDS) {
      expect(kinds).toContain(universal);
    }
  });

  it("performer kinds are a strict subset of musician kinds (an existing musician-template page gains no new blocks when the default resolution flips)", () => {
    const performer = getPageTemplate("HUMAN", "performer").map((s) => s.kind);
    const musician = new Set(
      getPageTemplate("HUMAN", "musician").map((s) => s.kind),
    );
    for (const kind of performer) {
      expect(musician.has(kind)).toBe(true);
    }
    expect(performer.length).toBeLessThan(musician.size);
  });

  it("generic -> performer transition appends exactly the performer-specific kinds", () => {
    const generic = new Set(
      getPageTemplate("HUMAN", "generic").map((s) => s.kind),
    );
    const appended = getPageTemplate("HUMAN", "performer")
      .map((s) => s.kind)
      .filter((kind) => !generic.has(kind));
    expect(appended).toEqual(["music", "video", "genre_tags", "booking_info"]);
  });

  // ── Musician (full EPK) ──────────────────────────────────────────────────

  it("musician template is self-contained (includes the universal starter blocks)", () => {
    const kinds = getPageTemplate("HUMAN", "musician").map((s) => s.kind);
    for (const universal of UNIVERSAL_KINDS) {
      expect(kinds).toContain(universal);
    }
  });

  it("musician template orders media above the fold (matches the standard HumanEntityLayout zones)", () => {
    expect(getPageTemplate("HUMAN", "musician").map((s) => s.kind)).toEqual([
      "about",
      "music",
      "tracks",
      "video",
      "photos",
      "press",
      "stats",
      "upcoming_events",
      "shows",
      "past_shows",
      "genre_tags",
      "rider",
      // musician-epk FR-007: dedicated artist booking-contact block.
      "booking_info",
      "links",
    ]);
  });

  it("musician stats block still seeds hidden (opt-in, musician-epk FR-004)", () => {
    const stats = getPageTemplate("HUMAN", "musician").find(
      (s) => s.kind === "stats",
    );
    expect(stats?.visible).toBe(false);
  });

  // ── Organization tiers ───────────────────────────────────────────────────

  it("org generic is slimmed to the minimal floor (about, links, upcoming_events)", () => {
    expect(
      getPageTemplate("ORGANIZATION", "generic").map((s) => s.kind),
    ).toEqual(["about", "links", "upcoming_events"]);
  });

  it("org promoter is an events-forward self-contained superset of generic", () => {
    const promoter = getPageTemplate("ORGANIZATION", "promoter").map(
      (s) => s.kind,
    );
    expect(promoter).toEqual([
      "about",
      "links",
      "upcoming_events",
      "photos",
      "past_events",
      "managed_places",
    ]);
    for (const kind of getPageTemplate("ORGANIZATION", "generic").map(
      (s) => s.kind,
    )) {
      expect(promoter).toContain(kind);
    }
  });

  it("org collective is a mission-forward self-contained superset of generic", () => {
    const collective = getPageTemplate("ORGANIZATION", "collective").map(
      (s) => s.kind,
    );
    expect(collective).toEqual([
      "about",
      "links",
      "upcoming_events",
      "team",
      "mission",
      "managed_places",
      "past_events",
    ]);
    for (const kind of getPageTemplate("ORGANIZATION", "generic").map(
      (s) => s.kind,
    )) {
      expect(collective).toContain(kind);
    }
  });

  it("org generic -> collective transition appends exactly team, mission, managed_places, past_events", () => {
    const generic = new Set(
      getPageTemplate("ORGANIZATION", "generic").map((s) => s.kind),
    );
    const appended = getPageTemplate("ORGANIZATION", "collective")
      .map((s) => s.kind)
      .filter((kind) => !generic.has(kind));
    expect(appended).toEqual([
      "team",
      "mission",
      "managed_places",
      "past_events",
    ]);
  });

  // ── Organization band archetype ──────────────────────────────────────────

  it("org band lists the performer-spine kinds in the declared order", () => {
    expect(getPageTemplate("ORGANIZATION", "band").map((s) => s.kind)).toEqual([
      "about",
      "links",
      "upcoming_events",
      "music",
      "video",
      "press",
      "genre_tags",
      "team",
      "booking_info",
      "photos",
    ]);
  });

  it("org band is a self-contained superset of ORG_GENERIC (append-invariant)", () => {
    const band = getPageTemplate("ORGANIZATION", "band").map((s) => s.kind);
    for (const kind of getPageTemplate("ORGANIZATION", "generic").map(
      (s) => s.kind,
    )) {
      expect(band).toContain(kind);
    }
    // Append-invariant: generic -> band adds ONLY the band-specific kinds, no
    // reordering/removal of the generic floor.
    const generic = new Set(
      getPageTemplate("ORGANIZATION", "generic").map((s) => s.kind),
    );
    const appended = band.filter((kind) => !generic.has(kind));
    expect(appended).toEqual([
      "music",
      "video",
      "press",
      "genre_tags",
      "team",
      "booking_info",
      "photos",
    ]);
  });

  it("every org band kind is ORG-valid per block-config (no HUMAN-only leak)", () => {
    // Reuse the registry-wide guard: since ORGANIZATION:band is now registered,
    // any HUMAN-only kind slipping into it would surface here as a violation.
    expect(findTemplateKindViolations()).toEqual([]);
    for (const spec of getPageTemplate("ORGANIZATION", "band")) {
      expect(isValidBlockKind("ORGANIZATION", spec.kind)).toBe(true);
    }
  });

  it("ORGANIZATION:band is reachable only via explicit category, never auto-resolution", () => {
    // resolveCategory never returns "band" for an ORG — the template is opt-in.
    expect(resolveCategory("ORGANIZATION", { performerEnabled: true })).not.toBe(
      "band",
    );
    expect(
      resolveCategory("ORGANIZATION", { performerEnabled: false }),
    ).not.toBe("band");
    // But the explicit key still resolves to a non-empty template.
    expect(getPageTemplate("ORGANIZATION", "band").length).toBeGreaterThan(0);
  });

  // FR-007: every palette:false kind must be reachable via some template.
  it("every palette:false block kind appears in at least one template", () => {
    const paletteHidden = Object.values(BLOCK_CONFIGS)
      .filter((c) => "palette" in c && c.palette === false)
      .map((c) => c.kind);

    // Sanity: the known palette-hidden kinds from block-config.ts.
    // `track_record` is hidden because it is PINNED and seeded (venue-track-
    // record R6): a palette add would be a second undeletable copy.
    expect(new Set(paletteHidden)).toEqual(
      new Set([
        "shows",
        "tracks",
        "past_shows",
        "mission",
        "past_events",
        "track_record",
      ]),
    );

    const seededKinds = new Set(
      Object.values(PAGE_TEMPLATES).flatMap((specs) =>
        specs.map((s) => s.kind),
      ),
    );
    for (const kind of paletteHidden) {
      expect(seededKinds.has(kind)).toBe(true);
    }
  });

  // booking-review-data-weave FR-006: crowd-sourced venue stats seed into the
  // venue template, visible, directly above the request-to-play CTA.
  it("venue template includes venue_stats above request_to_play, seeded visible", () => {
    const specs = getPageTemplate("PLACE", "venue");
    const kinds = specs.map((s) => s.kind);

    expect(kinds).toEqual([
      "about",
      "location_map",
      "capacity_info",
      "house_rules",
      "amenities",
      // Venue tech-spec sheet (the venue-side rider) rides with the other
      // venue-facts blocks.
      "tech_specs",
      "photos",
      // venue-track-record FR-011: the door's record sits directly after the
      // photo break and ABOVE both testimony blocks (revision 4).
      "track_record",
      "venue_stats",
      // attendee-reviews FR-005: verified-attendee testimony seeds directly
      // beside the performer venue_stats.
      "audience_stats",
      // venue-rating-block-and-owner-optin FR-001: role-forked "Rate this venue"
      // CTA seeds after the audience aggregate (revision 3).
      "rate_venue",
      "request_to_play",
      "booking_info",
    ]);

    // Seeds visible (not opt-in like the musician `stats` block) — the owner
    // can hide it afterwards like any block.
    const venueStats = specs.find((s) => s.kind === "venue_stats");
    expect(venueStats?.visible).not.toBe(false);
    const audienceStats = specs.find((s) => s.kind === "audience_stats");
    expect(audienceStats?.visible).not.toBe(false);
  });

  it("venue template pins track_record directly after photos and before venue_stats, seeded visible (venue-track-record FR-011 / R6)", () => {
    const specs = getPageTemplate("PLACE", "venue");
    const kinds = specs.map((s) => s.kind);
    const at = kinds.indexOf("track_record");
    expect(at).toBeGreaterThan(0);
    expect(kinds[at - 1]).toBe("photos");
    expect(kinds[at + 1]).toBe("venue_stats");
    expect(specs[at]?.visible).not.toBe(false);
    expect(specs[at]?.sinceRevision).toBe(4);
    // The pinned kind lives in exactly one template — a PLACE page is the
    // only owner it is valid for.
    const templatesWithIt = Object.entries(PAGE_TEMPLATES)
      .filter(([, list]) => list.some((s) => s.kind === "track_record"))
      .map(([key]) => key);
    expect(templatesWithIt).toEqual(["PLACE:venue"]);
  });

  // One-shot additivity for kinds added to an already-shipped template. The
  // applied store is the free-form templateAppliedCategories String[]: bare
  // category = revision 1, "<category>@<N>" = revision N.
  describe("template revisions", () => {
    it("PLACE:venue is at revision 4 (track_record); untagged templates stay at 1", () => {
      expect(getTemplateRevision("PLACE", "venue")).toBe(4);
      expect(getTemplateRevision("HUMAN", "musician")).toBe(1);
      expect(getTemplateRevision("ORGANIZATION", "generic")).toBe(1);
      // Unregistered combination → empty template → revision 1.
      expect(getTemplateRevision("PLACE", "generic")).toBe(1);
    });

    it("tech_specs (rev 2), track_record (rev 4) and rate_venue (rev 3) are the tagged venue kinds, in template order (base kinds untouched)", () => {
      const tagged = getPageTemplate("PLACE", "venue").filter(
        (s) => (s.sinceRevision ?? 1) > 1,
      );
      expect(
        tagged.map((s) => ({ kind: s.kind, since: s.sinceRevision })),
      ).toEqual([
        { kind: "tech_specs", since: 2 },
        { kind: "track_record", since: 4 },
        { kind: "rate_venue", since: 3 },
      ]);
    });

    it("a page at revision 3 lags the template by exactly track_record; a page at 4 is current", () => {
      const introducedAfter3 = getPageTemplate("PLACE", "venue")
        .filter((s) => (s.sinceRevision ?? 1) > 3)
        .map((s) => s.kind);
      expect(introducedAfter3).toEqual(["track_record"]);
      expect(needsTemplateSeed(["venue", "venue@3"], "PLACE", "venue")).toBe(
        true,
      );
      expect(needsTemplateSeed(["venue", "venue@4"], "PLACE", "venue")).toBe(
        false,
      );
    });

    it("templateAppliedMarker: bare category for revision 1, @N suffix beyond", () => {
      expect(templateAppliedMarker("venue", 1)).toBe("venue");
      expect(templateAppliedMarker("venue", 2)).toBe("venue@2");
    });

    it("getAppliedTemplateRevision parses bare + versioned markers, ignores junk", () => {
      expect(getAppliedTemplateRevision([], "venue")).toBe(0);
      expect(getAppliedTemplateRevision(["venue"], "venue")).toBe(1);
      expect(getAppliedTemplateRevision(["venue", "venue@2"], "venue")).toBe(2);
      // A versioned marker alone covers earlier revisions.
      expect(getAppliedTemplateRevision(["venue@2"], "venue")).toBe(2);
      // Other categories and malformed suffixes don't count.
      expect(
        getAppliedTemplateRevision(["generic", "venue@x", "venue@"], "venue"),
      ).toBe(0);
    });

    it("needsTemplateSeed: true for never-seeded and lagging pages, false when current", () => {
      expect(needsTemplateSeed([], "PLACE", "venue")).toBe(true);
      // Revision-1-applied venue page lags the revision-3 template.
      expect(needsTemplateSeed(["venue"], "PLACE", "venue")).toBe(true);
      // A revision-2-applied page still lags revision 4 (rate_venue, track_record).
      expect(needsTemplateSeed(["venue", "venue@2"], "PLACE", "venue")).toBe(
        true,
      );
      // Revision 3 (rate_venue) still lags revision 4 (track_record).
      expect(needsTemplateSeed(["venue", "venue@3"], "PLACE", "venue")).toBe(
        true,
      );
      expect(needsTemplateSeed(["venue", "venue@4"], "PLACE", "venue")).toBe(
        false,
      );
      // Untagged template: bare marker is already current.
      expect(needsTemplateSeed(["musician"], "HUMAN", "musician")).toBe(false);
    });
  });

  it("FR-007 explicit: musician has shows/tracks/past_shows; org/collective has mission/past_events", () => {
    const musician = getPageTemplate("HUMAN", "musician").map((s) => s.kind);
    expect(musician).toEqual(
      expect.arrayContaining(["shows", "tracks", "past_shows"]),
    );

    const collective = getPageTemplate("ORGANIZATION", "collective").map(
      (s) => s.kind,
    );
    expect(collective).toEqual(
      expect.arrayContaining(["mission", "past_events"]),
    );
  });
});

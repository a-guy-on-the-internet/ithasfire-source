import { describe, expect, it } from "vitest";

import { formatManifestProvenance } from "./manifest-provenance";

const MIN = 60_000;
const HR = 60 * MIN;

describe("formatManifestProvenance — the wording ladder (design §3)", () => {
  it("says JUST SYNCED under a minute — '0 min old' reads as broken", () => {
    const p = formatManifestProvenance({ ageMs: 12_000, syncedAt: 1 });
    expect(p.text).toBe("OFFLINE · JUST SYNCED");
    expect(p.variant).toBe("outlined");
  });

  it("is relative in minutes up to an hour", () => {
    expect(formatManifestProvenance({ ageMs: 7 * MIN, syncedAt: 1 }).text).toBe(
      "OFFLINE · 7 MIN OLD",
    );
    expect(formatManifestProvenance({ ageMs: MIN, syncedAt: 1 }).announce).toBe(
      "Offline result. Local manifest synced 1 minute ago.",
    );
    expect(
      formatManifestProvenance({ ageMs: 59 * MIN, syncedAt: 1 }).text,
    ).toBe("OFFLINE · 59 MIN OLD");
  });

  it("is relative in hours from 1 to 23", () => {
    expect(formatManifestProvenance({ ageMs: 3 * HR, syncedAt: 1 }).text).toBe(
      "OFFLINE · 3 HR OLD",
    );
    expect(
      formatManifestProvenance({ ageMs: 23 * HR, syncedAt: 1 }).variant,
    ).toBe("outlined");
  });

  it("switches to an absolute date AND escalates the chip at 24h", () => {
    // '31 hr old' is noise; the DATE is the decision, because a manifest from
    // yesterday means the wrong door.
    const syncedAt = new Date(2026, 7, 4, 21, 4).getTime();
    const p = formatManifestProvenance({ ageMs: 25 * HR, syncedAt });
    expect(p.text).toBe("OFFLINE · SYNCED AUG 4, 21:04");
    expect(p.variant).toBe("inverted");
  });

  it("treats an unknown age as the escalated case — fail closed", () => {
    const p = formatManifestProvenance({ ageMs: null, syncedAt: null });
    expect(p.variant).toBe("inverted");
    expect(p.text).toBe("OFFLINE · SYNC UNKNOWN");
  });

  it("always announces provenance FIRST as a sentence, not the visual string", () => {
    const p = formatManifestProvenance({ ageMs: 7 * MIN, syncedAt: 1 });
    expect(p.announce).toBe(
      "Offline result. Local manifest synced 7 minutes ago.",
    );
    expect(p.announce.startsWith("Offline result.")).toBe(true);
  });

  it("appends the express confirm-manually hint when asked (FR-004 half)", () => {
    const p = formatManifestProvenance({
      ageMs: 12 * MIN,
      syncedAt: 1,
      confirmManually: true,
    });
    expect(p.text).toBe("OFFLINE · 12 MIN OLD · CONFIRM MANUALLY");
    // The spoken form stays a clean sentence — the hint is a visual cue for
    // the operator holding the phone, not part of the provenance claim.
    expect(p.announce).not.toMatch(/CONFIRM/);
  });
});

import { describe, expect, it } from "vitest";

import { isValidBlockKind, normalizeBlockData } from "../block-config";

describe("musician EPK block-config", () => {
  describe("booking_info (FR-007)", () => {
    it("is now a valid block kind for HUMAN (and still for PLACE)", () => {
      expect(isValidBlockKind("HUMAN", "booking_info")).toBe(true);
      expect(isValidBlockKind("PLACE", "booking_info")).toBe(true);
    });

    it("is now also valid for ORGANIZATION (band archetype — tri-owner)", () => {
      expect(isValidBlockKind("ORGANIZATION", "booking_info")).toBe(true);
    });

    it("validates the existing contact schema", () => {
      const result = normalizeBlockData("booking_info", {
        heading: "Booking",
        contactEmail: "book@artist.com",
        bookingUrl: "https://artist.com/book",
      });
      expect(result.ok).toBe(true);
    });
  });

  describe("music embeds (FR-005 / NFR-003)", () => {
    it("accepts up to 3 allowlisted provider embeds", () => {
      const result = normalizeBlockData("music", {
        heading: "Listen",
        embeds: [
          { provider: "spotify", url: "https://open.spotify.com/artist/1abcDEF2ghiJKL3mnoPQR4" },
          { provider: "bandcamp", url: "https://artist.bandcamp.com/album/debut" },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it("rejects a URL whose host does not match the declared provider", () => {
      const result = normalizeBlockData("music", {
        embeds: [
          { provider: "spotify", url: "https://evil.example.com/track/1" },
        ],
      });
      expect(result.ok).toBe(false);
    });

    it("rejects an off-allowlist provider value", () => {
      const result = normalizeBlockData("music", {
        embeds: [{ provider: "myspace", url: "https://myspace.com/artist" }],
      });
      expect(result.ok).toBe(false);
    });

    it("rejects more than 3 embeds", () => {
      const one = {
        provider: "spotify" as const,
        url: "https://open.spotify.com/artist/1abcDEF2ghiJKL3mnoPQR4",
      };
      const result = normalizeBlockData("music", {
        embeds: [one, one, one, one],
      });
      expect(result.ok).toBe(false);
    });

    it("rejects a non-http(s) url", () => {
      const result = normalizeBlockData("music", {
        embeds: [
          { provider: "spotify", url: "javascript:alert(1)" },
        ],
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("tracks (FR-006)", () => {
    it("accepts an allowlisted url with an optional label", () => {
      const result = normalizeBlockData("tracks", {
        tracks: [
          {
            url: "https://open.spotify.com/track/1abcDEF2ghiJKL3mnoPQR4",
            label: "festival closer",
          },
          { url: "https://soundcloud.com/artist/demo" },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it("rejects a non-allowlisted host", () => {
      const result = normalizeBlockData("tracks", {
        tracks: [{ url: "https://example.com/song.mp3" }],
      });
      expect(result.ok).toBe(false);
    });

    it("rejects more than 10 tracks", () => {
      const t = { url: "https://open.spotify.com/track/1abcDEF2ghiJKL3mnoPQR4" };
      const result = normalizeBlockData("tracks", {
        tracks: Array.from({ length: 11 }, () => t),
      });
      expect(result.ok).toBe(false);
    });

    it("rejects a label over 60 chars", () => {
      const result = normalizeBlockData("tracks", {
        tracks: [
          {
            url: "https://open.spotify.com/track/1abcDEF2ghiJKL3mnoPQR4",
            label: "x".repeat(61),
          },
        ],
      });
      expect(result.ok).toBe(false);
    });
  });

  describe("stats block strips owner-supplied metrics (NFR-001 defense in depth)", () => {
    it("keeps only heading and drops forged eligible/computedAt/metrics on write", () => {
      const result = normalizeBlockData("stats", {
        heading: "By the numbers",
        eligible: true,
        computedAt: "2020-01-01T00:00:00.000Z",
        metrics: { avgDrawPerEvent: 9999, refLinkTickets: 9999 },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.data).toEqual({ heading: "By the numbers" });
        expect(result.data).not.toHaveProperty("metrics");
        expect(result.data).not.toHaveProperty("eligible");
        expect(result.data).not.toHaveProperty("computedAt");
      }
    });
  });

  describe("photos downloadable flag (FR-008)", () => {
    it("accepts the optional downloadable boolean", () => {
      const result = normalizeBlockData("photos", {
        photos: [
          { url: "https://cdn.test/press.jpg", downloadable: true },
          { url: "https://cdn.test/stage.jpg" },
        ],
      });
      expect(result.ok).toBe(true);
    });

    it("rejects a non-boolean downloadable", () => {
      const result = normalizeBlockData("photos", {
        photos: [{ url: "https://cdn.test/press.jpg", downloadable: "yes" }],
      });
      expect(result.ok).toBe(false);
    });
  });
});

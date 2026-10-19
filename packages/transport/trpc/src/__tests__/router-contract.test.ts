import { describe, expect, it } from "vitest";

import { appRouter } from "../router";

// The public contract rule:
// - Only `health.*` procedures may exist at the top-level.
// - All other domains must be nested under a namespace key (e.g. `events.*`, `orders.*`).
//
// This prevents accidental "procedure not found" regressions caused by leaking procedures
// into the root router or changing namespacing conventions.

describe("tRPC router contract", () => {
  it("exposes only health procedures at the root", () => {
    // Root-level record keys represent the set of top-level routers/procedures.
    // The only top-level *procedure router* that may exist is `health`.
    // Everything else must be a nested router namespace.
    const record = appRouter._def.record as Record<string, unknown>;
    expect(record).toHaveProperty("health");

    for (const [key, value] of Object.entries(record)) {
      const isProcedure = value && typeof value === "function";
      if (isProcedure) expect(key).toBe("health");
    }
  });

  it("does not leak procedures outside namespaces", () => {
    const procedurePaths = Object.keys(appRouter._def.procedures);

    const allowedPrefixes = [
      "health",
      "health.",
      "events.",
      "agreements.",
      "orders.",
      "humans.",
      "orgs.",
      "ticketTypes.",
      "ticketTypeTemplates.",
      "applicationFormTemplates.",
      "tickets.",
      "eventTemplates.",
      "eventHumans.",
      "series.",
      "placeLayouts.",
      "places.",
      "settlements.",
      "splits.",
      "search.",
      "stripeConnect.",
      "comms.",
      "categories.",
      "community.",
      "eventSaves.",
      "eventSuggestions.",
      "entityReports.",
      "arrivalAreas.",
      "moderatorApplications.",
      "moderation.",
      "tags.",
      "delegates.",
      "embeds.",
      "credits.",
      "platform.",
      "platformJobs.",
      "invitePauses.",
      "announcements.",
      "quotas.",
      "promos.",
      "resale.",
      "claims.",
      "notifications.",
      "notificationPreferences.",
      "entityPages.",
      "scan.",
      "analytics.",
      "apiKeys.",
      "comp.",
      "consent.",
      "featuredItems.",
      "features.",
      "follows.",
      "payoutTerms.",
      "payouts.",
      "performers.",
      "bookingRequests.",
      "bookingAgreements.",
      // ── P4b (deal terms) ──
      "deals.",
      "bookingHolds.",
      "venueConfirmation.",
      "bookingTags.",
      // ── booking-the-night P2d-1 (saved reasons) ──
      "savedSnippets.",
      "placeReviews.",
      "attendeeReviews.",
      "pos.",
      "routing.",
      "scanner.",
      "volunteer.",
      "volunteerPacks.",
      "waivers.",
      "walletPasses.",
      "support.",
      "spotify.",
      "memberships.",
    ] as const;

    const leaked = procedurePaths.filter(
      (path) => !allowedPrefixes.some((prefix) => path.startsWith(prefix)),
    );

    expect(leaked).toEqual([]);
  });

  it("exposes expected domain router namespaces", () => {
    // Nesting is represented as root-level record keys.
    const record = appRouter._def.record;

    const expectedNamespaces = [
      "events",
      "agreements",
      "orders",
      "humans",
      "orgs",
      "ticketTypes",
      "ticketTypeTemplates",
      "applicationFormTemplates",
      "tickets",
      "eventTemplates",
      "eventHumans",
      "series",
      "placeLayouts",
      "places",
      "settlements",
      "splits",
      "search",
      "stripeConnect",
      "comms",
      "categories",
      "community",
      "eventSaves",
      "eventSuggestions",
      "entityReports",
      "moderatorApplications",
      "moderation",
      "tags",
      "delegates",
      "embeds",
      "credits",
      "platform",
      "platformJobs",
      "invitePauses",
      "announcements",
      "quotas",
      "promos",
      "resale",
      "claims",
      "notifications",
      "notificationPreferences",
      "entityPages",
      "analytics",
      "apiKeys",
      "comp",
      "consent",
      "featuredItems",
      "features",
      "follows",
      "payoutTerms",
      "payouts",
      "performers",
      "bookingRequests",
      "bookingAgreements",
      // ── P4b (deal terms) ──
      "deals",
      "bookingHolds",
      "venueConfirmation",
      "bookingTags",
      // ── booking-the-night P2d-1 (saved reasons) ──
      "savedSnippets",
      "placeReviews",
      "attendeeReviews",
      "pos",
      "routing",
      "scanner",
      "volunteer",
      "waivers",
      "walletPasses",
      "support",
      "memberships",
    ] as const;

    for (const key of expectedNamespaces) {
      expect(record).toHaveProperty(key);
    }
  });
});

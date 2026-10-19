import { describe, expect, it } from "vitest";

import { flattenCatalog } from "@th/locale";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  buildPlaceNavSections,
  parsePlaceAdminPath,
} from "../place-nav-sections";

const t = (key: string) => key;

const PLACE_ID = "44444444-4444-4444-8444-444444444444";

describe("parsePlaceAdminPath (place-context detection, FR-202)", () => {
  it("matches the place base route and sub-routes", () => {
    expect(parsePlaceAdminPath(`/admin/acme-co/places/${PLACE_ID}`)).toEqual({
      placeId: PLACE_ID,
      subRoute: null,
    });
    expect(
      parsePlaceAdminPath(`/admin/acme-co/places/${PLACE_ID}/settings`),
    ).toEqual({ placeId: PLACE_ID, subRoute: "settings" });
    expect(
      parsePlaceAdminPath(`/admin/acme-co/places/${PLACE_ID}/layout/designer`),
    ).toEqual({ placeId: PLACE_ID, subRoute: "layout" });
  });

  it("ignores query strings and hashes", () => {
    expect(
      parsePlaceAdminPath(`/admin/acme-co/places/${PLACE_ID}/calendar?view=week`),
    ).toEqual({ placeId: PLACE_ID, subRoute: "calendar" });
    expect(
      parsePlaceAdminPath(`/admin/acme-co/places/${PLACE_ID}#hours`),
    ).toEqual({ placeId: PLACE_ID, subRoute: null });
  });

  it("returns null for the places list and a create flow", () => {
    expect(parsePlaceAdminPath("/admin/acme-co/places")).toBeNull();
    expect(parsePlaceAdminPath("/admin/acme-co/places/new")).toBeNull();
    expect(parsePlaceAdminPath("/admin/acme-co/places/new/details")).toBeNull();
  });

  it("returns null for non-place admin paths and non-admin paths", () => {
    expect(parsePlaceAdminPath("/admin/acme-co/orders")).toBeNull();
    expect(
      parsePlaceAdminPath(`/admin/acme-co/events/${PLACE_ID}/edit`),
    ).toBeNull();
    expect(parsePlaceAdminPath(`/places/${PLACE_ID}`)).toBeNull();
    expect(parsePlaceAdminPath(null)).toBeNull();
    expect(parsePlaceAdminPath(undefined)).toBeNull();
  });

  it("handles encoded personal-workspace slugs", () => {
    expect(
      parsePlaceAdminPath(`/admin/%40steve-mcqueen/places/${PLACE_ID}/bookings`),
    ).toEqual({ placeId: PLACE_ID, subRoute: "bookings" });
  });
});

describe("buildPlaceNavSections (Venue + Operate groups, D3/FR-201)", () => {
  const build = (
    verification?: Parameters<typeof buildPlaceNavSections>[0]["verification"],
  ) => buildPlaceNavSections({ placeId: PLACE_ID, verification, t });

  it("produces the Venue and Operate groups in spec order", () => {
    const sections = build();
    expect(sections.map((s) => s.id)).toEqual(["place-venue", "place-operate"]);
    expect(sections.map((s) => s.label)).toEqual([
      "admin.plNavGroupVenue",
      "admin.plNavGroupOperate",
    ]);
  });

  it("routes every item to its existing surface under places/{placeId}", () => {
    const [venue, operate] = build();
    expect(venue?.items.map((i) => [i.id, i.route])).toEqual([
      // FR-401: one Settings item replaces Details (`/edit`) and
      // Verification (`/verify`), which both redirect to it.
      ["settings", `places/${PLACE_ID}/settings`],
      ["public-page", `places/${PLACE_ID}/page`],
      // Venue-hierarchy management (rooms + named calendars + availability).
      ["calendars", `places/${PLACE_ID}/calendars`],
      ["seat-layout", `places/${PLACE_ID}/layout`],
    ]);
    expect(operate?.items.map((i) => [i.id, i.route])).toEqual([
      ["calendar", `places/${PLACE_ID}/calendar`],
      ["bookings", `places/${PLACE_ID}/bookings`],
      ["volunteers", `places/${PLACE_ID}/volunteers`],
    ]);
  });

  it("gates Seat layout behind the seatingLayouts feature flag (only)", () => {
    const items = build().flatMap((s) => s.items);
    const seatLayout = items.find((i) => i.id === "seat-layout");
    expect(seatLayout?.featureFlag).toBe("seatingLayouts");
    // Nothing else is flag-gated.
    expect(
      items.filter((i) => i.featureFlag !== undefined).map((i) => i.id),
    ).toEqual(["seat-layout"]);
  });

  it("gives Seat layout prefix matching (it owns layout/designer)", () => {
    const items = build().flatMap((s) => s.items);
    expect(items.find((i) => i.id === "seat-layout")?.activeMatch).toBe(
      "prefix",
    );
    // Leaf routes keep the default exact match.
    expect(
      items.filter((i) => i.activeMatch !== undefined).map((i) => i.id),
    ).toEqual(["seat-layout"]);
  });

  it("carries NO rbac anywhere — place access is boolean ownership (D4)", () => {
    const sections = build();
    expect(sections.every((s) => s.rbac === undefined)).toBe(true);
    expect(
      sections.flatMap((s) => s.items).every((i) => i.rbac === undefined),
    ).toBe(true);
  });

  it("carries NO badge on Operate items — countOpen has no place-scoped filter (FR-201)", () => {
    const operate = build("UNVERIFIED").find((s) => s.id === "place-operate");
    expect(operate?.items.every((i) => i.badgeCount === undefined)).toBe(true);
  });

  // ── Verification "needs attention" dress (FR-302), now on Settings ──
  // The workflow moved into the settings page (FR-401), so the item that
  // leads to it inherits the signal.

  it("dresses Settings in tone danger + badge 1 for UNVERIFIED and REJECTED", () => {
    for (const status of ["UNVERIFIED", "REJECTED"] as const) {
      const item = build(status)
        .flatMap((s) => s.items)
        .find((i) => i.id === "settings");
      expect(item?.tone, status).toBe("danger");
      expect(item?.badgeCount, status).toBe(1);
    }
  });

  it("renders Settings plain for VERIFIED, PENDING, and while status is unknown", () => {
    for (const status of ["VERIFIED", "PENDING", undefined] as const) {
      const item = build(status)
        .flatMap((s) => s.items)
        .find((i) => i.id === "settings");
      expect(item, String(status)).toBeDefined();
      expect(item?.tone, String(status)).toBeUndefined();
      expect(item?.badgeCount, String(status)).toBeUndefined();
    }
  });

  it("keeps the mobile bottom bar reading Settings · Page · Calendar · Bookings (FR-203)", () => {
    const items = build().flatMap((s) => s.items);
    const barItems = items.filter((i) => !i.hideInBottomBar);
    expect(barItems.map((i) => i.id)).toEqual([
      "settings",
      "public-page",
      "calendar",
      "bookings",
    ]);
  });

  // Drift guard living with the data (dual-catalog rule): a key that misses
  // either catalog renders as the RAW key on the rail.
  it("resolves every label key in BOTH en and es catalogs", () => {
    const en = flattenCatalog(enMessages);
    const es = flattenCatalog(esMessages);

    const keys = [
      // Group + item labels (t is identity above, so labels ARE the keys).
      ...build().flatMap((s) => [s.label, ...s.items.map((i) => i.label)]),
      // The back-slot label the place rail context uses.
      "admin.plNavAllPlaces",
    ];

    for (const key of keys) {
      expect(en[key], `missing in en: ${key}`).toBeTruthy();
      expect(es[key], `missing in es: ${key}`).toBeTruthy();
    }
  });
});

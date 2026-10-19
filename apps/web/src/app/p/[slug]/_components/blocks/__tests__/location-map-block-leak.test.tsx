/**
 * LEAK TEST — the `location_map` block (freeform entity-page layout).
 *
 * The standard PLACE template suppresses this block and lets
 * `PlaceLogisticsCard` own location, so it is easy to fix the sidebar and
 * forget this path entirely. A venue on the freeform layout gets THIS.
 *
 * Two things it has to get right that the sidebar does not:
 *  - the block's `data` is a JSON bag on a row that predates these fields, so
 *    every flag is optional and must fail closed;
 *  - the derivation folds the area label into `data.address`, which on a
 *    LEGACY row is a street address. Echoing it into the area band would print
 *    somebody's street under the word "AREA".
 */
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import enMessages from "@/i18n/messages/en";

// Tiles on, as in production: the exact branch draws its pin map only then
// (with tiles off it keeps the address and maps link alone).
vi.mock("@/config/maps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/maps")>()),
  isMapEnabled: true,
}));
vi.mock("@/components/maps/LocationMapPreview", () => ({
  LocationMapPreview: (props: {
    isExact?: boolean;
    radiusMeters?: number | null;
  }) => (
    <div
      data-testid="location-map-preview"
      data-is-exact={String(props.isExact ?? true)}
      data-radius={String(props.radiusMeters ?? "")}
    />
  ),
}));

import { LocationMapBlock } from "../LocationMapBlock";

const STREET = "917 Woodland St, Nashville, TN 37206";

function block(data: Record<string, unknown>): PageBlockRecord {
  return {
    id: "block-location",
    pageId: "page-1",
    kind: "location_map",
    orderIndex: 0,
    data,
    visible: true,
  } as PageBlockRecord;
}

const renderBlock = (data: Record<string, unknown>) =>
  render(
    (
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <LocationMapBlock block={block(data)} />
        </TranslationProvider>
      </IthasFireProvider>
    ) as ReactElement,
  );

function expectNoWayToTheDoor(container: HTMLElement) {
  expect(container.innerHTML).not.toContain("917 Woodland");
  expect(container.innerHTML).not.toContain("37206");
  for (const a of Array.from(container.querySelectorAll("a"))) {
    expect(a.getAttribute("href") ?? "").not.toMatch(
      /google\.[^/]+\/maps|maps\.apple\.com|waze\.com/i,
    );
  }
}

describe("LocationMapBlock — withheld venue", () => {
  it("renders no map and no maps link when fully hidden", () => {
    const { container } = renderBlock({
      isExact: false,
      hidden: true,
      address: "East Nashville",
    });
    expect(screen.queryByTestId("location-map-preview")).toBeNull();
    expect(screen.getByTestId("location-block-area-band").textContent).toContain(
      "East Nashville",
    );
    expectNoWayToTheDoor(container);
  });

  it("renders a circle, not a pin, and still no maps link, when approximate", () => {
    const { container } = renderBlock({
      isExact: false,
      hidden: false,
      radiusMeters: 1200,
      lat: 36.1801,
      lng: -86.7355,
      address: "East Nashville",
    });
    const map = screen.getByTestId("location-map-preview");
    expect(map).toHaveAttribute("data-is-exact", "false");
    expect(map).toHaveAttribute("data-radius", "1200");
    expectNoWayToTheDoor(container);
  });

  it("never echoes a LEGACY row's street address into the area band", () => {
    // A block written before this feature: a real street in `address` and no
    // privacy flags at all. The resolver reads that as withheld — correctly —
    // and the band must NOT relabel the street as the area.
    const { container } = renderBlock({
      address: STREET,
      lat: 36.1789,
      lng: -86.7412,
    });
    expect(screen.queryByTestId("location-map-preview")).toBeNull();
    expect(screen.getByTestId("location-block-area-band").textContent).toContain(
      "Not published",
    );
    expectNoWayToTheDoor(container);
  });
});

describe("LocationMapBlock — exact venue keeps today's behaviour", () => {
  it("renders the address and the maps link", () => {
    renderBlock({
      isExact: true,
      hidden: false,
      address: STREET,
      lat: 36.1789,
      lng: -86.7412,
    });
    expect(screen.getByText(STREET)).toBeInTheDocument();
    // The pin map is the EXACT branch's alone (the withheld cases above
    // assert a circle or nothing).
    expect(screen.getByTestId("location-map-preview")).toHaveAttribute(
      "data-is-exact",
      "true",
    );
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toContain("google.com/maps");
    expect(screen.queryByTestId("location-block-area-band")).toBeNull();
  });
});

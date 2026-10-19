/**
 * LEAK TESTS — the deliverable of place-address-withholding on the web.
 *
 * These do not assert that the layout is pretty. They assert that for a venue
 * that withholds its address, the RENDERED public page contains:
 *   · no street address, in any form
 *   · no directions affordance (no maps link, no "get directions" trigger)
 *   · no copy-address control
 *   · no map at all when the radius is null
 *
 * The address is redacted server-side before it reaches these components, so a
 * test that only checked `formattedAddress` would pass against a component that
 * still drew a pin on the obfuscated centre and offered to route someone to it
 * — which is what these components actually did before this change. The
 * assertions below are therefore about AFFORDANCES, not just strings.
 */
import type { ReactElement } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type { EntitySummary } from "@th/types/repos/entity-pages";

import enMessages from "@/i18n/messages/en";

// MapLibre cannot run in jsdom. Stubbed so the assertions can read WHICH map
// was asked for (`data-is-exact` / `data-radius`) rather than whether a canvas
// painted — the props are the contract that matters here.
vi.mock("@/components/maps/LocationMapPreview", () => ({
  LocationMapPreview: (props: {
    latitude?: number | null;
    longitude?: number | null;
    isExact?: boolean;
    radiusMeters?: number | null;
  }) => (
    <div
      data-testid="location-map-preview"
      data-is-exact={String(props.isExact ?? true)}
      data-radius={String(props.radiusMeters ?? "")}
      data-lat={String(props.latitude ?? "")}
      data-lng={String(props.longitude ?? "")}
    />
  ),
}));

import { PlaceLogisticsCard } from "../PlaceLogisticsCard";

const STREET = "917 Woodland St, Nashville, TN 37206";

type PlaceEntity = Extract<EntitySummary, { type: "PLACE" }>;

function place(overrides: Partial<PlaceEntity>): PlaceEntity {
  return {
    type: "PLACE",
    id: "place-1",
    name: "The Bat Cave",
    formattedAddress: null,
    city: "Nashville",
    region: "TN",
    lat: null,
    lng: null,
    ...overrides,
  } as PlaceEntity;
}

const renderCard = (ui: ReactElement) =>
  render(
    <IthasFireProvider>
      <TranslationProvider locale="en-US" messages={enMessages}>
        {ui}
      </TranslationProvider>
    </IthasFireProvider>,
  );

/**
 * Every affordance that would take someone to the door, in one assertion.
 * Checked against the whole rendered subtree, not a component's props: the
 * question is what a reader can reach, not what a component intended.
 */
function expectNoWayToTheDoor(container: HTMLElement) {
  const html = container.innerHTML;

  // No street address, and no fragment of one.
  expect(html).not.toContain("917 Woodland");
  expect(html).not.toContain("37206");
  expect(screen.queryByText(STREET)).toBeNull();

  // No maps/navigation links of any provider.
  const hrefs = Array.from(container.querySelectorAll("a")).map(
    (a) => a.getAttribute("href") ?? "",
  );
  for (const href of hrefs) {
    expect(href).not.toMatch(/google\.[^/]+\/maps|maps\.apple\.com|waze\.com/i);
  }

  // No directions trigger and no copy-address control, by accessible name.
  expect(screen.queryByRole("button", { name: /directions/i })).toBeNull();
  expect(screen.queryByRole("link", { name: /directions/i })).toBeNull();
  expect(screen.queryByText(/copy address/i)).toBeNull();
}

describe("PlaceLogisticsCard — withheld with NO radius (fully hidden)", () => {
  const hidden = place({
    locationIsExact: false,
    locationHidden: true,
    locationRadiusMeters: null,
    areaLabel: "East Nashville",
  });

  it("renders NO map at all", () => {
    renderCard(<PlaceLogisticsCard entity={hidden} />);
    expect(screen.queryByTestId("location-map-preview")).toBeNull();
  });

  it("gives no way to the door", () => {
    const { container } = renderCard(<PlaceLogisticsCard entity={hidden} />);
    expectNoWayToTheDoor(container);
  });

  it("names the area and says the venue does not publish its address", () => {
    renderCard(<PlaceLogisticsCard entity={hidden} />);
    const band = screen.getByTestId("place-location-area-band");
    expect(band).toHaveAttribute("data-state", "hidden");
    expect(band.textContent).toContain("East Nashville");
    expect(band.textContent).toContain("doesn't publish its address");
  });

  it("stays shut even if the server hands back a stray address and coordinates", () => {
    // Defence in depth: this combination should be impossible (core redacts
    // before projecting), and if it ever happens the component must not be the
    // thing that publishes it.
    const { container } = renderCard(
      <PlaceLogisticsCard
        entity={place({
          locationIsExact: false,
          locationHidden: true,
          locationRadiusMeters: null,
          areaLabel: "East Nashville",
          formattedAddress: STREET,
          lat: 36.1789,
          lng: -86.7412,
        })}
      />,
    );
    expect(screen.queryByTestId("location-map-preview")).toBeNull();
    expectNoWayToTheDoor(container);
  });

  it("is withheld when the flags are ABSENT entirely (fail closed)", () => {
    // An `EntitySummary` built by an older client fallback carries no flags.
    const { container } = renderCard(
      <PlaceLogisticsCard
        entity={place({ formattedAddress: STREET, lat: 36.17, lng: -86.75 })}
      />,
    );
    expect(screen.queryByTestId("location-map-preview")).toBeNull();
    expectNoWayToTheDoor(container);
  });
});

describe("PlaceLogisticsCard — withheld WITH a radius (circle)", () => {
  const area = place({
    locationIsExact: false,
    locationHidden: false,
    locationRadiusMeters: 1200,
    areaLabel: "East Nashville",
    // The obfuscated CENTRE, as the server emits it. Not the venue.
    lat: 36.1801,
    lng: -86.7355,
  });

  it("draws a radius circle, never a pin", () => {
    renderCard(<PlaceLogisticsCard entity={area} />);
    const map = screen.getByTestId("location-map-preview");
    expect(map).toHaveAttribute("data-is-exact", "false");
    expect(map).toHaveAttribute("data-radius", "1200");
  });

  it("gives no way to the door", () => {
    const { container } = renderCard(<PlaceLogisticsCard entity={area} />);
    expectNoWayToTheDoor(container);
  });
});

describe("PlaceLogisticsCard — exact venue keeps today's behaviour", () => {
  const exact = place({
    locationIsExact: true,
    locationHidden: false,
    locationRadiusMeters: null,
    formattedAddress: STREET,
    lat: 36.1789,
    lng: -86.7412,
  });

  it("renders the address, a pin map, and a directions affordance", () => {
    const { container } = renderCard(<PlaceLogisticsCard entity={exact} />);
    expect(screen.getByText(STREET)).toBeInTheDocument();
    const map = screen.getByTestId("location-map-preview");
    expect(map).toHaveAttribute("data-is-exact", "true");
    expect(container.textContent).toContain("Get directions");
    expect(screen.queryByTestId("place-location-area-band")).toBeNull();
  });
});

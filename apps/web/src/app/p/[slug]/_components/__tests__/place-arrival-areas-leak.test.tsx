// @vitest-environment node
/**
 * LEAK TESTS for arrival areas on the edge-cached place page (arrival-areas
 * FR-008, NFR-001, NFR-002; acceptance: "For an OBSCURED place, the public
 * place page and event page payloads contain no area geometry or Directions
 * point").
 *
 * `/places/*` is `public, s-maxage=120` with no Cookie in Vary, so whatever
 * the server renders is handed to everyone behind a colo. The server path is
 * `loadPublicPlaceArrivalAreas` (anonymous client, `cacheablePublic` only)
 * → `PlaceLogisticsCard`'s `publicArrivalAreas`. These tests drive that path
 * end to end through `renderToString` (no effects run, exactly like SSR) and
 * grep the HTML for the area's label, coordinates and Directions point.
 *
 * The positive control (an EXACT place whose answer IS cacheable) proves the
 * grep would have caught a leak: the same fixture does reach the HTML when it
 * is allowed to.
 */
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type { EntitySummary } from "@th/types/repos/entity-pages";

import enMessages from "@/i18n/messages/en";

const mocks = vi.hoisted(() => ({
  publicPlace: vi.fn(),
  identityCalls: vi.fn(),
}));

// The SSR transport. The public loader must use the de-identified client;
// the identity client throws so any use of it on this path fails the test.
vi.mock("@/server/trpc-client", () => ({
  getPublicTrpcClient: () => ({
    arrivalAreas: { listForPlace: { query: mocks.publicPlace } },
  }),
  getServerTrpcClient: () => {
    mocks.identityCalls();
    throw new Error("the cached document must not read with identity");
  },
}));

vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => undefined,
}));

// MapLibre cannot run in jsdom (and the map is client-only anyway). The stub
// prints whatever areas it is handed, so a leak through the map prop is
// greppable too.
vi.mock("@/components/maps/LocationMapPreview", () => ({
  LocationMapPreview: (props: { arrivalAreas?: { areas: unknown[] } }) => (
    <div
      data-testid="location-map-preview"
      data-areas={JSON.stringify(props.arrivalAreas?.areas ?? [])}
    />
  ),
}));

import { loadPublicPlaceArrivalAreas } from "@/server/arrival-areas";
import { PlaceLogisticsCard } from "../PlaceLogisticsCard";

type PlaceEntity = Extract<EntitySummary, { type: "PLACE" }>;

const PLACE_ID = "00000000-0000-4000-8000-00000000b001";

/** Distinctive digits, so any fragment in the HTML is a leak. */
const SECRET_LAT = 36.1734567;
const SECRET_LNG = -86.7456789;
const DIRECTIONS_LAT = 36.1735555;

const AREA = {
  id: "00000000-0000-4000-8000-00000000b002",
  source: "PLACE" as const,
  kind: "PARKING" as const,
  label: "Back lot behind the barn",
  cost: "FREE" as const,
  priceText: null,
  note: "Gate code is 4471.",
  accessibleSpots: false,
  geometry: {
    type: "Polygon" as const,
    coordinates: [
      [
        [SECRET_LNG, SECRET_LAT],
        [SECRET_LNG + 0.0004, SECRET_LAT],
        [SECRET_LNG + 0.0004, SECRET_LAT + 0.0003],
        [SECRET_LNG, SECRET_LAT],
      ],
    ],
  },
  directions: { lat: DIRECTIONS_LAT, lng: SECRET_LNG + 0.0002 },
};

function place(overrides: Partial<PlaceEntity>): PlaceEntity {
  return {
    type: "PLACE",
    id: PLACE_ID,
    name: "The Barn",
    formattedAddress: null,
    city: "Nashville",
    region: "TN",
    lat: null,
    lng: null,
    ...overrides,
  } as PlaceEntity;
}

const OBSCURED = place({
  locationIsExact: false,
  locationHidden: false,
  locationRadiusMeters: 800,
  lat: 36.18,
  lng: -86.75,
  areaLabel: "East Nashville",
});

const EXACT = place({
  locationIsExact: true,
  formattedAddress: "410 Linden Ave, Nashville, TN 37206",
  lat: 36.17,
  lng: -86.74,
});

/** The server half of the place page, as the route runs it. */
async function serverRender(entity: PlaceEntity): Promise<string> {
  const publicArrivalAreas = await loadPublicPlaceArrivalAreas(entity.id);
  return renderToString(
    <IthasFireProvider>
      <TranslationProvider locale="en-US" messages={enMessages}>
        <PlaceLogisticsCard
          entity={entity}
          publicArrivalAreas={publicArrivalAreas}
        />
      </TranslationProvider>
    </IthasFireProvider>,
  );
}

function expectNoArea(html: string) {
  expect(html).not.toContain(AREA.label);
  expect(html).not.toContain(AREA.note);
  expect(html).not.toContain(String(SECRET_LAT));
  expect(html).not.toContain(String(SECRET_LNG));
  expect(html).not.toContain(String(DIRECTIONS_LAT));
  expect(html).not.toContain("Getting there");
  expect(html).not.toContain('data-testid="arrival-areas-legend"');
}

beforeEach(() => {
  mocks.publicPlace.mockReset();
  mocks.identityCalls.mockReset();
});

describe("place page SSR: arrival areas never ride the cached document unless public", () => {
  it("an answer that is NOT cacheablePublic renders nothing, even if it carries areas", async () => {
    // The API would never answer an anonymous read of an obscured place with
    // areas; this is the belt behind it: even a wrong answer stays out.
    mocks.publicPlace.mockResolvedValue({
      areas: [AREA],
      cacheablePublic: false,
    });
    const html = await serverRender(OBSCURED);
    expectNoArea(html);
    expect(mocks.publicPlace).toHaveBeenCalledWith({ placeId: PLACE_ID });
    expect(mocks.identityCalls).not.toHaveBeenCalled();
  });

  it("an obscured place's real anonymous answer (none) renders nothing", async () => {
    mocks.publicPlace.mockResolvedValue({ areas: [], cacheablePublic: true });
    expectNoArea(await serverRender(OBSCURED));
  });

  it("a failed read renders nothing", async () => {
    mocks.publicPlace.mockRejectedValue(new Error("api down"));
    expectNoArea(await serverRender(EXACT));
  });

  it("positive control: a cacheable EXACT answer does reach the HTML", async () => {
    mocks.publicPlace.mockResolvedValue({
      areas: [AREA],
      cacheablePublic: true,
    });
    const html = await serverRender(EXACT);
    expect(html).toContain(AREA.label);
    expect(html).toContain("Getting there");
    // The map stub received the geometry (it is client-only in the real
    // component; here it proves the grep above can see a leak).
    expect(html).toContain(String(SECRET_LNG));
    expect(mocks.identityCalls).not.toHaveBeenCalled();
  });
});

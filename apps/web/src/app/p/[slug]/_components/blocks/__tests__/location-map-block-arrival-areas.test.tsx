/**
 * Arrival areas on the freeform layout's `location_map` block
 * (arrival-areas FR-006). The standard template's `PlaceLogisticsCard` shows
 * them; a place on the "stack" / "grid" layout gets this block instead, so it
 * carries the same list: the server's anonymous areas from the page owner
 * context, replaced by the viewer's own after the probe, and never probed in
 * the page editor.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type { PageBlockRecord } from "@th/types/repos/entity-pages";

import enMessages from "@/i18n/messages/en";

const mocks = vi.hoisted(() => ({
  mapEnabled: true,
  session: { data: null, isPending: false } as {
    data: { user: { id: string } } | null;
    isPending: boolean;
  },
}));

vi.mock("@/config/maps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/maps")>()),
  get isMapEnabled() {
    return mocks.mapEnabled;
  },
}));
vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => mocks.session },
}));
vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: vi.fn() }),
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/places/the-barn",
}));
vi.mock("@/components/community/ReportEntityDialog", () => ({
  ReportEntityDialog: () => null,
}));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => undefined,
}));
vi.mock("@/components/maps/LocationMapPreview", () => ({
  LocationMapPreview: (props: { arrivalAreas?: { areas: unknown[] } }) => (
    <div
      data-testid="location-map-preview"
      data-area-count={String(props.arrivalAreas?.areas.length ?? 0)}
    />
  ),
}));

import { LocationMapBlock } from "../LocationMapBlock";
import { BlockPageOwnerProvider } from "../block-page-owner-context";
import type { VisibleArrivalArea } from "@/components/maps/arrival-areas";

const PLACE_ID = "00000000-0000-4000-8000-00000000d001";

const area = (
  id: string,
  label: string,
  kind: VisibleArrivalArea["kind"] = "PARKING",
): VisibleArrivalArea => ({
  id,
  source: "PLACE",
  kind,
  label,
  cost: "FREE",
  priceText: null,
  note: null,
  accessibleSpots: false,
  geometry: {
    type: "LineString",
    coordinates: [
      [-86.78, 36.16],
      [-86.779, 36.16],
    ],
  },
  directions: { lat: 36.16, lng: -86.7795 },
});

const PUBLIC_LOT = area("00000000-0000-4000-8000-00000000d002", "Front lot");
const LOAD_IN = area(
  "00000000-0000-4000-8000-00000000d003",
  "Stage door",
  "LOAD_IN",
);

const BLOCK = {
  id: "block-location",
  pageId: "page-1",
  kind: "location_map",
  orderIndex: 0,
  data: {
    isExact: true,
    hidden: false,
    address: "410 Linden Ave, Nashville, TN 37206",
    lat: 36.17,
    lng: -86.74,
  },
  visible: true,
} as PageBlockRecord;

const APPROX_BLOCK = {
  ...BLOCK,
  data: {
    isExact: false,
    hidden: false,
    radiusMeters: 800,
    lat: 36.18,
    lng: -86.75,
    address: "East Nashville",
  },
} as PageBlockRecord;

function renderBlock(
  owner: { arrivalAreas?: VisibleArrivalArea[]; publicPreview?: boolean },
  block: PageBlockRecord = BLOCK,
) {
  return render(
    <IthasFireProvider>
      <TranslationProvider locale="en-US" messages={enMessages}>
        <BlockPageOwnerProvider
          owner={{
            place: {
              id: PLACE_ID,
              name: "The Barn",
              acceptsRequests: false,
              pageSlug: "the-barn",
              ...owner,
            },
          }}
        >
          <LocationMapBlock block={block} />
        </BlockPageOwnerProvider>
      </TranslationProvider>
    </IthasFireProvider>,
  );
}

let fetchMock: ReturnType<typeof vi.fn>;
const settle = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  mocks.mapEnabled = true;
  mocks.session = { data: null, isPending: false };
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LocationMapBlock: arrival areas on the freeform layout", () => {
  it("lists the server's anonymous areas under the location", async () => {
    renderBlock({ arrivalAreas: [PUBLIC_LOT] });
    expect(screen.getByText("Getting there")).toBeInTheDocument();
    expect(screen.getByText("Front lot")).toBeInTheDocument();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("draws them on an exact place's pin map", () => {
    renderBlock({ arrivalAreas: [PUBLIC_LOT] });
    expect(screen.getByTestId("location-block-exact-map")).toBeInTheDocument();
    expect(screen.getByTestId("location-map-preview")).toHaveAttribute(
      "data-area-count",
      "1",
    );
  });

  it("with tiles off an exact place keeps the address, the maps link and the list, and no map box", () => {
    mocks.mapEnabled = false;
    renderBlock({ arrivalAreas: [PUBLIC_LOT] });
    expect(screen.queryByTestId("location-block-exact-map")).toBeNull();
    expect(screen.queryByTestId("location-map-preview")).toBeNull();
    expect(screen.getByRole("link", { name: /View on map/ })).toHaveAttribute(
      "href",
      expect.stringContaining("google.com/maps"),
    );
    expect(screen.getByText("Front lot")).toBeInTheDocument();
  });

  it("an exact place with an address but no point gets no map, only the list", () => {
    renderBlock(
      { arrivalAreas: [PUBLIC_LOT] },
      {
        ...BLOCK,
        data: { isExact: true, hidden: false, address: "410 Linden Ave" },
      } as PageBlockRecord,
    );
    expect(screen.queryByTestId("location-map-preview")).toBeNull();
    expect(screen.getByText("Front lot")).toBeInTheDocument();
  });

  it("draws them on the approximate-circle map too", () => {
    renderBlock({ arrivalAreas: [PUBLIC_LOT] }, APPROX_BLOCK);
    expect(screen.getByTestId("location-map-preview")).toHaveAttribute(
      "data-area-count",
      "1",
    );
  });

  it("replaces them with a signed-in manager's own list", async () => {
    mocks.session = { data: { user: { id: "manager" } }, isPending: false };
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ areas: [PUBLIC_LOT, LOAD_IN] }),
    });
    renderBlock({ arrivalAreas: [PUBLIC_LOT] });
    expect(await screen.findByText("Stage door")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/places/${PLACE_ID}/arrival-areas`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("never probes in the page editor", async () => {
    mocks.session = { data: { user: { id: "manager" } }, isPending: false };
    renderBlock({ arrivalAreas: [PUBLIC_LOT], publicPreview: true });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Stage door")).toBeNull();
  });

  it("renders nothing extra without areas", () => {
    renderBlock({});
    expect(screen.queryByText("Getting there")).toBeNull();
  });
});

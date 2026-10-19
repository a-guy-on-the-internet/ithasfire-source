/**
 * The place page's per-viewer arrival areas (arrival-areas FR-006, FR-008)
 * follow the person signed in, not the tab.
 *
 * `/places/*` stays mounted across a sign-out (AppNavbar) and a sign-in
 * through the in-page overlay, so the probe answer must be tied to the user
 * it was fetched for: manager A's list (load-in, a withheld place's areas)
 * must never stay on screen for B, even when B's own probe fails.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";
import type { EntitySummary } from "@th/types/repos/entity-pages";

import enMessages from "@/i18n/messages/en";

const mocks = vi.hoisted(() => ({
  session: { data: null, isPending: false } as {
    data: { user: { id: string } } | null;
    isPending: boolean;
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
// MapLibre cannot run in jsdom; the list is what this test reads.
vi.mock("@/components/maps/LocationMapPreview", () => ({
  LocationMapPreview: () => <div data-testid="location-map-preview" />,
}));

import { PlaceLogisticsCard } from "../PlaceLogisticsCard";
import type { VisibleArrivalArea } from "@/components/maps/arrival-areas";

type PlaceEntity = Extract<EntitySummary, { type: "PLACE" }>;

const PLACE_ID = "00000000-0000-4000-8000-00000000c001";

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

const PUBLIC_LOT = area("00000000-0000-4000-8000-00000000c002", "Front lot");
const A_LOAD_IN = area(
  "00000000-0000-4000-8000-00000000c003",
  "Stage door for A",
  "LOAD_IN",
);

const ENTITY = {
  type: "PLACE",
  id: PLACE_ID,
  name: "The Barn",
  formattedAddress: "410 Linden Ave, Nashville, TN 37206",
  city: "Nashville",
  region: "TN",
  lat: 36.17,
  lng: -86.74,
  locationIsExact: true,
} as PlaceEntity;

let fetchMock: ReturnType<typeof vi.fn>;

const ok = (areas: VisibleArrivalArea[] | null) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve({ areas }),
});
const fail = { ok: false, status: 500, json: () => Promise.resolve({}) };

function card(props: { publicPreview?: boolean } = {}) {
  return (
    <IthasFireProvider>
      <TranslationProvider locale="en-US" messages={enMessages}>
        <PlaceLogisticsCard
          entity={ENTITY}
          publicArrivalAreas={[PUBLIC_LOT]}
          {...props}
        />
      </TranslationProvider>
    </IthasFireProvider>
  );
}

const signIn = (id: string) => {
  mocks.session = { data: { user: { id } }, isPending: false };
};
const signOut = () => {
  mocks.session = { data: null, isPending: false };
};

beforeEach(() => {
  signOut();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PlaceLogisticsCard: the viewer's areas belong to that viewer", () => {
  it("drops A's list on sign-out and never shows it to B when B's probe fails", async () => {
    signIn("user-a");
    fetchMock.mockResolvedValueOnce(ok([PUBLIC_LOT, A_LOAD_IN]));
    const { rerender } = render(card());
    expect(await screen.findByText("Stage door for A")).toBeInTheDocument();

    signOut();
    rerender(card());
    expect(screen.queryByText("Stage door for A")).toBeNull();
    expect(screen.getByText("Front lot")).toBeInTheDocument();

    signIn("user-b");
    fetchMock.mockResolvedValueOnce(fail);
    rerender(card());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText("Stage door for A")).toBeNull();
    expect(screen.getByText("Front lot")).toBeInTheDocument();
  });

  it("drops A's late answer when B signed in while it was in flight", async () => {
    signIn("user-a");
    let resolveA: (v: unknown) => void = () => undefined;
    fetchMock.mockReturnValueOnce(
      new Promise((r) => {
        resolveA = r;
      }),
    );
    const { rerender } = render(card());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Straight from A to B (no signed-out render in between).
    signIn("user-b");
    fetchMock.mockReturnValueOnce(new Promise(() => {}));
    rerender(card());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveA(ok([PUBLIC_LOT, A_LOAD_IN]));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.queryByText("Stage door for A")).toBeNull();
    expect(screen.getByText("Front lot")).toBeInTheDocument();
  });

  it("a stranger is never probed", async () => {
    render(card());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText("Front lot")).toBeInTheDocument();
  });

  it("the editor's public preview never probes, even for the manager", async () => {
    signIn("user-a");
    fetchMock.mockResolvedValue(ok([PUBLIC_LOT, A_LOAD_IN]));
    render(card({ publicPreview: true }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Stage door for A")).toBeNull();
    expect(screen.getByText("Front lot")).toBeInTheDocument();
  });

  it("?preview=public (the editor's mobile iframe) never probes, even for the manager", async () => {
    const before = window.location.href;
    window.history.replaceState(null, "", "/p/the-barn?preview=public");
    try {
      signIn("user-a");
      fetchMock.mockResolvedValue(ok([PUBLIC_LOT, A_LOAD_IN]));
      render(card());
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.queryByText("Stage door for A")).toBeNull();
      expect(screen.getByText("Front lot")).toBeInTheDocument();
    } finally {
      window.history.replaceState(null, "", before);
    }
  });

  it("any other query still probes for the manager", async () => {
    const before = window.location.href;
    window.history.replaceState(null, "", "/p/the-barn?preview=desktop");
    try {
      signIn("user-a");
      fetchMock.mockResolvedValue(ok([PUBLIC_LOT, A_LOAD_IN]));
      render(card());
      expect(await screen.findByText("Stage door for A")).toBeInTheDocument();
    } finally {
      window.history.replaceState(null, "", before);
    }
  });
});

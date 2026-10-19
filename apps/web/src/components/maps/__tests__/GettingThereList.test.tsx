/**
 * "Getting there", the text twin of the arrival-areas map (arrival-areas
 * FR-006, FR-007, FR-011, NFR-003, NFR-005).
 *
 * Pinned here:
 *  · rows in the server's order, labels and notes as authored;
 *  · keyboard: every row is a Tab stop, focus SELECTS (the map follows),
 *    Enter / Space / click opens the card;
 *  · a shape tapped on the map selects its row and opens its card;
 *  · Directions only when the area has a point, and never a copy-address row;
 *  · Report opens the shared dialog for ARRIVAL_AREA and, from an event page,
 *    always sends `seenOnEventId`;
 *  · nothing at all (no heading) without areas.
 */
import type { ReactElement } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";

const mocks = vi.hoisted(() => ({
  session: { data: { user: { id: "u1" } }, isPending: false } as {
    data: { user: { id: string } } | null;
    isPending: boolean;
  },
  showSignInOverlay: vi.fn(),
  dialogProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/auth/auth-client", () => ({
  authClient: { useSession: () => mocks.session },
}));

vi.mock("@/components/layout/AppOverlayProvider", () => ({
  useAppOverlay: () => ({ showSignInOverlay: mocks.showSignInOverlay }),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/places/linden-hall",
}));

vi.mock("@/components/community/ReportEntityDialog", () => ({
  ReportEntityDialog: (props: Record<string, unknown>) => {
    mocks.dialogProps.push(props);
    return <div role="dialog" data-testid="report-dialog" />;
  },
}));

import {
  GettingThereList,
  useArrivalAreaSelection,
} from "../GettingThereList";
import type { VisibleArrivalArea } from "../arrival-areas";

const LOT: VisibleArrivalArea = {
  id: "00000000-0000-4000-8000-000000000001",
  source: "PLACE",
  kind: "PARKING",
  label: "Church lot across Linden",
  cost: "PAID",
  priceText: "$10 after 6pm",
  note: "Closed Sunday mornings.",
  accessibleSpots: true,
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-86.78, 36.16],
        [-86.779, 36.16],
        [-86.779, 36.161],
        [-86.78, 36.16],
      ],
    ],
  },
  directions: { lat: 36.1603, lng: -86.7794 },
};

const STREET: VisibleArrivalArea = {
  ...LOT,
  id: "00000000-0000-4000-8000-000000000002",
  label: "Elm St, both sides",
  cost: "FREE",
  priceText: null,
  note: null,
  accessibleSpots: false,
  geometry: {
    type: "LineString",
    coordinates: [
      [-86.781, 36.159],
      [-86.78, 36.159],
    ],
  },
};

const DROP_OFF: VisibleArrivalArea = {
  ...LOT,
  id: "00000000-0000-4000-8000-000000000003",
  kind: "ACCESSIBLE_DROP_OFF",
  label: "Side door, level entry",
  cost: "UNKNOWN",
  priceText: null,
  note: null,
  accessibleSpots: false,
  // A malformed stored shape arrives as null: listed, not drawn.
  geometry: null,
  directions: null,
};

const AREAS = [LOT, STREET, DROP_OFF];

function Harness({
  areas,
  seenOnEventId,
}: {
  areas: VisibleArrivalArea[];
  seenOnEventId?: string;
}) {
  const selection = useArrivalAreaSelection(areas);
  return (
    <>
      <output data-testid="map-selected">{selection.selectedId ?? ""}</output>
      <button
        type="button"
        data-testid="tap-street-shape"
        onClick={() => selection.selectFromMap(STREET.id)}
      >
        tap
      </button>
      <GettingThereList
        areas={areas}
        selection={selection}
        seenOnEventId={seenOnEventId}
      />
    </>
  );
}

const renderUi = (ui: ReactElement) =>
  render(
    <IthasFireProvider>
      <TranslationProvider locale="en-US" messages={enMessages}>
        {ui}
      </TranslationProvider>
    </IthasFireProvider>,
  );

const rows = () => screen.getAllByTestId("getting-there-row");
const mapSelected = () => screen.getByTestId("map-selected").textContent;

beforeEach(() => {
  mocks.session = { data: { user: { id: "u1" } }, isPending: false };
  mocks.showSignInOverlay.mockReset();
  mocks.dialogProps = [];
  Element.prototype.scrollIntoView = vi.fn();
});

describe("GettingThereList", () => {
  it("renders nothing, not even the heading, without areas", () => {
    const { container } = renderUi(<Harness areas={[]} />);
    expect(screen.queryByText("Getting there")).toBeNull();
    expect(container.querySelector('[data-testid="getting-there"]')).toBeNull();
  });

  it("lists every area in the server's order with kind, cost and spots", () => {
    renderUi(<Harness areas={AREAS} />);
    expect(
      screen.getByRole("heading", { level: 3, name: "Getting there" }),
    ).toBeInTheDocument();
    expect(rows().map((r) => r.textContent)).toEqual([
      "Church lot across LindenParking · Paid · $10 after 6pm · Accessible spots",
      "Elm St, both sidesParking · Free",
      "Side door, level entryAccessible drop-off · Cost unknown",
    ]);
  });

  it("each row is a disclosure button wired to its card", () => {
    renderUi(<Harness areas={AREAS} />);
    for (const row of rows()) {
      expect(row.tagName).toBe("BUTTON");
      expect(row).toHaveAttribute("aria-expanded", "false");
      const card = document.getElementById(row.getAttribute("aria-controls")!);
      expect(card).not.toBeNull();
      expect(card).toHaveAttribute("hidden");
    }
  });

  it("Tab through the list: focus selects each area, so the map follows", async () => {
    const user = userEvent.setup();
    renderUi(<Harness areas={AREAS} />);
    // Skip the harness's own button.
    screen.getByTestId("tap-street-shape").focus();

    await user.tab();
    expect(rows()[0]).toHaveFocus();
    expect(mapSelected()).toBe(LOT.id);
    expect(rows()[0]).toHaveAttribute("data-selected", "true");

    await user.tab();
    expect(rows()[1]).toHaveFocus();
    expect(mapSelected()).toBe(STREET.id);
    expect(rows()[0]).not.toHaveAttribute("data-selected");

    await user.tab();
    expect(rows()[2]).toHaveFocus();
    expect(mapSelected()).toBe(DROP_OFF.id);
    // Focus alone never opens a card.
    for (const row of rows()) {
      expect(row).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("Enter opens the card with the note as authored; Enter again closes it", async () => {
    const user = userEvent.setup();
    renderUi(<Harness areas={AREAS} />);
    rows()[0]!.focus();
    await user.keyboard("{Enter}");
    expect(rows()[0]).toHaveAttribute("aria-expanded", "true");
    const card = document.getElementById(rows()[0]!.getAttribute("aria-controls")!)!;
    expect(card).not.toHaveAttribute("hidden");
    expect(within(card).getByText("Closed Sunday mornings.")).toBeInTheDocument();

    await user.keyboard("{Enter}");
    expect(rows()[0]).toHaveAttribute("aria-expanded", "false");
  });

  it("Tab moves from an open card's controls to the next row, closing the card", async () => {
    const user = userEvent.setup();
    renderUi(<Harness areas={AREAS} />);
    rows()[0]!.focus();
    await user.keyboard(" ");
    await user.tab();
    expect(
      screen.getByRole("button", { name: /Directions to Church lot/ }),
    ).toHaveFocus();
    await user.tab();
    expect(
      screen.getByRole("button", { name: "Report Church lot across Linden" }),
    ).toHaveFocus();
    await user.tab();
    expect(rows()[1]).toHaveFocus();
    expect(mapSelected()).toBe(STREET.id);
    expect(rows()[0]).toHaveAttribute("aria-expanded", "false");
  });

  it("a shape tapped on the map selects its row and opens its card", () => {
    renderUi(<Harness areas={AREAS} />);
    fireEvent.click(screen.getByTestId("tap-street-shape"));
    expect(mapSelected()).toBe(STREET.id);
    expect(rows()[1]).toHaveAttribute("data-selected", "true");
    expect(rows()[1]).toHaveAttribute("aria-expanded", "true");
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("offers Directions only at the area's own point, with no copy-address row", async () => {
    const user = userEvent.setup();
    renderUi(<Harness areas={AREAS} />);
    await user.click(rows()[0]!);
    await user.click(
      screen.getByRole("button", { name: /Directions to Church lot/ }),
    );
    const google = screen.getByRole("menuitem", { name: /Google Maps/ });
    expect(google.getAttribute("href")).toContain("36.1603%2C-86.7794");
    expect(screen.queryByRole("menuitem", { name: /copy/i })).toBeNull();
    // No booking or partner links of any kind.
    for (const item of screen.getAllByRole("menuitem")) {
      expect(item.getAttribute("href") ?? "").toMatch(
        /google\.com\/maps|maps\.apple\.com|waze\.com/,
      );
    }
  });

  it("omits Directions when the area has no point", async () => {
    const user = userEvent.setup();
    renderUi(<Harness areas={AREAS} />);
    await user.click(rows()[2]!);
    const card = document.getElementById(rows()[2]!.getAttribute("aria-controls")!)!;
    expect(within(card).queryByRole("button", { name: /Directions/ })).toBeNull();
    expect(within(card).getByRole("button", { name: /Report/ })).toBeInTheDocument();
  });

  it("Report opens the shared dialog for ARRIVAL_AREA with seenOnEventId", async () => {
    const user = userEvent.setup();
    const eventId = "00000000-0000-4000-8000-0000000000ee";
    renderUi(<Harness areas={AREAS} seenOnEventId={eventId} />);
    await user.click(rows()[0]!);
    await user.click(
      screen.getByRole("button", { name: "Report Church lot across Linden" }),
    );
    expect(screen.getByTestId("report-dialog")).toBeInTheDocument();
    expect(mocks.dialogProps.at(-1)).toMatchObject({
      subjectType: "ARRIVAL_AREA",
      subjectId: LOT.id,
      subjectName: LOT.label,
      seenOnEventId: eventId,
      open: true,
    });
  });

  it("Report from a place page sends no event id", async () => {
    const user = userEvent.setup();
    renderUi(<Harness areas={AREAS} />);
    await user.click(rows()[0]!);
    await user.click(screen.getByRole("button", { name: /^Report / }));
    expect(mocks.dialogProps.at(-1)).not.toHaveProperty("seenOnEventId");
  });

  it("a signed-out viewer is sent to sign in instead of the dialog", async () => {
    mocks.session = { data: null, isPending: false };
    const user = userEvent.setup();
    renderUi(<Harness areas={AREAS} />);
    await user.click(rows()[0]!);
    await act(async () => {
      await user.click(screen.getByRole("button", { name: /^Report / }));
    });
    expect(mocks.showSignInOverlay).toHaveBeenCalledWith({
      redirect: "/places/linden-hall",
    });
    expect(screen.queryByTestId("report-dialog")).toBeNull();
  });
});

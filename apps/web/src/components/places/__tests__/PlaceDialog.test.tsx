/**
 * PlaceDialog — what an EDIT save sends.
 *
 * The edit form prefills from the public place read, which has no street
 * line or postcode. Sending that address back would blank both on the
 * server, so an edit sends `address` ONLY when the moderator picked a new
 * one; a name-only correction omits it and the server keeps every stored
 * address field (`updateCommunityPlace`). The Unit input stays locked until
 * that pick, and the unit folds into the freshly picked address.
 *
 * MOCKS: tamagui and @th/ui reduced to DOM; LocationAutocomplete is a stub
 * whose button hands up one geocoder result. tRPC is a double.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({
  getPlacePublic: vi.fn(),
  createPlace: vi.fn(),
  updatePlace: vi.fn(),
  archivePlace: vi.fn(),
}));

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/@dev/events/new/community" }));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("@/lib/trace-ignored-error", () => ({
  traceIgnoredError: () => () => undefined,
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return { XStack: Stack, YStack: Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({ children }: { children?: ReactNode }) =>
    React.createElement("span", null, children);
  const Button = ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", onClick: onPress, disabled, "data-testid": testID },
      children,
    );
  const TextInput = ({
    value,
    onChangeText,
    id,
    testId,
    disabled,
  }: {
    value: string;
    onChangeText: (v: string) => void;
    id?: string;
    testId?: string;
    disabled?: boolean;
  }) =>
    React.createElement("input", {
      id,
      value,
      disabled,
      "data-testid": testId,
      onChange: (e: { target: { value: string } }) => onChangeText(e.target.value),
    });
  const Modal = Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? React.createElement("div", { role: "dialog" }, children) : null,
    {
      Panel: ({ children }: { children?: ReactNode }) =>
        React.createElement("div", null, children),
      Header: ({ title }: { title: string }) => React.createElement("h2", null, title),
      Body: ({ children }: { children?: ReactNode }) =>
        React.createElement("div", null, children),
      Footer: ({ children }: { children?: ReactNode }) =>
        React.createElement("div", null, children),
    },
  );
  return {
    Text,
    Button,
    TextInput,
    Modal,
    useLocale: () => "en",
    useTranslations: () => (key: string) => key,
  };
});

const NEW_HIT = {
  lat: 36.1191,
  lng: -86.7553,
  formattedAddress: "2190A Nolensville Pike, Nashville, TN 37210, United States",
  name: null,
  streetLine: "2190A Nolensville Pike",
  locality: "Nashville",
  region: "Tennessee",
  regionCode: "TN",
  countryCode: "US",
  postalCode: "37210",
};

vi.mock("@/components/maps/LocationAutocomplete", async () => {
  const React = await import("react");
  return {
    default: ({
      value,
      onSelectResult,
    }: {
      value: string;
      onSelectResult: (r: typeof NEW_HIT) => void;
    }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "stub-pick-address",
            onClick: () => onSelectResult(NEW_HIT),
          },
          "pick",
        ),
        React.createElement(
          "output",
          { "data-testid": "stub-address-text" },
          value,
        ),
      ),
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      places: { getPlacePublic: { fetch: m.getPlacePublic } },
    }),
    community: {
      createPlace: {
        useMutation: () => ({ mutateAsync: m.createPlace, isPending: false }),
      },
      updatePlace: {
        useMutation: () => ({ mutateAsync: m.updatePlace, isPending: false }),
      },
      archivePlace: {
        useMutation: () => ({ mutateAsync: m.archivePlace, isPending: false }),
      },
    },
  },
}));

const { PlaceDialog } = await import("../PlaceDialog");

const PLACE_ID = "00000000-0000-4000-8000-0000000000a1";
const PLACE = {
  placeId: PLACE_ID,
  name: "Corner Bar Suoth",
  formattedAddress: "2190 Nolensville Pike, Nashville, TN 37211, USA",
  city: "Nashville",
  region: "TN",
  lat: 36.1186,
  lng: -86.7553,
  timezone: "America/Chicago",
  status: "ACTIVE" as const,
  verificationStatus: "UNVERIFIED" as const,
};

function renderEdit(
  extra: { hideArchive?: boolean; canArchive?: boolean; linkedListingCount?: number } = {},
) {
  const onSaved = vi.fn();
  render(
    <PlaceDialog
      mode={{
        kind: "edit",
        place: PLACE,
        canEdit: true,
        canArchive: extra.canArchive ?? true,
        linkedListingCount: extra.linkedListingCount ?? 0,
        hideArchive: extra.hideArchive,
      }}
      onClose={vi.fn()}
      onSaved={onSaved}
      onUseExisting={vi.fn()}
      onArchived={vi.fn()}
    />,
  );
  return { onSaved };
}

async function hydrated() {
  await waitFor(() =>
    expect(
      (screen.getByTestId("place-dialog-name") as HTMLInputElement).value,
    ).toBe("Corner Bar Suoth"),
  );
}

function rename(to: string) {
  fireEvent.change(screen.getByTestId("place-dialog-name"), {
    target: { value: to },
  });
}

const sent = () => m.updatePlace.mock.calls[0]![0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  // The public read: no street line, no postcode.
  m.getPlacePublic.mockResolvedValue({
    place: { ...PLACE, countryCode: "US" },
  });
  m.updatePlace.mockResolvedValue({ ...PLACE, name: "Corner Bar South" });
});

describe("PlaceDialog — an edit sends the address only when it changed", () => {
  it("a name-only correction omits the address", async () => {
    const { onSaved } = renderEdit();
    await hydrated();
    rename("Corner Bar South");
    fireEvent.click(screen.getByTestId("place-dialog-submit"));

    await waitFor(() => expect(m.updatePlace).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual({
      placeId: PLACE_ID,
      name: "Corner Bar South",
      // No stored unit, none typed: sent as "none" (absent would keep it).
      line2: null,
      clientKey: expect.any(String),
    });
    expect(sent()).not.toHaveProperty("address");
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it("a newly picked address is sent in full", async () => {
    renderEdit();
    await hydrated();
    rename("Corner Bar South");
    fireEvent.click(screen.getByTestId("stub-pick-address"));
    fireEvent.click(screen.getByTestId("place-dialog-submit"));

    await waitFor(() => expect(m.updatePlace).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({
      placeId: PLACE_ID,
      name: "Corner Bar South",
      address: {
        formatted: NEW_HIT.formattedAddress,
        line1: "2190A Nolensville Pike",
        postalCode: "37210",
        countryCode: "US",
        lat: NEW_HIT.lat,
        lng: NEW_HIT.lng,
      },
    });
  });

  it("a unit-only edit sends the unit alone, without re-picking the address", async () => {
    renderEdit();
    await hydrated();
    const unit = screen.getByTestId("place-dialog-unit") as HTMLInputElement;
    expect(unit.disabled).toBe(false);
    fireEvent.change(unit, { target: { value: " Unit A " } });
    fireEvent.click(screen.getByTestId("place-dialog-submit"));

    await waitFor(() => expect(m.updatePlace).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({ placeId: PLACE_ID, line2: "Unit A" });
    expect(sent()).not.toHaveProperty("address");
  });

  it("pick, then a unit: the unit goes as address.line2, never folded into the text", async () => {
    renderEdit();
    await hydrated();
    fireEvent.click(screen.getByTestId("stub-pick-address"));
    const unit = screen.getByTestId("place-dialog-unit") as HTMLInputElement;
    fireEvent.change(unit, { target: { value: "Unit A" } });
    fireEvent.click(screen.getByTestId("place-dialog-submit"));

    await waitFor(() => expect(m.updatePlace).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({
      address: {
        line1: "2190A Nolensville Pike",
        line2: "Unit A",
        formatted: NEW_HIT.formattedAddress,
        postalCode: "37210",
        countryCode: "US",
      },
    });
    expect(sent()).not.toHaveProperty("line2");
  });

  it.each([
    ["a plain unit", "Unit A"],
    ["a unit with a comma", "Unit A, Floor 2"],
    ["a unit equal to the city", "Nashville"],
  ])(
    "prefills Unit from the stored unit and shows the Address without it (%s)",
    async (_label, storedUnit) => {
      m.getPlacePublic.mockResolvedValue({
        place: {
          ...PLACE,
          formattedAddress: `2190 Nolensville Pike, ${storedUnit}, Nashville, TN 37211, USA`,
          addressLine1: "2190 Nolensville Pike",
          addressLine2: storedUnit,
          countryCode: "US",
        },
      });
      renderEdit();
      await hydrated();

      expect(
        (screen.getByTestId("place-dialog-unit") as HTMLInputElement).value,
      ).toBe(storedUnit);
      // Only the unit at its position goes; the city stays.
      expect(screen.getByTestId("stub-address-text").textContent).toBe(
        PLACE.formattedAddress,
      );
    },
  );

  it("clearing a stored unit sends line2 null (clear), not an absent field (keep)", async () => {
    m.getPlacePublic.mockResolvedValue({
      place: {
        ...PLACE,
        formattedAddress: "2190 Nolensville Pike, Unit A, Nashville, TN 37211, USA",
        addressLine1: "2190 Nolensville Pike",
        addressLine2: "Unit A",
        countryCode: "US",
      },
    });
    renderEdit();
    await hydrated();
    fireEvent.change(screen.getByTestId("place-dialog-unit"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("place-dialog-submit"));

    await waitFor(() => expect(m.updatePlace).toHaveBeenCalledTimes(1));
    expect(sent()).toMatchObject({ line2: null });
    expect(sent()).toHaveProperty("line2", null);
  });

  it("a place stored without a country asks for the address again, on the Address field", async () => {
    m.updatePlace.mockRejectedValue(
      Object.assign(new Error("invalid"), {
        data: {
          appCode: "INVALID_INPUT",
          meta: { placeId: PLACE_ID, reason: "ADDRESS_INCOMPLETE" },
        },
      }),
    );
    const { onSaved } = renderEdit();
    await hydrated();
    rename("Corner Bar South");
    fireEvent.click(screen.getByTestId("place-dialog-submit"));

    expect(
      await screen.findByText("communityCreate.pdErrAddressIncomplete"),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByTestId("place-dialog-notice")).toBeNull();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("a name-only edit of a place stored without a country is sent; the server decides", async () => {
    m.getPlacePublic.mockResolvedValue({
      place: { ...PLACE, countryCode: null },
    });
    renderEdit();
    await hydrated();
    rename("Corner Bar South");
    fireEvent.click(screen.getByTestId("place-dialog-submit"));

    await waitFor(() => expect(m.updatePlace).toHaveBeenCalledTimes(1));
    expect(sent()).not.toHaveProperty("address");
    expect(screen.queryByText("communityCreate.errCountryMissing")).toBeNull();
  });
});

describe("PlaceDialog — hideArchive", () => {
  it("offers archive by default", async () => {
    renderEdit();
    await hydrated();
    expect(screen.getByTestId("place-dialog-archive")).toBeTruthy();
  });

  it("renders no archive control at all, enabled or disabled", async () => {
    renderEdit({ hideArchive: true, linkedListingCount: 2 });
    await hydrated();
    expect(screen.queryByTestId("place-dialog-archive")).toBeNull();
    expect(screen.queryByTestId("place-dialog-archive-blocked")).toBeNull();
    expect(screen.getByTestId("place-dialog-submit")).toBeTruthy();
  });
});

describe("PlaceDialog — opened straight on the archive confirm", () => {
  function renderArchive() {
    const onClose = vi.fn();
    const onArchived = vi.fn();
    render(
      <PlaceDialog
        mode={{
          kind: "edit",
          place: PLACE,
          canEdit: true,
          canArchive: true,
          linkedListingCount: 0,
          startAt: "archive",
        }}
        onClose={onClose}
        onSaved={vi.fn()}
        onUseExisting={vi.fn()}
        onArchived={onArchived}
      />,
    );
    return { onClose, onArchived };
  }

  it("shows the confirm, not the form, and reads nothing to prefill", () => {
    renderArchive();
    expect(screen.getByTestId("place-dialog-archive-confirm-btn")).toBeTruthy();
    expect(
      screen.getByText("communityCreate.pdArchiveConfirmBody"),
    ).toBeTruthy();
    expect(screen.queryByTestId("place-dialog-name")).toBeNull();
    expect(m.getPlacePublic).not.toHaveBeenCalled();
  });

  it("Keep it closes the dialog instead of showing the form", () => {
    const { onClose } = renderArchive();
    fireEvent.click(
      screen.getByRole("button", { name: "communityCreate.pdKeepIt" }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("place-dialog-name")).toBeNull();
  });

  it("Archive archives the place", async () => {
    m.archivePlace.mockResolvedValue({});
    const { onArchived } = renderArchive();
    fireEvent.click(screen.getByTestId("place-dialog-archive-confirm-btn"));
    await waitFor(() => expect(onArchived).toHaveBeenCalledTimes(1));
    expect(m.archivePlace.mock.calls[0]![0]).toMatchObject({
      placeId: PLACE_ID,
    });
  });
});

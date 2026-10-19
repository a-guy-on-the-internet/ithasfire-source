/**
 * CommunityQuickCreateForm — the Location field links a picked place.
 *
 * A place picked in the one box is SENT as `placeId` (the server copies the
 * address and pin from it), with no address fields beside it; a picked
 * address is sent as the address, with no `placeId`. The place's zone
 * becomes the listing's zone.
 *
 * MOCKS: the one-box field is a stub whose buttons fire the same callbacks
 * the real one does (it has its own suite); the rest of the form renders as
 * DOM under a key-echo translator.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const m = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  push: vi.fn(),
}));

vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push: m.push }) }));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/community/use-second-factor-required-toast", () => ({
  useSecondFactorRequiredToast: () => () => false,
}));
vi.mock("../RecurrenceFields", () => ({
  RecurrenceFields: () => null,
  emptyRecurrence: {
    freq: "NONE",
    interval: 1,
    byWeekday: [],
    monthlyMode: "DAY_OF_MONTH",
    untilLocal: "",
  },
}));

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({ children }: { children?: ReactNode }) =>
    React.createElement("div", null, children);
  return {
    XStack: Stack,
    YStack: Stack,
    styled: () => Stack,
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Text: ({ children, id }: { children?: ReactNode; id?: string }) =>
      React.createElement("span", { id }, children),
    Button: ({
      children,
      onPress,
      testID,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      testID?: string;
    }) =>
      React.createElement(
        "button",
        { type: "button", onClick: onPress, "data-testid": testID },
        children,
      ),
    TextInput: ({
      value,
      onChangeText,
      testId,
    }: {
      value: string;
      onChangeText: (v: string) => void;
      testId?: string;
    }) =>
      React.createElement("input", {
        value,
        "data-testid": testId,
        onChange: (e: { target: { value: string } }) =>
          onChangeText(e.target.value),
      }),
    useTranslations: () => (key: string) => key,
  };
});

vi.mock("../../../_components/_form-bits", async () => {
  const React = await import("react");
  return {
    Field: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children),
    // A span, as the real FieldLabel is: a <label> here would name the
    // combobox by wrapping and hide a missing aria-labelledby.
    FieldLabel: ({ children, id }: { children?: ReactNode; id?: string }) =>
      React.createElement("span", { id }, children),
    NativeDateTimeInput: React.forwardRef(
      (props: Record<string, unknown>, ref: React.Ref<HTMLInputElement>) =>
        React.createElement("input", { ...props, ref }),
    ),
  };
});

vi.mock("@/trpc", () => ({
  trpc: {
    community: {
      createListing: {
        useMutation: () => ({ mutateAsync: m.mutateAsync, isPending: false }),
      },
    },
  },
}));

const PLACE = "00000000-0000-4000-8000-0000000000a1";

vi.mock("@/components/places/PlaceOrAddressField", async () => {
  const React = await import("react");
  return {
    PlaceOrAddressField: ({
      onPickPlace,
      onPickAddress,
      selectedNote,
      inputId,
      labelledBy,
      describedBy,
      invalid,
    }: {
      onPickPlace: (p: unknown) => void;
      onPickAddress: (a: unknown) => void;
      selectedNote?: ReactNode;
      inputId?: string;
      labelledBy?: string;
      describedBy?: string;
      invalid?: boolean;
    }) =>
      React.createElement(
        "div",
        null,
        React.createElement("input", {
          role: "combobox",
          id: inputId,
          "aria-labelledby": labelledBy,
          "aria-describedby": describedBy,
          "aria-invalid": invalid || undefined,
        }),
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "stub-pick-place",
            onClick: () =>
              onPickPlace({
                placeId: PLACE,
                name: "Corner Bar South",
                formattedAddress: "2190A Nolensville Pike",
                city: "Nashville",
                region: "TN",
                lat: 36.12,
                lng: -86.74,
                timezone: "America/Chicago",
                status: "ACTIVE",
                verificationStatus: "UNVERIFIED",
              }),
          },
          "pick place",
        ),
        React.createElement(
          "button",
          {
            type: "button",
            "data-testid": "stub-pick-address",
            onClick: () =>
              onPickAddress({
                formatted: "2190 Nolensville Pike, Nashville, TN 37211",
                line1: "2190 Nolensville Pike",
                poiName: null,
                city: "Nashville",
                region: "TN",
                postalCode: "37211",
                countryCode: "US",
                lat: 36.12,
                lng: -86.74,
              }),
          },
          "pick address",
        ),
        selectedNote,
      ),
  };
});

const { CommunityQuickCreateForm } = await import("../CommunityQuickCreateForm");

function fillBasics() {
  fireEvent.change(screen.getByTestId("community-title"), {
    target: { value: "Thursday songwriter round" },
  });
  fireEvent.change(screen.getByTestId("community-starts-at"), {
    target: { value: "2026-11-05T19:00" },
  });
  fireEvent.change(screen.getByTestId("community-ends-at"), {
    target: { value: "2026-11-05T22:00" },
  });
}

describe("CommunityQuickCreateForm — Location links a place", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.mutateAsync.mockResolvedValue({ event: { id: "evt-1" } });
  });

  it("sends placeId, and no address, when a place was picked", async () => {
    render(<CommunityQuickCreateForm slug="@dev" />);
    fillBasics();
    fireEvent.click(screen.getByTestId("stub-pick-place"));
    expect(
      (screen.getByTestId("community-timezone") as HTMLSelectElement).value,
    ).toBe("America/Chicago");
    expect(screen.getByText("communityCreate.pfTimezoneFromPlace")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("community-continue"));
    await waitFor(() => expect(m.mutateAsync).toHaveBeenCalledTimes(1));
    const sent = m.mutateAsync.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      placeId: PLACE,
      timezone: "America/Chicago",
      status: "DRAFT",
    });
    for (const field of ["addressText", "countryCode", "lat", "lng"]) {
      expect(sent).not.toHaveProperty(field);
    }
    expect(m.push).toHaveBeenCalledWith("/admin/@dev/events/evt-1/edit");
  });

  it("sends the address, and no placeId, when an address was picked", async () => {
    render(<CommunityQuickCreateForm slug="@dev" />);
    fillBasics();
    fireEvent.click(screen.getByTestId("stub-pick-address"));
    fireEvent.click(screen.getByTestId("community-continue"));

    await waitFor(() => expect(m.mutateAsync).toHaveBeenCalledTimes(1));
    const sent = m.mutateAsync.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      addressText: "2190 Nolensville Pike, Nashville, TN 37211",
      countryCode: "US",
      lat: 36.12,
      lng: -86.74,
    });
    expect(sent).not.toHaveProperty("placeId");
  });

  it("refuses to submit with nothing picked", async () => {
    render(<CommunityQuickCreateForm slug="@dev" />);
    fillBasics();
    fireEvent.click(screen.getByTestId("community-continue"));
    expect(
      await screen.findByText("communityCreate.errLocationRequired"),
    ).toBeInTheDocument();
    expect(m.mutateAsync).not.toHaveBeenCalled();
  });

  it("names the Location combobox by its visible label", () => {
    render(<CommunityQuickCreateForm slug="@dev" />);
    expect(
      screen.getByRole("combobox", { name: "communityCreate.fieldLocation" }),
    ).toBeInTheDocument();
  });

  it("says why a picked place can't be linked, on the Location field", async () => {
    m.mutateAsync.mockRejectedValue(
      Object.assign(new Error("invalid"), {
        data: {
          appCode: "INVALID_INPUT",
          meta: { reason: "PLACE_WITHHOLDS_ADDRESS" },
        },
      }),
    );
    render(<CommunityQuickCreateForm slug="@dev" />);
    fillBasics();
    fireEvent.click(screen.getByTestId("stub-pick-place"));
    fireEvent.click(screen.getByTestId("community-continue"));

    const line = await screen.findByText(
      "communityBuilder.errPlaceWithholdsAddress",
    );
    expect(line).toHaveAttribute("id", "community-location-error");
    const box = screen.getByRole("combobox", {
      name: "communityCreate.fieldLocation",
    });
    expect(box).toHaveAttribute("aria-describedby", "community-location-error");
    expect(box).toHaveAttribute("aria-invalid", "true");
    expect(m.push).not.toHaveBeenCalled();
  });
});

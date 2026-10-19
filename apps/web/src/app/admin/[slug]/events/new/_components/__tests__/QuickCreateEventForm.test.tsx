/**
 * QuickCreateEventForm — the venue is OPTIONAL (owner ruling 2026-09-08).
 *
 * Pins, at the form level:
 *   1. title + start with NO venue submits `location: {}` (the wire's "no
 *      location") to the create mutation, shows no venue error, and routes
 *      to the builder;
 *   2. the venue label carries the DS §6a "(optional)" suffix and the hint
 *      that points a third party at the full builder;
 *   3. the ONE venue state still stopped on — an address typed but never
 *      picked from the suggestions — shows its error, sends nothing, and
 *      clears on the next keystroke (§6a clear-on-input).
 *
 * MOCKS: tamagui / @th/ui are reduced to plain DOM so this renders under
 * jsdom; the search components are stubs (the autocomplete is a bare input
 * so typed-but-unpicked text can be produced); tRPC is a recording mutation.
 * Nothing about how the page LOOKS is verified here — that is the drive.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mutateAsync = vi.fn();
const push = vi.fn();

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP =
    /^(data-|aria-)|^(id|role|style|title|tabIndex|type|htmlFor|value|onChange|min|max|required|placeholder|disabled)$/;
  const make =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = make("div");
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: (base: unknown, config?: { tag?: string }) =>
      make(
        typeof base === "string"
          ? base
          : config?.tag === "button"
            ? "button"
            : config?.tag === "span"
              ? "span"
              : "div",
      ),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({
    children,
    ...rest
  }: {
    children?: ReactNode;
    [k: string]: unknown;
  }) =>
    React.createElement(
      "span",
      {
        id: rest.id,
        "data-testid": rest["data-testid"],
        "aria-live": rest["aria-live"],
      },
      children,
    );
  return {
    Text,
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      [k: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          disabled,
          "data-testid": rest["data-testid"],
        },
        children,
      ),
    TextInput: ({
      value,
      onChangeText,
      placeholder,
      testId,
    }: {
      value: string;
      onChangeText: (v: string) => void;
      placeholder?: string;
      testId?: string;
    }) =>
      React.createElement("input", {
        value,
        placeholder,
        "data-testid": testId,
        onChange: (e: { target: { value: string } }) =>
          onChangeText(e.target.value),
      }),
    FormErrorBanner: ({ message }: { message: string }) =>
      React.createElement("div", { "data-testid": "form-error" }, message),
    useTranslations: () => (key: string) => key,
    useNotify: () => ({
      toast: { danger: vi.fn(), success: vi.fn(), info: vi.fn() },
    }),
  };
});

vi.mock("@/trpc", () => {
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? undefined : chain),
    apply: () => undefined,
  });
  const mutation = () => ({ mutateAsync, isPending: false });
  return {
    trpc: {
      useUtils: () => chain,
      events: {
        createEventForHuman: { useMutation: mutation },
        createEventForOrg: { useMutation: mutation },
      },
      places: {
        listHumanPlaces: {
          useQuery: () => ({ data: undefined, isLoading: false }),
        },
      },
    },
  };
});

vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: {
      kind: "human",
      humanId: "human-1",
      humanName: "Dev Admin",
      adminSlug: "@dev",
    },
  }),
}));
vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push, replace: vi.fn() }),
}));
// Maps ON so the "use my location" button renders (its geolocation call is
// stubbed per test).
vi.mock("@/config/maps", () => ({ isMapEnabled: true }));
vi.mock("@/lib/maps/geocoding", () => ({ reverseGeocode: vi.fn() }));
vi.mock("@/app/admin/[slug]/_components/calendar", () => ({
  useCalendarText: () => (_key: string, fallback: string) => fallback,
}));
vi.mock("@/components/errors/QuotaExceededDialog", () => ({
  QuotaExceededDialog: () => null,
}));
vi.mock("@/components/places/PlacePicker", () => ({
  PlacePicker: () => null,
}));
// A bare input standing in for the geocoder box: `onChange` is the typed
// text, `onSelect` never fires — exactly the "typed but never picked" state.
vi.mock("@/components/maps/LocationAutocomplete", async () => {
  const React = await import("react");
  return {
    default: ({
      value,
      onChange,
      testIdBase,
    }: {
      value: string;
      onChange: (v: string) => void;
      testIdBase?: string;
    }) =>
      React.createElement("input", {
        value,
        "data-testid": `${testIdBase}-input`,
        onChange: (e: { target: { value: string } }) =>
          onChange(e.target.value),
      }),
  };
});
vi.mock("../EventTimezoneNote", () => ({ EventTimezoneNote: () => null }));
vi.mock("../use-address-timezone", () => ({
  useAddressTimezoneAdoption: () => undefined,
}));

import { QuickCreateEventForm } from "../QuickCreateEventForm";

function fillTitleAndStart() {
  fireEvent.change(screen.getByTestId("quick-create-title"), {
    target: { value: "Warehouse Show" },
  });
  fireEvent.change(screen.getByTestId("quick-create-starts-at"), {
    target: { value: "2026-10-02T20:00" },
  });
}

describe("QuickCreateEventForm — optional venue", () => {
  beforeEach(() => {
    mutateAsync.mockReset();
    push.mockReset();
    mutateAsync.mockResolvedValue({ eventId: "evt-1" });
  });

  it("disables submit while \"use my location\" is still resolving", () => {
    // A position request that never answers: the form holds nothing yet, but
    // it is mid-flight — coordinates land before the address does, and a
    // submit in that window would ship `{}`.
    const getCurrentPosition = vi.fn();
    Object.defineProperty(navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition },
    });
    render(<QuickCreateEventForm slug="@dev" />);
    fillTitleAndStart();
    const submit = screen.getByTestId("quick-create-submit");
    expect(submit).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("quick-create-use-my-location"));

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("clears the venue error when the Address box is swapped for My Places", async () => {
    render(<QuickCreateEventForm slug="@dev" />);
    fillTitleAndStart();
    fireEvent.change(screen.getByTestId("quick-create-venue-input"), {
      target: { value: "123 Main St" },
    });
    fireEvent.click(screen.getByTestId("quick-create-submit"));
    await waitFor(() =>
      expect(screen.getByTestId("quick-create-venue-error")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("qc-location-mode-place"));

    // The message referred to a box that is now gone.
    expect(screen.queryByTestId("quick-create-venue-error")).toBeNull();
    expect(screen.queryByTestId("quick-create-venue-input")).toBeNull();
  });

  it("creates the draft with `location: {}` when no venue is chosen, with no venue error", async () => {
    render(<QuickCreateEventForm slug="@dev" />);
    fillTitleAndStart();

    fireEvent.click(screen.getByTestId("quick-create-submit"));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const input = mutateAsync.mock.calls[0]![0] as {
      title: string;
      location: unknown;
    };
    expect(input.title).toBe("Warehouse Show");
    expect(input.location).toEqual({});
    expect("calendarId" in input).toBe(false);
    expect(screen.queryByTestId("quick-create-venue-error")).toBeNull();
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith("/admin/@dev/events/evt-1/edit"),
    );
  });

  it("labels the venue as optional and points a third party at the builder", () => {
    render(<QuickCreateEventForm slug="@dev" />);
    // FieldLabel's `optional` suffix renders "(common.optional)" under the
    // key-echo translator — its presence is the §6a marker.
    expect(screen.getByText("admin.qcVenue").textContent).toContain(
      "common.optional",
    );
    expect(screen.getByTestId("quick-create-venue-hint").textContent).toBe(
      "admin.qcVenueHint",
    );
  });

  it("stops on an address typed but never picked, and clears the error on input", async () => {
    render(<QuickCreateEventForm slug="@dev" />);
    fillTitleAndStart();
    fireEvent.change(screen.getByTestId("quick-create-venue-input"), {
      target: { value: "123 Main St" },
    });

    fireEvent.click(screen.getByTestId("quick-create-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("quick-create-venue-error").textContent).toBe(
        "admin.qcVenueUnresolved",
      ),
    );
    expect(mutateAsync).not.toHaveBeenCalled();

    // §6a clear-on-input: the next keystroke removes the error.
    fireEvent.change(screen.getByTestId("quick-create-venue-input"), {
      target: { value: "123 Main St, Nashville" },
    });
    expect(screen.queryByTestId("quick-create-venue-error")).toBeNull();

    // Clearing the box entirely makes the venue "not given" again — submit goes through.
    fireEvent.change(screen.getByTestId("quick-create-venue-input"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByTestId("quick-create-submit"));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect((mutateAsync.mock.calls[0]![0] as { location: unknown }).location).toEqual({});
  });
});

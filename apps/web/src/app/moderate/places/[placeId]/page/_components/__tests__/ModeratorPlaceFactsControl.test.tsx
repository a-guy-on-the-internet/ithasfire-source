import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "Edit place details" in the moderator page editor: shown only while the
 * place's facts can change, asks again before it opens the shared
 * PlaceDialog, and refreshes the editor's place data on save.
 */

vi.mock("@th/ui", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => (
    <button
      type="button"
      onClick={onPress}
      disabled={disabled}
      data-testid={testId}
    >
      {children}
    </button>
  ),
  useNotify: () => ({ toast: notify }),
  useTranslations: () => (key: string) => key,
}));

const notify = vi.hoisted(() => ({ danger: vi.fn(), success: vi.fn() }));

vi.mock("@bprogress/next/app", () => ({ useRouter: () => ({ push }) }));
const push = vi.hoisted(() => vi.fn());

const dialog = vi.hoisted(() => ({
  last: null as null | Record<string, unknown>,
}));
vi.mock("@/components/places/PlaceDialog", () => ({
  REFUSAL_COPY: {
    CLAIM_PENDING: {
      title: "communityCreate.pfRefusedClaimTitle",
      body: "communityCreate.pfRefusedClaimBody",
    },
    NOT_ACTIVE: {
      title: "communityCreate.pfRefusedNotActiveTitle",
      body: "communityCreate.pfRefusedNotActiveBody",
    },
  },
  PlaceDialog: (props: Record<string, unknown>) => {
    dialog.last = props;
    return props.mode ? <div data-testid="place-dialog" /> : null;
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: () => "translated error",
}));

const api = vi.hoisted(() => ({
  query: (() => ({ data: api.editability, isError: false })) as () => Record<string, unknown>,
  editability: { status: "ACTIVE", canEdit: true, canArchive: true, linkedListingCount: 0, reason: null } as Record<string, unknown>,
  fetchEditability: vi.fn(),
  fetchPlace: vi.fn(),
  invalidateMyPage: vi.fn(),
  invalidatePlace: vi.fn(),
  invalidateEditability: vi.fn(),
  invalidateAccess: vi.fn(),
  invalidateArrivalAreas: vi.fn(),
  gates: { arrivalAreas: true } as Record<string, boolean> | undefined,
}));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: api.gates }),
}));
vi.mock("@/trpc", () => ({
  trpc: {
    community: {
      getPlaceEditability: {
        useQuery: () => api.query(),
      },
    },
    useUtils: () => ({
      community: {
        getPlaceEditability: {
          fetch: api.fetchEditability,
          invalidate: api.invalidateEditability,
        },
      },
      places: {
        getPlacePublic: {
          fetch: api.fetchPlace,
          invalidate: api.invalidatePlace,
        },
      },
      entityPages: {
        getMyPage: { invalidate: api.invalidateMyPage },
        placePageEditAccess: { invalidate: api.invalidateAccess },
      },
      arrivalAreas: {
        listForEditor: { invalidate: api.invalidateArrivalAreas },
      },
    }),
  },
}));

import {
  ModeratorPlaceFactsControl,
  usePlaceFactsEditable,
} from "../ModeratorPlaceFactsControl";

const PLACE = {
  placeId: "p1",
  name: "Back Room",
  formattedAddress: "100 Test Alley, Nashville, TN",
  city: "Nashville",
  region: "TN",
  lat: 36.15,
  lng: -86.79,
  status: "ACTIVE",
  verificationStatus: "UNVERIFIED",
};

beforeEach(() => {
  dialog.last = null;
  api.query = () => ({ data: api.editability, isError: false });
  api.editability = {
    status: "ACTIVE",
    canEdit: true,
    canArchive: true,
    linkedListingCount: 0,
    reason: null,
  };
  api.fetchEditability.mockReset().mockResolvedValue(api.editability);
  api.fetchPlace.mockReset().mockResolvedValue({ place: PLACE });
  api.invalidateMyPage.mockReset();
  api.invalidatePlace.mockReset();
  api.invalidateAccess.mockReset();
  api.invalidateArrivalAreas.mockReset();
  api.gates = { arrivalAreas: true };
  notify.danger.mockReset();
  notify.success.mockReset();
  push.mockReset();
});

describe("ModeratorPlaceFactsControl", () => {
  it("is not offered when the place's facts cannot change", () => {
    api.editability = { canEdit: false, reason: "OWNED_EVENTS_AT_PLACE" };
    render(<ModeratorPlaceFactsControl placeId="p1" />);
    expect(screen.queryByTestId("moderator-place-facts-edit")).toBeNull();
  });

  it("asks again, then opens the place dialog on the form", async () => {
    render(<ModeratorPlaceFactsControl placeId="p1" />);
    const button = screen.getByTestId("moderator-place-facts-edit");
    expect(button).toHaveTextContent("communityPlacePage.editPlaceDetails");
    fireEvent.click(button);
    await screen.findByTestId("place-dialog");
    expect(api.fetchEditability).toHaveBeenCalledWith(
      { placeId: "p1" },
      { staleTime: 0 },
    );
    expect(dialog.last?.mode).toMatchObject({
      kind: "edit",
      place: { placeId: "p1", name: "Back Room", lat: 36.15, lng: -86.79 },
      canEdit: true,
      canArchive: true,
      linkedListingCount: 0,
      startAt: "form",
      // Archive is not offered from the page editor at all.
      hideArchive: true,
    });
  });

  it("says why when a claim landed since the button showed", async () => {
    api.fetchEditability.mockResolvedValue({
      status: "ACTIVE",
      canEdit: false,
      canArchive: false,
      linkedListingCount: 0,
      reason: "CLAIM_PENDING",
    });
    render(<ModeratorPlaceFactsControl placeId="p1" />);
    fireEvent.click(screen.getByTestId("moderator-place-facts-edit"));
    await waitFor(() =>
      expect(notify.danger).toHaveBeenCalledWith({
        title: "communityCreate.pfRefusedClaimTitle",
        message: "communityCreate.pfRefusedClaimBody",
      }),
    );
    expect(screen.queryByTestId("place-dialog")).toBeNull();
  });

  it.each([
    ["no reason", null],
    ["a restore-only DUPLICATE_ACTIVE", "DUPLICATE_ACTIVE"],
  ])(
    "archived since the button showed (%s): says archived, re-asks the gate",
    async (_label, reason) => {
      api.fetchEditability.mockResolvedValue({
        status: "ARCHIVED",
        canEdit: false,
        canArchive: false,
        linkedListingCount: 0,
        reason,
      });
      render(<ModeratorPlaceFactsControl placeId="p1" />);
      fireEvent.click(screen.getByTestId("moderator-place-facts-edit"));
      await waitFor(() =>
        expect(notify.danger).toHaveBeenCalledWith({
          title: "communityPlacePage.refusedArchivedTitle",
          message: "communityPlacePage.refusedArchivedBody",
        }),
      );
      expect(api.invalidateAccess).toHaveBeenCalledWith({ placeId: "p1" });
      expect(screen.queryByTestId("place-dialog")).toBeNull();
    },
  );

  it("an unknown or restore-only reason on an ACTIVE place reads as can't-change", async () => {
    api.fetchEditability.mockResolvedValue({
      status: "ACTIVE",
      canEdit: false,
      canArchive: false,
      linkedListingCount: 0,
      reason: "DUPLICATE_ACTIVE",
    });
    render(<ModeratorPlaceFactsControl placeId="p1" />);
    fireEvent.click(screen.getByTestId("moderator-place-facts-edit"));
    await waitFor(() =>
      expect(notify.danger).toHaveBeenCalledWith({
        title: "communityCreate.pfRefusedNotActiveTitle",
        message: "communityCreate.pfRefusedNotActiveBody",
      }),
    );
  });

  it("a second press while the first is opening asks only once", async () => {
    render(<ModeratorPlaceFactsControl placeId="p1" />);
    const button = screen.getByTestId("moderator-place-facts-edit");
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByTestId("place-dialog");
    expect(api.fetchEditability).toHaveBeenCalledTimes(1);
  });

  it("refreshes the editor's place data on save", async () => {
    render(<ModeratorPlaceFactsControl placeId="p1" />);
    fireEvent.click(screen.getByTestId("moderator-place-facts-edit"));
    await screen.findByTestId("place-dialog");
    act(() => {
      (dialog.last?.onSaved as (p: unknown) => void)({
        ...PLACE,
        name: "Front Room",
      });
    });
    expect(api.invalidateMyPage).toHaveBeenCalledWith({
      ownerType: "PLACE",
      ownerId: "p1",
    });
    expect(api.invalidatePlace).toHaveBeenCalledWith({ placeId: "p1" });
    expect(notify.success).toHaveBeenCalledWith({
      title: "admin.ppDetailUpdated",
    });
    expect(screen.queryByTestId("place-dialog")).toBeNull();
  });

  it("refreshes Getting there on save, so its pin follows a new address", async () => {
    render(<ModeratorPlaceFactsControl placeId="p1" />);
    fireEvent.click(screen.getByTestId("moderator-place-facts-edit"));
    await screen.findByTestId("place-dialog");
    act(() => {
      (dialog.last?.onSaved as (p: unknown) => void)({ ...PLACE, lat: 36.16 });
    });
    expect(api.invalidateArrivalAreas).toHaveBeenCalledWith({ placeId: "p1" });
  });

  it("leaves Getting there alone with the arrivalAreas gate off", async () => {
    api.gates = { arrivalAreas: false };
    render(<ModeratorPlaceFactsControl placeId="p1" />);
    fireEvent.click(screen.getByTestId("moderator-place-facts-edit"));
    await screen.findByTestId("place-dialog");
    act(() => {
      (dialog.last?.onSaved as (p: unknown) => void)({ ...PLACE, lat: 36.16 });
    });
    expect(api.invalidateArrivalAreas).not.toHaveBeenCalled();
  });

  it("'Use this place' opens that place's page editor", async () => {
    render(<ModeratorPlaceFactsControl placeId="p1" />);
    fireEvent.click(screen.getByTestId("moderator-place-facts-edit"));
    await screen.findByTestId("place-dialog");
    act(() => {
      (dialog.last?.onUseExisting as (p: unknown) => void)({
        ...PLACE,
        placeId: "p2",
      });
    });
    expect(push).toHaveBeenCalledWith("/moderate/places/p2/page");
  });
});

describe("usePlaceFactsEditable", () => {
  function Probe() {
    return <span data-testid="state">{usePlaceFactsEditable("p1")}</span>;
  }
  const state = () => screen.getByTestId("state").textContent;

  it("is loading until the check answers", () => {
    api.query = () => ({ data: undefined, isError: false });
    render(<Probe />);
    expect(state()).toBe("loading");
  });

  it("is editable when the check says the facts can change", () => {
    render(<Probe />);
    expect(state()).toBe("editable");
  });

  it("is locked when the check says they cannot", () => {
    api.editability = { status: "ACTIVE", canEdit: false, reason: "OWNED_EVENTS_AT_PLACE" };
    render(<Probe />);
    expect(state()).toBe("locked");
  });

  it("is locked when the check failed", () => {
    api.query = () => ({ data: undefined, isError: true });
    render(<Probe />);
    expect(state()).toBe("locked");
  });
});

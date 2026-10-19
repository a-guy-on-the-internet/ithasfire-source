/**
 * The arrival-areas editor container (arrival-areas FR-016, FR-017, NFR-001,
 * NFR-004). The map is mocked to two buttons (report ready, draw a lot) so
 * this can pin what the container decides: the gate, the list, the limit,
 * the no-pin state (pin read from the list, the only pin source), the create
 * input, the cache write and purge after each mutation, a stale save that
 * keeps the person's text, and a stale LIST that must not revert a save.
 *
 * WHAT THIS CANNOT SEE: Terra Draw, the real map, the full-screen frame's
 * layout at 320px, or how the section sits on the settings page. Those are
 * driven in the real app.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IthasFireProvider, TranslationProvider } from "@th/ui";

import enMessages from "@/i18n/messages/en";

import type { EditorArrivalArea } from "../arrival-areas-editor.helpers";

const PLACE_ID = "00000000-0000-4000-8000-00000000d033";

const mocks = vi.hoisted(() => ({
  gates: { arrivalAreas: true } as Record<string, boolean> | undefined,
  wide: true,
  list: null as null | {
    data: unknown;
    isLoading: boolean;
    error: unknown;
  },
  create: vi.fn(),
  update: vi.fn(),
  reorder: vi.fn(),
  remove: vi.fn(),
  invalidate: vi.fn(),
  setData: vi.fn(),
  fetchList: vi.fn(),
  refetch: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: mocks.gates }),
}));
vi.mock("@/config/maps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/config/maps")>()),
  isMapEnabled: true,
}));
vi.mock("@th/ui", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@th/ui")>()),
  useNotify: () => ({
    toast: { success: mocks.toastSuccess, danger: vi.fn(), warning: vi.fn() },
  }),
}));

const savingMutation = vi.hoisted(() => ({ update: false }));
const mutation = (fn: ReturnType<typeof vi.fn>, pending?: () => boolean) => ({
  mutateAsync: fn,
  get isPending() {
    return pending ? pending() : false;
  },
});

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      arrivalAreas: {
        listForEditor: {
          invalidate: mocks.invalidate,
          setData: mocks.setData,
          fetch: mocks.fetchList,
        },
      },
    }),
    arrivalAreas: {
      listForEditor: {
        useQuery: () => ({ ...mocks.list, refetch: mocks.refetch }),
      },
      create: { useMutation: () => mutation(mocks.create) },
      update: { useMutation: () => mutation(mocks.update, () => savingMutation.update) },
      reorder: { useMutation: () => mutation(mocks.reorder) },
      remove: { useMutation: () => mutation(mocks.remove) },
    },
  },
}));

const DRAWN_LOT = {
  type: "Polygon" as const,
  coordinates: [
    [
      [-122.2541, 37.8738],
      [-122.2538, 37.8738],
      [-122.2538, 37.8741],
      [-122.2541, 37.8738],
    ] as [number, number][],
  ],
};

vi.mock("../ArrivalAreasEditorMap", async () => {
  const React = await import("react");
  return {
    ArrivalAreasEditorMap: React.forwardRef(function MockMap(
      props: {
        onStatus: (s: string) => void;
        onShapeDrawn: (shape: unknown) => void;
        onShapeChanged: (shape: unknown) => void;
        tool: string;
        interactive: boolean;
      },
      _ref,
    ) {
      return (
        <div
          data-testid="mock-map"
          data-tool={props.tool}
          data-interactive={String(props.interactive)}
        >
          <button type="button" onClick={() => props.onStatus("ready")}>
            mock-ready
          </button>
          <button type="button" onClick={() => props.onShapeDrawn(DRAWN_LOT)}>
            mock-draw
          </button>
          <button type="button" onClick={() => props.onShapeChanged(DRAWN_LOT)}>
            mock-reshape
          </button>
        </div>
      );
    }),
  };
});

import { ArrivalAreasEditor } from "../ArrivalAreasEditor";

const area = (id: string, label: string, over: Partial<EditorArrivalArea> = {}): EditorArrivalArea => ({
  id,
  source: "PLACE",
  kind: "PARKING",
  label,
  cost: "FREE",
  priceText: null,
  note: null,
  accessibleSpots: false,
  sortOrder: 0,
  geometry: {
    type: "LineString",
    coordinates: [
      [-122.2541, 37.8738],
      [-122.2538, 37.8738],
    ],
  },
  geometryWithheld: false,
  disabledAt: null,
  updatedAt: new Date("2026-10-18T10:00:00Z"),
  outsideEnvelope: false,
  hiddenForEvent: null,
  ...over,
});

const PIN = { lat: 37.8738, lng: -122.2543 };

const listOf = (
  areas: EditorArrivalArea[],
  limit = 10,
  over: {
    pin?: { lat: number; lng: number } | null;
    editorKind?: string;
    addressWithheld?: boolean;
  } = {},
) => ({
  data: {
    parent: "place",
    placeId: PLACE_ID,
    editorKind: over.editorKind ?? "owner",
    pin: over.pin === undefined ? PIN : over.pin,
    addressWithheld: over.addressWithheld ?? false,
    areas,
    limit,
  },
  isLoading: false,
  error: null,
});

const row = (over: Record<string, unknown> = {}) => ({
  id: "new-1",
  placeId: PLACE_ID,
  eventId: null,
  kind: "PARKING",
  label: "Overflow lot",
  cost: "FREE",
  priceText: null,
  note: null,
  accessibleSpots: false,
  sortOrder: 4,
  geometry: DRAWN_LOT,
  geometryWithheld: false,
  disabledAt: null,
  createdByHumanId: null,
  createdAt: new Date("2026-10-18T12:00:00Z"),
  updatedAt: new Date("2026-10-18T12:00:00Z"),
  ...over,
});

function renderEditor() {
  return render(
    <IthasFireProvider>
      <TranslationProvider locale="en-US" messages={enMessages}>
        <ArrivalAreasEditor parent={{ placeId: PLACE_ID }} />
      </TranslationProvider>
    </IthasFireProvider>,
  );
}

const fetchSpy = vi.fn().mockResolvedValue({ ok: true });

beforeEach(() => {
  mocks.gates = { arrivalAreas: true };
  mocks.wide = true;
  savingMutation.update = false;
  mocks.list = listOf([area("a1", "Lower Hearst lot"), area("a2", "Gayley Rd, east side")]);
  for (const fn of [
    mocks.create,
    mocks.update,
    mocks.reorder,
    mocks.remove,
    mocks.invalidate,
    mocks.setData,
    mocks.fetchList,
    mocks.toastSuccess,
  ]) {
    fn.mockReset();
  }
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
  // The editor measures the viewport itself (null until known).
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: mocks.wide,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

/** A promise the test settles by hand, to look between "sent" and "landed". */
function deferred<T>() {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const PURGE = [
  `/api/places/${PLACE_ID}/revalidate`,
  expect.objectContaining({ method: "POST" }),
] as const;

/** Applies the cache write the editor made, to the list it had. */
function lastCacheWrite(): EditorArrivalArea[] {
  const updater = mocks.setData.mock.calls.at(-1)?.[1] as (old: unknown) => {
    areas: EditorArrivalArea[];
  };
  return updater(mocks.list!.data).areas;
}

function selectRow(index: number) {
  fireEvent.click(
    screen.getAllByTestId("arrival-areas-editor-row")[index]!.querySelector("button")!,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ArrivalAreasEditor", () => {
  it("renders nothing with the gate off (FR-017)", () => {
    mocks.gates = { arrivalAreas: false };
    const { container } = renderEditor();
    expect(container.querySelector("[data-testid^='arrival-areas']")).toBeNull();
  });

  it("lists the areas with the count against the limit", () => {
    renderEditor();
    expect(screen.getByText("2 of 10 areas")).toBeTruthy();
    expect(screen.getAllByTestId("arrival-areas-editor-row")).toHaveLength(2);
    // aria-disabled, not disabled: a disabled button drops keyboard focus
    // when a move lands it at the edge.
    expect(
      screen.getByRole("button", { name: "Move Lower Hearst lot up" }).getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("says to set the address first when the list has no pin, and draws no map", () => {
    mocks.list = listOf([area("a1", "Lower Hearst lot")], 10, { pin: null });
    renderEditor();
    expect(screen.getByTestId("arrival-areas-map-message").textContent).toContain(
      "Set the place's address first",
    );
    expect(screen.queryByTestId("mock-map")).toBeNull();
  });

  it("blocks drawing at the limit and says why", async () => {
    mocks.list = listOf(
      Array.from({ length: 3 }, (_, i) => area(`a${i}`, `Area ${i}`)),
      3,
    );
    renderEditor();
    fireEvent.click(await screen.findByText("mock-ready"));
    expect(screen.getByTestId("arrival-areas-limit").textContent).toContain("3 areas");
    expect(screen.getByTestId("arrival-areas-tool-polygon")).toHaveProperty("disabled", true);
  });

  it("creates a drawn lot, then purges the place page (NFR-001)", async () => {
    mocks.create.mockResolvedValue(row());
    renderEditor();
    fireEvent.click(await screen.findByText("mock-ready"));
    expect(screen.getByTestId("arrival-areas-tool-polygon")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByText("mock-draw"));
    expect(screen.getByText("New area")).toBeTruthy();
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "  Overflow lot " },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        placeId: PLACE_ID,
        label: "Overflow lot",
        kind: "PARKING",
        geometry: DRAWN_LOT,
      }),
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      `/api/places/${PLACE_ID}/revalidate`,
      expect.objectContaining({ method: "POST" }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Area saved",
        message: "Changes can take 2 to 7 minutes to reach visitors.",
      }),
    );
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  it("creates once when one tap fires the button and the form submit", async () => {
    // Measured on a touch device: one Save tap created two rows.
    let resolve: (v: unknown) => void = () => undefined;
    mocks.create.mockReturnValue(new Promise((r) => (resolve = r)));
    renderEditor();
    fireEvent.click(await screen.findByText("mock-ready"));
    fireEvent.click(screen.getByText("mock-draw"));
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "Overflow lot" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
      fireEvent.submit(screen.getByTestId("arrival-area-form"));
    });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    await act(async () => resolve(row()));
  });

  it("refuses an empty label without calling the server", async () => {
    renderEditor();
    fireEvent.click(await screen.findByText("mock-ready"));
    fireEvent.click(screen.getByText("mock-draw"));
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(screen.getByText("Give the area a label.")).toBeTruthy();
  });

  it("keeps the person's text on a stale save and names the other change (NFR-004)", async () => {
    mocks.update.mockRejectedValue(
      Object.assign(new Error("ARRIVAL_AREA_CONFLICT"), {
        data: { appCode: "ARRIVAL_AREA_CONFLICT" },
      }),
    );
    // meta.current absent: the editor fetches the list to learn the row.
    mocks.fetchList.mockResolvedValue({
      areas: [
        area("a1", "Renamed by someone", { updatedAt: new Date("2026-10-18T11:00:00Z") }),
        area("a2", "Gayley Rd, east side"),
      ],
    });
    renderEditor();
    fireEvent.click(screen.getAllByTestId("arrival-areas-editor-row")[0]!.querySelector("button")!);
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "My new label" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    await waitFor(() =>
      expect(screen.getByTestId("arrival-area-form-notice").textContent).toContain(
        "Renamed by someone",
      ),
    );
    expect((screen.getByTestId("arrival-area-label") as HTMLInputElement).value).toBe(
      "My new label",
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    // Saving again is the deliberate overwrite, with the NEW token.
    mocks.update.mockResolvedValue(row({ id: "a1", label: "My new label" }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        arrivalAreaId: "a1",
        expectedUpdatedAt: new Date("2026-10-18T11:00:00Z"),
        patch: { label: "My new label" },
      }),
    );
  });

  it("shows a geometry refusal's own copy", async () => {
    mocks.create.mockRejectedValue(
      Object.assign(new Error("ARRIVAL_AREA_INVALID_GEOMETRY"), {
        data: {
          appCode: "ARRIVAL_AREA_INVALID_GEOMETRY",
          meta: { reason: "SELF_INTERSECTING" },
        },
      }),
    );
    renderEditor();
    fireEvent.click(await screen.findByText("mock-ready"));
    fireEvent.click(screen.getByText("mock-draw"));
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "Bow tie" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    expect(screen.getByTestId("arrival-area-form-notice").textContent).toContain(
      "edges cross",
    );
  });

  it("purges the place page right after a create lands, and writes the row into the list", async () => {
    const pending = deferred<ReturnType<typeof row>>();
    mocks.create.mockReturnValue(pending.promise);
    renderEditor();
    fireEvent.click(await screen.findByText("mock-ready"));
    fireEvent.click(screen.getByText("mock-draw"));
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "Overflow lot" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () => pending.resolve(row()));
    expect(fetchSpy).toHaveBeenCalledWith(...PURGE);
    expect(lastCacheWrite().map((a) => a.id)).toEqual(["a1", "a2", "new-1"]);
  });

  it("purges right after an update lands", async () => {
    const pending = deferred<ReturnType<typeof row>>();
    mocks.update.mockReturnValue(pending.promise);
    renderEditor();
    selectRow(0);
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "Upper Hearst lot" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () =>
      pending.resolve(
        row({ id: "a1", label: "Upper Hearst lot", updatedAt: new Date("2026-10-18T12:00:00Z") }),
      ),
    );
    expect(fetchSpy).toHaveBeenCalledWith(...PURGE);
    expect(lastCacheWrite()[0]!.label).toBe("Upper Hearst lot");
  });

  it("keeps the saved text when the list still holds the pre-save row", async () => {
    // The refetch that was in flight during the save returns the OLD row.
    // Adopting it reverted the label and armed a false conflict.
    mocks.update.mockResolvedValue(
      row({ id: "a1", label: "Upper Hearst lot", updatedAt: new Date("2026-10-18T12:00:00Z") }),
    );
    const { rerender } = renderEditor();
    selectRow(0);
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "Upper Hearst lot" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    // A fresh list object with the same stale row, as a refetch would give.
    mocks.list = listOf([area("a1", "Lower Hearst lot"), area("a2", "Gayley Rd, east side")]);
    rerender(
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <ArrivalAreasEditor parent={{ placeId: PLACE_ID }} />
        </TranslationProvider>
      </IthasFireProvider>,
    );
    expect((screen.getByTestId("arrival-area-label") as HTMLInputElement).value).toBe(
      "Upper Hearst lot",
    );

    // The next save carries the token the update returned, so no conflict.
    mocks.update.mockResolvedValue(
      row({ id: "a1", label: "Hearst lot", updatedAt: new Date("2026-10-18T12:05:00Z") }),
    );
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "Hearst lot" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        arrivalAreaId: "a1",
        expectedUpdatedAt: new Date("2026-10-18T12:00:00Z"),
        patch: { label: "Hearst lot" },
      }),
    );
    expect(screen.queryByTestId("arrival-area-form-notice")).toBeNull();
  });

  it("reorders with the whole list, keeps the new order on screen, and purges after it lands", async () => {
    const pending = deferred<ReturnType<typeof row>[]>();
    mocks.reorder.mockReturnValue(pending.promise);
    renderEditor();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move Lower Hearst lot down" }));
    });
    expect(mocks.reorder).toHaveBeenCalledWith({
      placeId: PLACE_ID,
      orderedIds: ["a2", "a1"],
    });
    // In flight: the new order shows at once, nothing purged yet.
    const labels = () =>
      screen.getAllByTestId("arrival-areas-editor-row").map((r) => r.textContent ?? "");
    expect(labels()[0]).toContain("Gayley Rd, east side");
    expect(fetchSpy).not.toHaveBeenCalled();
    // The real output shape: every row, with its new sortOrder and token.
    await act(async () =>
      pending.resolve([
        row({ id: "a2", label: "Gayley Rd, east side", sortOrder: 0 }),
        row({ id: "a1", label: "Lower Hearst lot", sortOrder: 1 }),
      ]),
    );
    expect(fetchSpy).toHaveBeenCalledWith(...PURGE);
    expect(lastCacheWrite().map((a) => a.id)).toEqual(["a2", "a1"]);
  });

  it("keeps keyboard focus on the pressed arrow after the move, even at the end of the list", async () => {
    mocks.reorder.mockResolvedValue([
      row({ id: "a2", label: "Gayley Rd, east side", sortOrder: 0 }),
      row({ id: "a1", label: "Lower Hearst lot", sortOrder: 1 }),
    ]);
    // A cache that takes the write, as React Query's does.
    mocks.setData.mockImplementation((_input: unknown, write: (old: unknown) => unknown) => {
      mocks.list = { ...mocks.list!, data: write(mocks.list!.data) };
    });
    renderEditor();
    const down = screen.getByRole("button", { name: "Move Lower Hearst lot down" });
    down.focus();
    await act(async () => {
      fireEvent.click(down);
    });
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("aria-label")).toBe("Move Lower Hearst lot down");
    expect(focused.getAttribute("aria-disabled")).toBe("true");
    // At the end now: pressing it again sends nothing.
    await act(async () => {
      fireEvent.click(focused);
    });
    expect(mocks.reorder).toHaveBeenCalledTimes(1);
  });

  it("ignores a reshape that lands while a save is in flight", async () => {
    // Measured risk: the saved row replaced the draft, so a drag made during
    // the save vanished without a word. The map goes static then too.
    const pending = deferred<ReturnType<typeof row>>();
    mocks.update.mockReturnValue(pending.promise);
    const { rerender } = renderEditor();
    fireEvent.click(await screen.findByText("mock-ready"));
    selectRow(0);
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "Upper Hearst lot" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    // The real hook flips isPending; the mock does not, so ask for it.
    savingMutation.update = true;
    rerender(
      <IthasFireProvider>
        <TranslationProvider locale="en-US" messages={enMessages}>
          <ArrivalAreasEditor parent={{ placeId: PLACE_ID }} />
        </TranslationProvider>
      </IthasFireProvider>,
    );
    expect(screen.getByTestId("mock-map").getAttribute("data-interactive")).toBe("false");
    fireEvent.click(screen.getByText("mock-reshape"));
    savingMutation.update = false;
    // The save fails, so the draft is what Save sends next: the reshape made
    // mid-save must not be in it.
    await act(async () => pending.reject(new Error("offline")));
    expect(screen.getByTestId("mock-map").getAttribute("data-interactive")).toBe("true");
    mocks.update.mockResolvedValue(
      row({ id: "a1", label: "Upper Hearst lot", updatedAt: new Date("2026-10-18T12:00:00Z") }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    expect(mocks.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ patch: { label: "Upper Hearst lot" } }),
    );
  });

  it("does not purge when a reorder fails", async () => {
    mocks.reorder.mockRejectedValue(
      Object.assign(new Error("ARRIVAL_AREA_CONFLICT"), {
        data: { appCode: "ARRIVAL_AREA_CONFLICT" },
      }),
    );
    renderEditor();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Move Lower Hearst lot down" }));
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.setData).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalled();
  });

  it("removes after a confirm, then purges", async () => {
    const pending = deferred<{ id: string; removed: true }>();
    mocks.remove.mockReturnValue(pending.promise);
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Remove Gayley Rd, east side" }));
    expect(mocks.remove).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-areas-editor-row-remove-confirm"));
    });
    expect(mocks.remove).toHaveBeenCalledWith(
      expect.objectContaining({ placeId: PLACE_ID, arrivalAreaId: "a2" }),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    await act(async () => pending.resolve({ id: "a2", removed: true }));
    expect(fetchSpy).toHaveBeenCalledWith(...PURGE);
    expect(lastCacheWrite().map((a) => a.id)).toEqual(["a1"]);
  });

  it("does not purge when a remove fails", async () => {
    mocks.remove.mockRejectedValue(
      Object.assign(new Error("ARRIVAL_AREA_CONFLICT"), {
        data: { appCode: "ARRIVAL_AREA_CONFLICT" },
      }),
    );
    renderEditor();
    fireEvent.click(screen.getByRole("button", { name: "Remove Gayley Rd, east side" }));
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-areas-editor-row-remove-confirm"));
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mocks.setData).not.toHaveBeenCalled();
  });

  it("says the place hides its address when that is why there is no pin", () => {
    mocks.list = listOf([], 10, {
      pin: null,
      editorKind: "community_moderator",
      addressWithheld: true,
    });
    renderEditor();
    const message = screen.getByTestId("arrival-areas-map-message").textContent ?? "";
    expect(message).toContain("This place hides its address");
    expect(message).not.toContain("Set the place's address first");
  });

  it("lists a withheld row and lets it be edited, but never draws it", () => {
    mocks.list = listOf([
      area("a1", "Hidden lot", { geometry: null, geometryWithheld: true }),
    ]);
    renderEditor();
    expect(screen.getByText("Shape hidden at this place")).toBeTruthy();
    expect(screen.queryByText("No shape on the map")).toBeNull();
    selectRow(0);
    expect((screen.getByTestId("arrival-area-label") as HTMLInputElement).value).toBe(
      "Hidden lot",
    );
    expect(screen.getByRole("button", { name: "Remove Hidden lot" })).toBeTruthy();
  });

  it("offers no price text or note on a withheld row, so nothing is typed over unseen text", async () => {
    mocks.list = listOf(
      [area("a1", "Hidden lot", { geometry: null, geometryWithheld: true, cost: "PAID" })],
      10,
      { addressWithheld: true, editorKind: "community_moderator" },
    );
    mocks.update.mockResolvedValue(
      row({ id: "a1", label: "Hidden lot B", geometry: null, geometryWithheld: true }),
    );
    renderEditor();
    selectRow(0);
    expect(screen.queryByTestId("arrival-area-price")).toBeNull();
    expect(screen.queryByTestId("arrival-area-note")).toBeNull();
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "Hidden lot B" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("arrival-area-save"));
    });
    expect(mocks.update).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { label: "Hidden lot B" } }),
    );
  });

  it("lists an area with no shape and flags it", () => {
    mocks.list = listOf([area("a1", "Old lot", { geometry: null })]);
    renderEditor();
    expect(screen.getByText("No shape on the map")).toBeTruthy();
  });

  it("on a phone, offers the full-screen map and closes it with Escape", () => {
    mocks.wide = false;
    renderEditor();
    expect(screen.queryByTestId("mock-map")).toBeNull();
    fireEvent.click(screen.getByTestId("arrival-areas-open-map"));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes the full-screen map with Escape even when focus fell to the page", () => {
    mocks.wide = false;
    renderEditor();
    fireEvent.click(screen.getByTestId("arrival-areas-open-map"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("on a phone, tapping a row opens the frame on its form", () => {
    mocks.wide = false;
    renderEditor();
    selectRow(0);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByTestId("arrival-area-label") as HTMLInputElement).value).toBe(
      "Lower Hearst lot",
    );
  });

  it("on a phone with an unsaved draft, tapping another row reopens the frame on that draft", () => {
    // Measured: the block's notice went to a form that only exists inside
    // the frame, so the tap looked dead.
    mocks.wide = false;
    renderEditor();
    selectRow(0);
    fireEvent.change(screen.getByTestId("arrival-area-label"), {
      target: { value: "Unsaved name" },
    });
    // Escape closes the sheet, then the frame.
    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    selectRow(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((screen.getByTestId("arrival-area-label") as HTMLInputElement).value).toBe(
      "Unsaved name",
    );
    expect(screen.getByTestId("arrival-area-form-notice").textContent).toContain(
      "Save or discard this area first.",
    );
  });
});

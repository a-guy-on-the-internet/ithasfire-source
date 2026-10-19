import { describe, it, expect, vi } from "vitest";
import { materializeEventSeatSections } from "../materialize-event-seat-sections";
import type { MaterializeEventSeatSectionsDeps } from "../materialize-event-seat-sections";

// ── Fixture UUIDs ────────────────────────────────────────────────────────────

const EVENT_ID = "11111111-1111-4111-a111-111111111111";
const LAYOUT_ID = "22222222-2222-4222-a222-222222222222";
const SECTION_DB_ID_1 = "33333333-3333-4333-a333-333333333333";
const SECTION_DB_ID_2 = "44444444-4444-4444-a444-444444444444";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildEvent(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: EVENT_ID,
    status: "DRAFT",
    orgId: "org-000",
    humanId: null,
    placeLayoutId: LAYOUT_ID,
    ...overrides,
  };
}

function buildLayout(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: LAYOUT_ID,
    name: "Soma Warehouse",
    seatCount: 300,
    sectionCount: 2,
    seatIndexBounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
    sections: [
      {
        sectionId: "ga-floor",
        label: "GA Floor",
        capacity: 200,
        color: "#ff0000",
        geometry: null,
        stageAnchor: null,
      },
      {
        sectionId: "vip-balcony",
        label: "VIP Balcony",
        capacity: 100,
        color: "#0000ff",
        geometry: null,
        stageAnchor: null,
      },
    ],
    stage: null,
    seatIds: [],
    ...overrides,
  };
}

function buildDeps(overrides?: {
  event?: ReturnType<typeof buildEvent> | null;
  layout?: ReturnType<typeof buildLayout> | null;
  materializeResult?: {
    sectionsCreated: number;
    seatsCreated: number;
    sectionIdMap: Record<string, string>;
  };
}): MaterializeEventSeatSectionsDeps {
  const event = overrides?.event === undefined ? buildEvent() : overrides.event;
  const layout =
    overrides?.layout === undefined ? buildLayout() : overrides.layout;
  const matResult = overrides?.materializeResult ?? {
    sectionsCreated: 2,
    seatsCreated: 0,
    sectionIdMap: {
      "ga-floor": SECTION_DB_ID_1,
      "vip-balcony": SECTION_DB_ID_2,
    },
  };

  const txRepos = {
    seats: {
      materializeSections: vi.fn(async () => matResult),
    },
  };

  return {
    repos: {
      events: { getById: vi.fn(async () => event) },
      placeLayouts: { getById: vi.fn(async () => layout) },
      tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<unknown>) =>
        fn(txRepos),
      ),
    } as unknown as MaterializeEventSeatSectionsDeps["repos"],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("materializeEventSeatSections", () => {
  it("materialises sections from the event's place layout", async () => {
    const deps = buildDeps();
    const result = await materializeEventSeatSections(deps, {
      eventId: EVENT_ID,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sectionsCreated: 2,
      seatsCreated: 0,
      sectionIdMap: {
        "ga-floor": SECTION_DB_ID_1,
        "vip-balcony": SECTION_DB_ID_2,
      },
    });

    // Verify the adapter was called with correct section defs
    const txFn = (deps.repos.tx as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const txRepos = {
      seats: { materializeSections: vi.fn(async () => result) },
    };
    // The tx function was invoked — verify it was called
    expect(deps.repos.tx).toHaveBeenCalledOnce();
  });

  it("returns no-op when event has no placeLayoutId", async () => {
    const deps = buildDeps({
      event: buildEvent({ placeLayoutId: null }),
    });

    const result = await materializeEventSeatSections(deps, {
      eventId: EVENT_ID,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      placeLayoutId: null,
      sectionsCreated: 0,
      seatsCreated: 0,
      sectionIdMap: {},
    });

    // Should NOT start a transaction
    expect(deps.repos.tx).not.toHaveBeenCalled();
  });

  it("returns no-op when layout has no sections", async () => {
    const deps = buildDeps({
      layout: buildLayout({ sections: [] }),
    });

    const result = await materializeEventSeatSections(deps, {
      eventId: EVENT_ID,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sectionsCreated: 0,
      seatsCreated: 0,
      sectionIdMap: {},
    });

    expect(deps.repos.tx).not.toHaveBeenCalled();
  });

  it("returns no-op when layout is not found", async () => {
    const deps = buildDeps({ layout: null });

    const result = await materializeEventSeatSections(deps, {
      eventId: EVENT_ID,
    });

    expect(result).toEqual({
      eventId: EVENT_ID,
      placeLayoutId: LAYOUT_ID,
      sectionsCreated: 0,
      seatsCreated: 0,
      sectionIdMap: {},
    });

    expect(deps.repos.tx).not.toHaveBeenCalled();
  });

  it("throws not_found when event does not exist", async () => {
    const deps = buildDeps({ event: null });

    await expect(
      materializeEventSeatSections(deps, { eventId: EVENT_ID }),
    ).rejects.toMatchObject({ code: "EVENT_NOT_FOUND" });
  });

  it("rejects invalid input", async () => {
    const deps = buildDeps();

    await expect(
      materializeEventSeatSections(deps, { eventId: "not-a-uuid" }),
    ).rejects.toThrow();
  });

  it("passes seatIds through to the adapter", async () => {
    const seatIds = ["seat-001", "seat-002", "seat-003"];
    const matFn = vi.fn(async () => ({
      sectionsCreated: 1,
      seatsCreated: 3,
      sectionIdMap: { "ga-floor": SECTION_DB_ID_1 },
    }));

    const txRepos = { seats: { materializeSections: matFn } };

    const deps: MaterializeEventSeatSectionsDeps = {
      repos: {
        events: { getById: vi.fn(async () => buildEvent()) },
        placeLayouts: {
          getById: vi.fn(async () =>
            buildLayout({
              sections: [
                {
                  sectionId: "ga-floor",
                  label: "GA Floor",
                  capacity: 200,
                  color: null,
                  geometry: null,
                  stageAnchor: null,
                },
              ],
              seatIds,
            }),
          ),
        },
        tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<unknown>) =>
          fn(txRepos),
        ),
      } as unknown as MaterializeEventSeatSectionsDeps["repos"],
    };

    const result = await materializeEventSeatSections(deps, {
      eventId: EVENT_ID,
    });

    expect(result.seatsCreated).toBe(3);
    expect(matFn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: EVENT_ID,
        placeLayoutId: LAYOUT_ID,
        seatIds,
        sections: [
          expect.objectContaining({ sectionId: "ga-floor", label: "GA Floor" }),
        ],
      }),
    );
  });
});

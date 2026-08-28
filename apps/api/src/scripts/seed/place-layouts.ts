import type { PrismaClient } from "@prisma/client";
import { DEMO_IDS } from "./ids.js";

// ─────────────────────────────────────────────────────────────────────────────
// Place layout seed — generates small, realistic seat layouts for demo places.
// ─────────────────────────────────────────────────────────────────────────────

const METADATA_VERSION = 2;

type SeedSectionGeometry = {
  polygons: Array<Array<{ x: number; y: number }>>;
  origin: { x: number; y: number };
};

type SeedSection = {
  sectionId: string;
  label: string;
  color: string;
  capacity: number;
  geometry?: SeedSectionGeometry;
};

type SeedSeat = {
  seatId: string;
  sectionId: string;
  row: string;
  seat: number;
  x: number;
  y: number;
};

/** Build a grid of seats for a given section. */
function buildGrid(
  sectionId: string,
  rows: string[],
  seatsPerRow: number,
  origin: { x: number; y: number },
  spacing: { x: number; y: number },
): SeedSeat[] {
  const seats: SeedSeat[] = [];
  for (let r = 0; r < rows.length; r++) {
    for (let s = 1; s <= seatsPerRow; s++) {
      seats.push({
        seatId: `${sectionId}-${rows[r]}-${s}`,
        sectionId,
        row: rows[r]!,
        seat: s,
        x: origin.x + (s - 1) * spacing.x,
        y: origin.y + r * spacing.y,
      });
    }
  }
  return seats;
}

/**
 * Derive a bounding-box polygon + label origin from a list of seats.
 * Adds `pad` units of padding on each side so the polygon doesn't
 * hug the outermost seat circles.
 */
function deriveGeometry(seats: SeedSeat[], pad = 12): SeedSectionGeometry {
  const xs = seats.map((s) => s.x);
  const ys = seats.map((s) => s.y);
  const minX = Math.min(...xs) - pad;
  const minY = Math.min(...ys) - pad;
  const maxX = Math.max(...xs) + pad;
  const maxY = Math.max(...ys) + pad;

  return {
    polygons: [
      [
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ],
    ],
    origin: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
  };
}

type PlaceLayoutFixture = {
  placeId: string;
  createdByHumanId: string;
  sections: SeedSection[];
  seats: SeedSeat[];
  stage: {
    kind: string;
    label: string;
    bounds: { minX: number; minY: number; maxX: number; maxY: number };
  } | null;
};

function buildParamountLayout(): PlaceLayoutFixture {
  // Paramount Theatre — classic proscenium theater, wide auditorium
  // 16 seats/row for orchestra gives a realistic wide fan shape
  const orchSeats = buildGrid(
    "orch",
    ["A", "B", "C", "D", "E", "F", "G", "H"],
    16,
    { x: 40, y: 100 },
    { x: 26, y: 24 },
  );
  const mezzSeats = buildGrid(
    "mezz",
    ["J", "K", "L", "M", "N"],
    14,
    { x: 66, y: 310 },
    { x: 26, y: 24 },
  );
  const balcSeats = buildGrid(
    "balc",
    ["P", "Q", "R", "S"],
    12,
    { x: 92, y: 450 },
    { x: 26, y: 24 },
  );

  const orchSection: SeedSection = {
    sectionId: "orch",
    label: "Orchestra",
    color: "#4A90D2",
    capacity: 128,
    geometry: deriveGeometry(orchSeats),
  };
  const mezSection: SeedSection = {
    sectionId: "mezz",
    label: "Mezzanine",
    color: "#E74C3C",
    capacity: 70,
    geometry: deriveGeometry(mezzSeats),
  };
  const balcSection: SeedSection = {
    sectionId: "balc",
    label: "Balcony",
    color: "#2ECC71",
    capacity: 48,
    geometry: deriveGeometry(balcSeats),
  };

  return {
    placeId: DEMO_IDS.place1,
    createdByHumanId: DEMO_IDS.devUser,
    sections: [orchSection, mezSection, balcSection],
    seats: [...orchSeats, ...mezzSeats, ...balcSeats],
    stage: {
      kind: "rectangle",
      label: "Main Stage",
      bounds: { minX: 60, minY: 20, maxX: 430, maxY: 80 },
    },
  };
}

function buildStubbsLayout(): PlaceLayoutFixture {
  // Stubb's — outdoor amphitheatre, wide standing area with elevated VIP
  const gaSeats = buildGrid(
    "ga",
    ["A", "B", "C", "D", "E", "F"],
    14,
    { x: 40, y: 130 },
    { x: 28, y: 26 },
  );
  const vipSeats = buildGrid(
    "vip",
    ["V1", "V2", "V3"],
    12,
    { x: 68, y: 50 },
    { x: 28, y: 20 },
  );

  const gaSection: SeedSection = {
    sectionId: "ga",
    label: "General Admission",
    color: "#F39C12",
    capacity: 84,
    geometry: deriveGeometry(gaSeats),
  };
  const vipSection: SeedSection = {
    sectionId: "vip",
    label: "VIP Pit",
    color: "#9B59B6",
    capacity: 36,
    geometry: deriveGeometry(vipSeats),
  };

  return {
    placeId: DEMO_IDS.place2,
    createdByHumanId: DEMO_IDS.devUser,
    sections: [gaSection, vipSection],
    seats: [...gaSeats, ...vipSeats],
    stage: {
      kind: "rectangle",
      label: "Stage",
      bounds: { minX: 20, minY: -10, maxX: 440, maxY: 35 },
    },
  };
}

function buildGreekTheatreLayout(): PlaceLayoutFixture {
  // Greek Theatre — wide semi-circular bowl with two tiers
  const lowerSeats = buildGrid(
    "lower",
    ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
    14,
    { x: 40, y: 100 },
    { x: 28, y: 24 },
  );
  const upperSeats = buildGrid(
    "upper",
    ["J", "K", "L", "M", "N", "O", "P"],
    12,
    { x: 68, y: 330 },
    { x: 28, y: 24 },
  );

  const lowerSection: SeedSection = {
    sectionId: "lower",
    label: "Lower Bowl",
    color: "#1ABC9C",
    capacity: 126,
    geometry: deriveGeometry(lowerSeats),
  };
  const upperSection: SeedSection = {
    sectionId: "upper",
    label: "Upper Bowl",
    color: "#E67E22",
    capacity: 84,
    geometry: deriveGeometry(upperSeats),
  };

  return {
    placeId: DEMO_IDS.place4,
    createdByHumanId: DEMO_IDS.devUser,
    sections: [lowerSection, upperSection],
    seats: [...lowerSeats, ...upperSeats],
    stage: {
      kind: "rectangle",
      label: "Greek Stage",
      bounds: { minX: 60, minY: 20, maxX: 420, maxY: 80 },
    },
  };
}

function buildSomaWarehouseLayout(): PlaceLayoutFixture {
  // Wide warehouse floor grid — 25 cols x 10 rows
  const gaSeats = buildGrid(
    "ga-floor",
    ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"],
    25,
    { x: 30, y: 120 },
    { x: 20, y: 22 },
  );
  // Elevated VIP platform — 10 cols x 5 rows, centered above GA
  const vipSeats = buildGrid(
    "vip-lounge",
    ["V1", "V2", "V3", "V4", "V5"],
    10,
    { x: 130, y: 20 },
    { x: 20, y: 18 },
  );

  const gaSection: SeedSection = {
    sectionId: "ga-floor",
    label: "General Admission",
    color: "#3498DB",
    capacity: 250,
    geometry: deriveGeometry(gaSeats),
  };
  const vipSection: SeedSection = {
    sectionId: "vip-lounge",
    label: "VIP",
    color: "#E74C3C",
    capacity: 50,
    geometry: deriveGeometry(vipSeats),
  };

  return {
    placeId: DEMO_IDS.place6,
    createdByHumanId: DEMO_IDS.devUser,
    sections: [gaSection, vipSection],
    seats: [...gaSeats, ...vipSeats],
    stage: {
      kind: "rectangle",
      label: "DJ Booth",
      bounds: { minX: 160, minY: 360, maxX: 380, maxY: 400 },
    },
  };
}

function buildFillmoreLayout(): PlaceLayoutFixture {
  // The Fillmore — classic 3-section theater: Orchestra (orch), Mezzanine (mezz), Balcony (balc)
  const orchSeats = buildGrid(
    "orch",
    ["A", "B", "C", "D", "E", "F", "G"],
    12,
    { x: 40, y: 90 },
    { x: 22, y: 22 },
  );
  const mezzSeats = buildGrid(
    "mezz",
    ["H", "I", "J", "K", "L"],
    10,
    { x: 62, y: 260 },
    { x: 22, y: 22 },
  );
  const balcSeats = buildGrid(
    "balc",
    ["M", "N", "O", "P"],
    10,
    { x: 62, y: 390 },
    { x: 22, y: 22 },
  );

  const orchSection: SeedSection = {
    sectionId: "orch",
    label: "Orchestra",
    color: "#E67E22",
    capacity: 84,
    geometry: deriveGeometry(orchSeats),
  };
  const mezzSection: SeedSection = {
    sectionId: "mezz",
    label: "Mezzanine",
    color: "#2ECC71",
    capacity: 50,
    geometry: deriveGeometry(mezzSeats),
  };
  const balcSection: SeedSection = {
    sectionId: "balc",
    label: "Balcony",
    color: "#9B59B6",
    capacity: 40,
    geometry: deriveGeometry(balcSeats),
  };

  return {
    placeId: DEMO_IDS.place3,
    createdByHumanId: DEMO_IDS.devUser,
    sections: [orchSection, mezzSection, balcSection],
    seats: [...orchSeats, ...mezzSeats, ...balcSeats],
    stage: {
      kind: "rectangle",
      label: "Stage",
      bounds: { minX: 30, minY: 10, maxX: 280, maxY: 75 },
    },
  };
}

const PLACE_LAYOUT_FIXTURES: PlaceLayoutFixture[] = [
  buildParamountLayout(),
  buildStubbsLayout(),
  buildGreekTheatreLayout(),
  buildSomaWarehouseLayout(),
  buildFillmoreLayout(),
];

/**
 * Seed deterministic place layouts directly into the database.
 *
 * Uses Prisma upsert so re-runs are idempotent. The glyph blob key is set
 * to a placeholder since we don't have real object storage during seeding —
 * the layout editor page will still render the section/seat metadata.
 */
export async function ensurePlaceLayouts(prisma: PrismaClient) {
  const results: {
    placeId: string;
    seatCount: number;
    sectionCount: number;
  }[] = [];

  for (const fixture of PLACE_LAYOUT_FIXTURES) {
    const seatIds = fixture.seats.map((s) => s.seatId);

    // Collect all interesting x/y values: seats, section polygon vertices, stage bounds.
    const allXs: number[] = fixture.seats.map((s) => s.x);
    const allYs: number[] = fixture.seats.map((s) => s.y);

    for (const section of fixture.sections) {
      if (section.geometry) {
        for (const poly of section.geometry.polygons) {
          for (const pt of poly) {
            allXs.push(pt.x);
            allYs.push(pt.y);
          }
        }
      }
    }

    if (fixture.stage) {
      allXs.push(fixture.stage.bounds.minX, fixture.stage.bounds.maxX);
      allYs.push(fixture.stage.bounds.minY, fixture.stage.bounds.maxY);
    }

    const seatIndexBounds = {
      minX: Math.min(...allXs),
      minY: Math.min(...allYs),
      maxX: Math.max(...allXs),
      maxY: Math.max(...allYs),
    };

    const checksum = `seed-${fixture.placeId.slice(-4)}-${seatIds.length}`;
    const glyphSnapshotKey = `place-layout-glyphs/${fixture.placeId}/${checksum}.json`;

    const metadata = {
      version: METADATA_VERSION,
      seatIds,
      seatCount: seatIds.length,
      sectionCount: fixture.sections.length,
      seatIndexBounds,
      sections: fixture.sections.map((s) => ({
        sectionId: s.sectionId,
        label: s.label,
        color: s.color,
        capacity: s.capacity,
        ...(s.geometry ? { geometry: s.geometry } : {}),
      })),
    };

    const stageJson = fixture.stage ?? {};

    await prisma.placeLayout.upsert({
      where: {
        placeId_name: { placeId: fixture.placeId, name: "Default" },
      },
      update: {
        checksum,
        glyphSnapshotKey,
        metadata,
        seatIndex: { version: 1, bounds: seatIndexBounds },
        stage: stageJson,
        createdByHumanId: fixture.createdByHumanId,
      },
      create: {
        placeId: fixture.placeId,
        name: "Default",
        checksum,
        glyphSnapshotKey,
        metadata,
        seatIndex: { version: 1, bounds: seatIndexBounds },
        stage: stageJson,
        issues: [],
        createdByHumanId: fixture.createdByHumanId,
      },
    });

    results.push({
      placeId: fixture.placeId,
      seatCount: seatIds.length,
      sectionCount: fixture.sections.length,
    });
  }

  return results;
}

/**
 * Link events to their venue's PlaceLayout.
 *
 * For every event at a Place that has a PlaceLayout, set `event.placeLayoutId`
 * so the checkout page knows to render the seat picker instead of GA grid.
 *
 * Must run AFTER both `ensurePlaceLayouts` and event creation.
 */
export async function linkEventsToPlaceLayouts(prisma: PrismaClient) {
  const linked: { eventSlug: string; placeId: string; layoutId: string }[] = [];

  // Find all layouts keyed by placeId
  const layouts = await prisma.placeLayout.findMany({
    select: { id: true, placeId: true },
  });
  const layoutByPlace = new Map(layouts.map((l) => [l.placeId, l.id]));

  // Find events at places that have layouts but where placeLayoutId is null
  const events = await prisma.event.findMany({
    where: {
      placeId: { in: Array.from(layoutByPlace.keys()) },
      placeLayoutId: null,
    },
    select: { id: true, slug: true, placeId: true },
  });

  for (const event of events) {
    if (!event.placeId) continue;
    const layoutId = layoutByPlace.get(event.placeId);
    if (!layoutId) continue;

    await prisma.event.update({
      where: { id: event.id },
      data: { placeLayoutId: layoutId },
    });

    linked.push({
      eventSlug: event.slug ?? event.id,
      placeId: event.placeId,
      layoutId,
    });
  }

  return linked;
}

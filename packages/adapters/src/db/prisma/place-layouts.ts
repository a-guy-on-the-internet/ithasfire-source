import { Prisma } from "@prisma/client";
import type {
  PlaceLayoutRecord,
  PlaceLayoutRepo,
  PlaceLayoutStatusRepo,
  ReplacePlaceLayoutInput,
  SeatIndexBounds,
  SeatSection,
  StageLayout,
} from "@th/ports/place-layouts";
import { normalizeStorageKey } from "@th/ports/file-storage";

import type { PrismaClientOrTx } from "./types";

const PLACE_LAYOUT_SELECT = {
  id: true,
  placeId: true,
  name: true,
  checksum: true,
  metadata: true,
  stage: true,
  createdByHumanId: true,
  updatedAt: true,
} as const;

type PlaceLayoutModel = {
  id: string;
  placeId: string;
  name: string;
  checksum: string;
  metadata: Prisma.JsonValue | null;
  stage: Prisma.JsonValue | null;
  createdByHumanId: string | null;
  updatedAt: Date;
};

type PlaceLayoutMetadataEnvelope = {
  version: number;
  seatIds: string[];
  seatCount: number;
  sectionCount: number;
  seatIndexBounds: SeatIndexBounds;
  sections: SeatSection[];
  statusSnapshot?: {
    seatIds: string[];
    updatedAt: string;
  };
};

const DEFAULT_BASE_PREFIX = "place-layouts";
const SEAT_INDEX_VERSION = 1;
const METADATA_VERSION = 1;

export function makePlaceLayoutsRepo(p: PrismaClientOrTx): PlaceLayoutRepo {
  return {
    async getById(id) {
      const row = await p.placeLayout.findUnique({
        where: { id },
        select: PLACE_LAYOUT_SELECT,
      });

      if (!row) {
        return null;
      }

      return mapPlaceLayout(row);
    },

    async getByPlace(placeId) {
      const row = await p.placeLayout.findFirst({
        where: { placeId },
        select: PLACE_LAYOUT_SELECT,
      });

      if (!row) {
        return null;
      }

      return mapPlaceLayout(row);
    },

    async listByPlace(placeId) {
      const rows = await p.placeLayout.findMany({
        where: { placeId },
        select: PLACE_LAYOUT_SELECT,
        orderBy: { name: "asc" },
      });

      return rows.map(mapPlaceLayout);
    },

    async replaceWithSnapshot(input) {
      const metadataJson = buildMetadataJson(input);
      const seatIndexJson = buildSeatIndexJson(input.seatIndexBounds);
      const stageJson = buildStageJson(input.stage ?? null);
      const glyphSnapshotKey = buildGlyphSnapshotKey(
        input.placeId,
        input.checksum,
      );
      const layoutName = (input as { name?: string }).name ?? "Default";

      const row = await p.placeLayout.upsert({
        where: { placeId_name: { placeId: input.placeId, name: layoutName } },
        update: {
          checksum: input.checksum,
          glyphSnapshotKey,
          metadata: metadataJson,
          seatIndex: seatIndexJson,
          stage: stageJson,
          createdByHumanId: input.createdByHumanId,
        },
        create: {
          placeId: input.placeId,
          name: layoutName,
          checksum: input.checksum,
          glyphSnapshotKey,
          metadata: metadataJson,
          seatIndex: seatIndexJson,
          stage: stageJson,
          issues: Prisma.JsonNull,
          createdByHumanId: input.createdByHumanId,
        },
        select: PLACE_LAYOUT_SELECT,
      });

      return mapPlaceLayout(row);
    },

    async deleteForPlace(placeId) {
      const existing = await p.placeLayout.findMany({
        where: { placeId },
        select: { id: true, checksum: true },
      });

      if (existing.length === 0) {
        return { deleted: false, checksum: null } as const;
      }

      await p.placeLayout.deleteMany({ where: { placeId } });
      return { deleted: true, checksum: existing[0]!.checksum } as const;
    },
  };
}

export function makePlaceLayoutStatusesRepo(
  p: PrismaClientOrTx,
): PlaceLayoutStatusRepo {
  return {
    async upsertStatuses({ placeId, seatIds }) {
      await updateMetadata(p, placeId, (metadata) => {
        const uniqueSeatIds = Array.from(new Set(seatIds));
        metadata.statusSnapshot = {
          seatIds: uniqueSeatIds,
          updatedAt: new Date().toISOString(),
        };
      });
    },

    async deleteByPlace(placeId) {
      await updateMetadata(p, placeId, (metadata) => {
        delete metadata.statusSnapshot;
      });
    },
  };
}

function mapPlaceLayout(model: PlaceLayoutModel): PlaceLayoutRecord {
  const metadata = ensureMetadata(model.metadata);
  const stage = parseStage(model.stage);

  return {
    id: model.id,
    name: model.name,
    placeId: model.placeId,
    checksum: model.checksum,
    seatCount: metadata.seatCount,
    sectionCount: metadata.sectionCount,
    seatIndexBounds: metadata.seatIndexBounds,
    sections: metadata.sections,
    stage,
    updatedAt: model.updatedAt,
    seatIds: metadata.seatIds,
    createdByHumanId: model.createdByHumanId,
  } satisfies PlaceLayoutRecord;
}

function ensureMetadata(
  raw: Prisma.JsonValue | null,
): PlaceLayoutMetadataEnvelope {
  if (isNullishJson(raw)) {
    throw new Error("place_layout_metadata_missing");
  }

  const metadata = raw as Partial<PlaceLayoutMetadataEnvelope>;
  if (
    !Array.isArray(metadata.seatIds) ||
    !Array.isArray(metadata.sections) ||
    !metadata.seatIndexBounds
  ) {
    throw new Error("place_layout_metadata_invalid");
  }

  return {
    version:
      typeof metadata.version === "number"
        ? metadata.version
        : METADATA_VERSION,
    seatIds: metadata.seatIds as string[],
    seatCount:
      typeof metadata.seatCount === "number"
        ? metadata.seatCount
        : (metadata.seatIds as string[]).length,
    sectionCount:
      typeof metadata.sectionCount === "number"
        ? metadata.sectionCount
        : (metadata.sections as SeatSection[]).length,
    seatIndexBounds: metadata.seatIndexBounds,
    sections: metadata.sections as SeatSection[],
    statusSnapshot: metadata.statusSnapshot
      ? {
          seatIds: Array.isArray(metadata.statusSnapshot.seatIds)
            ? (metadata.statusSnapshot.seatIds as string[])
            : [],
          updatedAt:
            typeof metadata.statusSnapshot.updatedAt === "string"
              ? metadata.statusSnapshot.updatedAt
              : new Date(0).toISOString(),
        }
      : undefined,
  } satisfies PlaceLayoutMetadataEnvelope;
}

function parseStage(raw: Prisma.JsonValue | null): StageLayout | null {
  if (isNullishJson(raw)) {
    return null;
  }

  const stage = raw as StageLayout;
  if (Object.keys(stage).length === 0) {
    return null;
  }

  return stage;
}

function buildMetadataJson(
  input: ReplacePlaceLayoutInput,
): Prisma.InputJsonValue {
  const payload: PlaceLayoutMetadataEnvelope = {
    version: METADATA_VERSION,
    seatIds: [...input.seatIds],
    seatCount: input.seatIds.length,
    sectionCount: input.sections.length,
    seatIndexBounds: input.seatIndexBounds,
    sections: input.sections,
  };

  return payload as Prisma.InputJsonValue;
}

function buildSeatIndexJson(bounds: SeatIndexBounds): Prisma.InputJsonValue {
  return {
    version: SEAT_INDEX_VERSION,
    bounds,
  } as Prisma.InputJsonValue;
}

function buildStageJson(
  stage: StageLayout | null,
): Prisma.InputJsonValue | Prisma.JsonNullValueInput {
  if (!stage) {
    return Prisma.JsonNull;
  }
  return stage as Prisma.InputJsonValue;
}

function buildGlyphSnapshotKey(placeId: string, checksum: string): string {
  const placeSegment = sanitizeSegment(placeId);
  const checksumSegment = sanitizeSegment(checksum);
  const joined = [DEFAULT_BASE_PREFIX, placeSegment, `${checksumSegment}.json`]
    .filter((segment) => segment.length > 0)
    .join("/");
  return normalizeStorageKey(joined);
}

function sanitizeSegment(segment: string): string {
  return segment.trim().replace(/^\/+|\/+$|\s+/g, "");
}

async function updateMetadata(
  p: PrismaClientOrTx,
  placeId: string,
  mutator: (metadata: PlaceLayoutMetadataEnvelope) => void,
): Promise<void> {
  const row = await p.placeLayout.findFirst({
    where: { placeId },
    select: { id: true, metadata: true },
  });

  if (!row) {
    return;
  }

  const metadata = ensureMetadata(row.metadata);
  mutator(metadata);

  await p.placeLayout.update({
    where: { id: row.id },
    data: {
      metadata: metadata as Prisma.InputJsonValue,
    },
  });
}

function isNullishJson(value: Prisma.JsonValue | null): boolean {
  if (value === null) {
    return true;
  }

  const candidate = value as unknown;
  return (
    candidate === Prisma.DbNull ||
    candidate === Prisma.JsonNull ||
    candidate === Prisma.AnyNull
  );
}

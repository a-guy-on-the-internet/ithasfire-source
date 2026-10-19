import { createHash } from "node:crypto";

import type { LoggerPort } from "@th/ports/logger";
import type { PlaceLayoutBlobRepo, SeatGlyph } from "@th/ports/place-layouts";
import {
  FILE_STORAGE_MAX_LIST_LIMIT,
  type FileStoragePort,
  normalizeStorageKey,
  normalizeStoragePrefix,
} from "@th/ports/file-storage";

const DEFAULT_BASE_PREFIX = "place-layouts";
const SNAPSHOT_CONTENT_TYPE = "application/json";
const SNAPSHOT_SCHEMA_VERSION = "1";

export type PlaceLayoutBlobStorageOptions = {
  storage: FileStoragePort;
  /**
   * Prefix under which glyph snapshots are stored. Defaults to `place-layouts`.
   */
  basePrefix?: string;
  /** Optional logger for warning/diagnostic messages. */
  logger?: LoggerPort;
};

export class PlaceLayoutBlobStorage implements PlaceLayoutBlobRepo {
  private readonly storage: FileStoragePort;
  private readonly basePrefix: string | null;
  private readonly logger?: LoggerPort;

  constructor(options: PlaceLayoutBlobStorageOptions) {
    this.storage = options.storage;
    this.basePrefix = sanitizeSegment(
      options.basePrefix ?? DEFAULT_BASE_PREFIX,
    );
    this.logger = options.logger;
  }

  async putForPlace(input: {
    placeId: string;
    glyphs: SeatGlyph[];
    checksumHint?: string | null;
  }): Promise<{ checksum: string }> {
    const checksum = calculateGlyphChecksum(input.glyphs);
    if (input.checksumHint && input.checksumHint !== checksum) {
      this.logger?.warn("place_layout_blob_checksum_mismatch", {
        placeId: input.placeId,
        checksumHint: input.checksumHint,
        actualChecksum: checksum,
      });
    }

    const key = this.buildSnapshotKey(input.placeId, checksum);
    const payload = this.serializeSnapshot(
      input.placeId,
      checksum,
      input.glyphs,
    );

    await this.storage.putObject({
      key,
      content: Buffer.from(payload, "utf-8"),
      options: {
        contentType: SNAPSHOT_CONTENT_TYPE,
        metadata: {
          checksum,
          placeId: input.placeId,
          schemaVersion: SNAPSHOT_SCHEMA_VERSION,
          seatCount: String(input.glyphs.length),
        },
      },
    });

    await this.pruneObsoleteSnapshots(input.placeId, key).catch((error) => {
      this.logger?.error("place_layout_blob_prune_failed", {
        placeId: input.placeId,
        err: error,
      });
    });

    return { checksum } as const;
  }

  async getGlyphUrl(input: {
    placeId: string;
    checksum: string;
  }): Promise<{ url: string } | null> {
    const key = this.buildSnapshotKey(input.placeId, input.checksum);

    try {
      const result = await this.storage.getObjectUrl({
        key,
        options: { expiresSec: 3600 },
      });
      return { url: result.url };
    } catch (error: unknown) {
      const err = error as { code?: string };
      if (err.code === "not_found") {
        return null;
      }
      throw error;
    }
  }

  async deleteForPlace(placeId: string): Promise<void> {
    const keys = await this.collectSnapshotKeys(placeId);
    if (keys.length === 0) return;

    await Promise.all(
      keys.map((key) =>
        this.storage.deleteObject({ key }).catch((error) => {
          this.logger?.error("place_layout_blob_delete_failed", {
            placeId,
            key,
            err: error,
          });
          throw error;
        }),
      ),
    );
  }

  private serializeSnapshot(
    placeId: string,
    checksum: string,
    glyphs: SeatGlyph[],
  ): string {
    const envelope = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      placeId,
      checksum,
      generatedAt: new Date().toISOString(),
      seatCount: glyphs.length,
      glyphs,
    } as const;

    return JSON.stringify(envelope);
  }

  private async pruneObsoleteSnapshots(
    placeId: string,
    keepKey: string,
  ): Promise<void> {
    const keys = await this.collectSnapshotKeys(placeId);
    const obsolete = keys.filter((key) => key !== keepKey);
    if (obsolete.length === 0) {
      return;
    }

    await Promise.all(
      obsolete.map((key) =>
        this.storage.deleteObject({ key }).catch((error) => {
          this.logger?.warn("place_layout_blob_prune_error", {
            placeId,
            key,
            err: error,
          });
        }),
      ),
    );
  }

  private async collectSnapshotKeys(placeId: string): Promise<string[]> {
    const prefix = this.buildSnapshotPrefix(placeId);
    const keys: string[] = [];

    let cursor: string | undefined;
    do {
      const page = await this.storage.listObjects({
        prefix,
        cursor,
        limit: FILE_STORAGE_MAX_LIST_LIMIT,
      });

      for (const entry of page.keys) {
        keys.push(normalizeStorageKey(entry.key));
      }

      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    return keys;
  }

  private buildSnapshotPrefix(placeId: string): string {
    const segment = sanitizeSegment(placeId);
    const joined = joinSegments(this.basePrefix, segment);
    return normalizeStoragePrefix(joined ?? "");
  }

  private buildSnapshotKey(placeId: string, checksum: string): string {
    const joined = joinSegments(
      this.basePrefix,
      sanitizeSegment(placeId),
      `${checksum}.json`,
    );
    return normalizeStorageKey(joined);
  }
}

const joinSegments = (
  ...segments: Array<string | null | undefined>
): string => {
  const filtered = segments
    .map((segment) => sanitizeSegment(segment ?? ""))
    .filter((segment): segment is string => Boolean(segment));

  if (filtered.length === 0) {
    return "";
  }

  return filtered.join("/");
};

const sanitizeSegment = (segment: string): string | null => {
  const trimmed = segment.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/^\/+|\/+$/g, "");
};

const calculateGlyphChecksum = (glyphs: SeatGlyph[]): string => {
  const hash = createHash("sha256");
  const sorted = [...glyphs].sort((a, b) => a.seatId.localeCompare(b.seatId));

  for (const glyph of sorted) {
    hash.update(glyph.seatId);
    hash.update(glyph.sectionId);
    hash.update(glyph.label);
    hash.update(String(glyph.position.x));
    hash.update(String(glyph.position.y));
    if (glyph.radius !== undefined) hash.update(String(glyph.radius));
    if (glyph.width !== undefined) hash.update(String(glyph.width));
    if (glyph.height !== undefined) hash.update(String(glyph.height));
    if (glyph.rotationDeg !== undefined) hash.update(String(glyph.rotationDeg));
    if (glyph.facingAngleDeg !== undefined)
      hash.update(String(glyph.facingAngleDeg));
    if (glyph.metadata) hash.update(JSON.stringify(glyph.metadata));
  }

  return hash.digest("hex");
};

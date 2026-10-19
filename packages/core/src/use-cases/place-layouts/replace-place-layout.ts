import { createHash } from "node:crypto";
import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { FileStoragePort } from "@th/ports/file-storage";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type {
  PlaceLayoutGeometryParserInput,
  PlaceLayoutGeometryParserPort,
  PlaceLayoutGeometryParserResult,
  PlaceLayoutParserIssue,
  SeatGlyph,
  SeatIndexBounds,
  SeatSection,
  PlaceLayoutDiff,
  StageLayout,
} from "@th/ports/place-layouts";
import type { PlaceLayoutStreamingPort } from "@th/ports/place-layouts";
import type { Repos, TxRepos } from "@th/ports/repos";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { incrementResourceUsage } from "../quotas/enforce-quota";
import { verifyUploadedObjectSize } from "../storage/verify-uploaded-object-size";
import { MAX_PLACE_LAYOUT_CSV_BYTES } from "./request-place-layout-upload";
import { fail } from "@th/errors";

const IDEMPOTENCY_TTL_SECONDS = 300;

const placeLayoutParserIssueSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.union([z.literal("warning"), z.literal("error")]),
  details: z.record(z.string(), z.unknown()).optional(),
});
export const replacePlaceLayoutInputSchema = z.object({
  placeId: z.string().uuid(),
  actorHumanId: z.string().uuid(),
  upload: z.object({
    ref: z.string().min(1),
    format: z.string().min(1),
    source: z.string().min(1),
  }),
  options: z
    .object({
      dryRun: z.boolean().optional(),
      idempotencyKey: z.string().min(8).optional(),
    })
    .optional(),
});

export const replacePlaceLayoutOutputSchema = z.object({
  checksum: z.string().min(1),
  diff: z.object({
    added: z.number().nonnegative(),
    removed: z.number().nonnegative(),
    moved: z.number().nonnegative(),
    sectionsChanged: z.array(z.string()),
  }),
  issues: z.array(placeLayoutParserIssueSchema),
  seatCount: z.number().nonnegative(),
  sectionCount: z.number().nonnegative(),
  seatIndexBounds: z.object({
    minX: z.number(),
    minY: z.number(),
    maxX: z.number(),
    maxY: z.number(),
  }),
});

export type ReplacePlaceLayoutInput = z.infer<
  typeof replacePlaceLayoutInputSchema
>;
export type ReplacePlaceLayoutOutput = z.infer<
  typeof replacePlaceLayoutOutputSchema
>;

export type ReplacePlaceLayoutDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "canManagePlace">;
  parser: PlaceLayoutGeometryParserPort;
  idempotency: IdempotencyPort;
  streaming: PlaceLayoutStreamingPort;
  /**
   * HEADs the raw CSV before parsing (F11 size gate) and reclaims stale raw
   * CSVs after a successful replace. The composition root always wires it;
   * without it the parser's own 5 MB read guard is the only size bound.
   */
  storage?: Pick<FileStoragePort, "listObjects" | "deleteObject" | "headObject">;
  clock: ClockPort;
  logger?: LoggerPort;
  /** Reports the swallowed best-effort CSV cleanup failure. */
  reportError?: ReporterPort;
};

interface StoredReplacePlaceLayoutRecord {
  payloadHash: string;
  response: ReplacePlaceLayoutOutput;
}

export async function replacePlaceLayout(
  deps: ReplacePlaceLayoutDeps,
  rawInput: unknown,
): Promise<ReplacePlaceLayoutOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "replacePlaceLayout" });

  const execute = async () => {
    const input = parseInput(replacePlaceLayoutInputSchema, rawInput);

    // Same gate as requestPlaceLayoutUpload: only a manager of THIS place may
    // overwrite its seat map (security review F2, 2026-09-29).
    const perm = await deps.authz.canManagePlace({
      actorHumanId: input.actorHumanId,
      placeId: input.placeId,
    });
    if (!perm.allowed) {
      throw fail("INSUFFICIENT_ROLE");
    }

    // The parser fetches whatever key it is handed, so bind the ref to this
    // place: it must be exactly the shape requestPlaceLayoutUpload mints for
    // `input.placeId`. Otherwise a manager of place A could apply A's upload
    // (or any other bucket key) to place B.
    if (!isOwnRawCsvRef(input.placeId, input.upload.ref)) {
      throw fail("INSUFFICIENT_ROLE");
    }

    const options = input.options ?? {};
    const dryRun = options.dryRun ?? false;

    if (!dryRun && !options.idempotencyKey) {
      throw fail("IDEMPOTENCY_KEY_REQUIRED");
    }

    const existingLayout = await deps.repos.placeLayouts.getByPlace(
      input.placeId,
    );

    // F11 (2026-09-29): the org's storage quota was charged from the size
    // declared at presign, so a raw CSV bigger than that (or than the 5 MB
    // cap) is deleted and refused before the parser ever fetches it.
    if (deps.storage) {
      const head = await verifyUploadedObjectSize(
        {
          storage: deps.storage,
          logger: scopedLogger,
          reportError: deps.reportError,
        },
        {
          key: input.upload.ref,
          maxBytes: MAX_PLACE_LAYOUT_CSV_BYTES,
          context: "replacePlaceLayout",
        },
      );
      if (!head.exists) {
        throw fail("UPLOAD_NOT_COMPLETE");
      }
    }

    const parsed = await deps.parser.parse({
      placeId: input.placeId,
      uploadRef: input.upload.ref,
      format: input.upload.format,
      source: input.upload.source,
    } satisfies PlaceLayoutGeometryParserInput);

    const fatalIssues = collectFatalIssues(parsed);
    if (fatalIssues.length > 0) {
      throw {
        code: "invalid_input",
        message: "place_layout_parser_error",
        issues: fatalIssues,
      } as const;
    }

    const glyphs = parsed.glyphs;
    const sections = parsed.sections;
    const stage = parsed.stage ?? null;
    if (glyphs.length === 0) {
      throw fail("PLACE_LAYOUT_EMPTY");
    }

    const seatIds = glyphs.map((glyph) => glyph.seatId);
    if (new Set(seatIds).size !== seatIds.length) {
      throw fail("SEAT_IDS_NOT_UNIQUE");
    }

    const bounds = computeSeatIndexBounds(glyphs);
    const diff = computeDiff(existingLayout ?? null, seatIds, sections);
    const issues = parsed.issues.filter(
      (issue) => issue.severity === "warning",
    );
    const predictedChecksum = calculateGeometryChecksum(glyphs);

    const baseOutput: ReplacePlaceLayoutOutput = {
      checksum: predictedChecksum,
      diff,
      issues,
      seatCount: seatIds.length,
      sectionCount: sections.length,
      seatIndexBounds: bounds,
    };

    if (dryRun) {
      return baseOutput;
    }

    const idempotencyKey = buildIdempotencyKey(
      input.placeId,
      options.idempotencyKey!,
    );
    const payloadHash = buildPayloadHash(input, parsed, predictedChecksum);

    const prior =
      await deps.idempotency.get<StoredReplacePlaceLayoutRecord>(
        idempotencyKey,
      );
    if (prior) {
      if (prior.payloadHash !== payloadHash) {
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return prior.response;
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const replay =
        await deps.idempotency.get<StoredReplacePlaceLayoutRecord>(
          idempotencyKey,
        );
      if (replay) {
        if (replay.payloadHash !== payloadHash) {
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return replay.response;
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      const result = await deps.repos.tx(async (tx) =>
        runReplaceTransaction({
          tx,
          placeId: input.placeId,
          glyphs,
          sections,
          stage,
          bounds,
          predictedChecksum,
          diff,
          issues,
          clock: deps.clock,
          actorHumanId: input.actorHumanId,
        }),
      );

      await deps.streaming.publishPlaceLayoutReplaced({
        placeId: input.placeId,
        checksum: result.checksum,
      });

      // Best-effort: clean up stale raw CSVs from previous uploads,
      // keeping only the one just consumed.
      await reclaimStaleRawCsvStorage({
        placeId: input.placeId,
        currentUploadRef: input.upload.ref,
        repos: deps.repos,
        storage: deps.storage,
        logger: scopedLogger,
        reportError: deps.reportError,
      });

      await deps.idempotency.commit<StoredReplacePlaceLayoutRecord>(
        idempotencyKey,
        {
          payloadHash,
          response: result,
        },
      );

      return result;
    } catch (error) {
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("replace_place_layout", error);
    }
  };

  if (scopedLogger) {
    return scopedLogger.withTime("replacePlaceLayout", execute);
  }

  return execute();
}

async function runReplaceTransaction(params: {
  tx: TxRepos;
  placeId: string;
  glyphs: SeatGlyph[];
  sections: SeatSection[];
  stage: StageLayout | null;
  bounds: SeatIndexBounds;
  predictedChecksum: string;
  diff: PlaceLayoutDiff;
  issues: PlaceLayoutParserIssue[];
  clock: ClockPort;
  actorHumanId: string;
}): Promise<ReplacePlaceLayoutOutput> {
  const {
    tx,
    placeId,
    glyphs,
    sections,
    stage,
    bounds,
    predictedChecksum,
    diff,
    issues,
    clock,
    actorHumanId,
  } = params;

  const { checksum } = await tx.placeLayoutBlobs.putForPlace({
    placeId,
    glyphs,
    checksumHint: predictedChecksum,
  });

  await tx.placeLayouts.replaceWithSnapshot({
    placeId,
    checksum,
    createdByHumanId: actorHumanId,
    sections,
    seatIds: glyphs.map((glyph) => glyph.seatId),
    seatIndexBounds: bounds,
    stage,
  });

  await tx.placeLayoutStatuses.upsertStatuses({
    placeId,
    seatIds: glyphs.map((glyph) => glyph.seatId),
  });

  const now = clock.now();
  await tx.audit.log({
    entity: "placeLayout",
    entityId: placeId,
    action: "placeLayout.replaced",
    data: {
      checksum,
      seatCount: glyphs.length,
      sectionCount: sections.length,
      actorHumanId,
      issues,
      diff,
    },
    at: now,
  });

  return {
    checksum,
    diff,
    issues,
    seatCount: glyphs.length,
    sectionCount: sections.length,
    seatIndexBounds: bounds,
  } satisfies ReplacePlaceLayoutOutput;
}

function buildIdempotencyKey(placeId: string, key: string): string {
  return `placeLayout.replace:${placeId}:${key}`;
}

function buildPayloadHash(
  input: ReplacePlaceLayoutInput,
  parsed: PlaceLayoutGeometryParserResult,
  checksum: string,
): string {
  const hash = createHash("sha256");
  hash.update(input.placeId);
  hash.update(input.upload.ref);
  hash.update(input.upload.format);
  hash.update(input.upload.source);
  hash.update(checksum);

  const glyphs = [...parsed.glyphs].sort((a, b) =>
    a.seatId.localeCompare(b.seatId),
  );
  for (const glyph of glyphs) {
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

  const sections = [...parsed.sections].sort((a, b) =>
    a.sectionId.localeCompare(b.sectionId),
  );
  for (const section of sections) {
    hash.update(section.sectionId);
    hash.update(section.label);
    hash.update(String(section.capacity));
    if (section.color) hash.update(section.color);
    if (section.metadata) hash.update(JSON.stringify(section.metadata));
    if (section.geometry) hash.update(JSON.stringify(section.geometry));
  }

  if (parsed.stage) {
    hash.update(parsed.stage.kind);
    if (parsed.stage.label) {
      hash.update(parsed.stage.label);
    }
    hash.update(JSON.stringify(parsed.stage.bounds));
    if (parsed.stage.metadata) {
      hash.update(JSON.stringify(parsed.stage.metadata));
    }
  }

  return hash.digest("hex");
}

function calculateGeometryChecksum(glyphs: SeatGlyph[]): string {
  const hash = createHash("sha256");
  const sorted = [...glyphs].sort((a, b) => a.seatId.localeCompare(b.seatId));
  for (const glyph of sorted) {
    hash.update(glyph.seatId);
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
}

function computeSeatIndexBounds(glyphs: SeatGlyph[]): SeatIndexBounds {
  const xs = glyphs.map((glyph) => glyph.position.x);
  const ys = glyphs.map((glyph) => glyph.position.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

type ExistingPlaceLayoutSummary = {
  seatIds: string[];
  sections: SeatSection[];
  checksum: string;
} | null;

function computeDiff(
  existing: ExistingPlaceLayoutSummary,
  seatIds: string[],
  sections: SeatSection[],
): PlaceLayoutDiff {
  const previousSeats = existing?.seatIds ?? [];
  const previousSections = existing?.sections ?? [];

  const prevSeatSet = new Set(previousSeats);
  const nextSeatSet = new Set(seatIds);

  const added = seatIds.filter((id) => !prevSeatSet.has(id)).length;
  const removed = previousSeats.filter((id) => !nextSeatSet.has(id)).length;

  const prevSectionSet = new Set(
    previousSections.map((section) => section.sectionId),
  );
  const nextSectionSet = new Set(sections.map((section) => section.sectionId));

  const sectionsChanged: string[] = [];
  for (const sectionId of nextSectionSet) {
    if (!prevSectionSet.has(sectionId)) {
      sectionsChanged.push(sectionId);
    }
  }
  for (const sectionId of prevSectionSet) {
    if (!nextSectionSet.has(sectionId)) {
      sectionsChanged.push(sectionId);
    }
  }

  return {
    added,
    removed,
    moved: 0,
    sectionsChanged,
  } satisfies PlaceLayoutDiff;
}

function collectFatalIssues(
  parsed: PlaceLayoutGeometryParserResult,
): PlaceLayoutParserIssue[] {
  const errors: PlaceLayoutParserIssue[] = [];
  if (parsed.errors) {
    errors.push(...parsed.errors);
  }
  for (const issue of parsed.issues) {
    if (issue.severity === "error") {
      errors.push(issue);
    }
  }
  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stale raw CSV cleanup
// ─────────────────────────────────────────────────────────────────────────────

const RAW_CSV_PREFIX = (placeId: string) => `place-layouts/raw/${placeId}/`;

// Mirrors the key built in request-place-layout-upload.ts:
// `place-layouts/raw/${placeId}/${randomUUID()}.csv`. The strict UUID tail
// also rules out `..`, extra `/` segments and any other key in the bucket.
const RAW_CSV_TAIL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.csv$/i;

function isOwnRawCsvRef(placeId: string, ref: string): boolean {
  const prefix = RAW_CSV_PREFIX(placeId);
  if (!ref.startsWith(prefix)) return false;
  return RAW_CSV_TAIL.test(ref.slice(prefix.length));
}

async function reclaimStaleRawCsvStorage(params: {
  placeId: string;
  currentUploadRef: string;
  repos: Repos;
  storage?: Pick<FileStoragePort, "listObjects" | "deleteObject">;
  logger?: LoggerPort;
  reportError?: ReporterPort;
}): Promise<void> {
  const { placeId, currentUploadRef, repos, storage, logger, reportError } = params;
  if (!storage) return;

  try {
    const place = await repos.places.getById(placeId);
    const orgId = place?.orgIdsWithAccess[0];

    const prefix = RAW_CSV_PREFIX(placeId);
    let cursor: string | undefined;
    let reclaimedBytes = 0n;

    do {
      const page = await storage.listObjects({ prefix, cursor, limit: 100 });
      for (const obj of page.keys) {
        // Keep the CSV that was just consumed by this replace.
        if (obj.key === currentUploadRef) continue;
        try {
          await storage.deleteObject({ key: obj.key });
          if (obj.size) {
            reclaimedBytes += BigInt(obj.size);
          }
        } catch {
          // best-effort per-object cleanup
        }
      }
      cursor = page.nextCursor;
    } while (cursor);

    if (reclaimedBytes > 0n && orgId) {
      await incrementResourceUsage(repos as any, {
        subjectType: "ORG",
        subjectId: orgId,
        kind: "STORAGE_BYTES_ORG",
        delta: -reclaimedBytes,
      });
    }
  } catch (err) {
    logger?.warn("replace_place_layout_csv_cleanup_failed", {
      placeId,
      error: describeError(err),
    });
    try {
      reportError?.(err, {
        tags: { useCase: "replacePlaceLayout", site: "csv_cleanup" },
        extra: { placeId },
      });
    } catch {
      // Reporting must never change behaviour.
    }
  }
}

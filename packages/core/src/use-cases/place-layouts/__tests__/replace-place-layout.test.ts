import { describe, expect, it, vi } from "vitest";

import { replacePlaceLayout } from "../replace-place-layout";
import type { ReplacePlaceLayoutDeps } from "../replace-place-layout";
import type { TxRepos } from "@th/ports/repos";
import { createTestLogger } from "@th/test-utils/fakes/logger";

const BASE_DATE = new Date("2024-01-01T00:00:00.000Z");
const PLACE_ID = "15324f4d-ec0e-46d5-9ae3-27f1150cf802";
const OTHER_PLACE_ID = "0f6e7c1a-3b2d-4c5e-8f9a-1b2c3d4e5f60";
// Shape minted by requestPlaceLayoutUpload for PLACE_ID.
const UPLOAD_REF = `place-layouts/raw/${PLACE_ID}/7c9e6679-7425-40de-944b-e07fc1f90ae7.csv`;

function buildDeps(
  overrides: Partial<ReplacePlaceLayoutDeps> = {},
): ReplacePlaceLayoutDeps {
  const placeLayoutsRepo = {
    getByPlace: vi.fn(async () => null),
    replaceWithSnapshot: vi.fn(async () => ({
      placeId: "place-1",
      checksum: "new-checksum",
      seatCount: 2,
      sectionCount: 1,
      seatIndexBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
      sections: [
        {
          sectionId: "section-1",
          label: "Floor",
          capacity: 2,
          metadata: {},
        },
      ],
      stage: null,
      updatedAt: BASE_DATE,
      seatIds: ["seat-1", "seat-2"],
      createdByHumanId: "human-1",
    })),
  };

  const placeLayoutBlobsRepo = {
    putForPlace: vi.fn(async () => ({ checksum: "new-checksum" })),
  };

  const placeLayoutStatusesRepo = {
    upsertStatuses: vi.fn(async () => undefined),
    deleteByPlace: vi.fn(async () => undefined),
  };

  const auditRepo = {
    log: vi.fn(async () => undefined),
  };

  const resourceQuotasRepo = {
    incrementUsage: vi.fn(async () => undefined),
  };

  const placesRepo = {
    getById: vi.fn(async () => ({
      id: "place-1",
      orgIdsWithAccess: ["org-1"],
    })),
  };

  const txRepos = {
    placeLayouts: placeLayoutsRepo,
    placeLayoutBlobs: placeLayoutBlobsRepo,
    placeLayoutStatuses: placeLayoutStatusesRepo,
    audit: auditRepo,
  } as unknown as TxRepos;

  const repos = {
    placeLayouts: placeLayoutsRepo,
    placeLayoutBlobs: placeLayoutBlobsRepo,
    placeLayoutStatuses: placeLayoutStatusesRepo,
    audit: auditRepo,
    places: placesRepo,
    resourceQuotas: resourceQuotasRepo,
    tx: vi.fn(async (fn: (tx: typeof txRepos) => Promise<any>) => fn(txRepos)),
  } as unknown as ReplacePlaceLayoutDeps["repos"];

  const parser = {
    parse: vi.fn(async () => ({
      glyphs: [
        {
          seatId: "seat-1",
          sectionId: "section-1",
          label: "A1",
          position: { x: 0, y: 0 },
        },
        {
          seatId: "seat-2",
          sectionId: "section-1",
          label: "A2",
          position: { x: 10, y: 10 },
        },
      ],
      sections: [
        {
          sectionId: "section-1",
          label: "Floor",
          capacity: 2,
          metadata: {},
        },
      ],
      issues: [],
      stage: null,
    })),
  };

  const idempotency = {
    get: vi.fn(async () => null),
    begin: vi.fn(async () => true),
    commit: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };

  const streaming = {
    publishPlaceLayoutReplaced: vi.fn(async () => undefined),
  };

  const clock = {
    now: vi.fn(() => BASE_DATE),
  };

  const logger = createTestLogger();

  const authz = {
    canManagePlace: vi.fn(async () => ({ allowed: true })),
  };

  return {
    repos,
    authz: authz as unknown as ReplacePlaceLayoutDeps["authz"],
    parser: parser as unknown as ReplacePlaceLayoutDeps["parser"],
    idempotency:
      idempotency as unknown as ReplacePlaceLayoutDeps["idempotency"],
    streaming: streaming as unknown as ReplacePlaceLayoutDeps["streaming"],
    clock: clock as unknown as ReplacePlaceLayoutDeps["clock"],
    logger,
    placesRepo,
    resourceQuotasRepo,
    ...overrides,
  } satisfies ReplacePlaceLayoutDeps & {
    placesRepo: typeof placesRepo;
    resourceQuotasRepo: typeof resourceQuotasRepo;
  };
}

describe("replacePlaceLayout", () => {
  it("replaces the place layout and commits idempotency", async () => {
    const deps = buildDeps();

    const result = await replacePlaceLayout(deps, {
      placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
      actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
      upload: {
        ref: UPLOAD_REF,
        format: "svg",
        source: "admin_wizard",
      },
      options: {
        idempotencyKey: "key-12345678",
      },
    });

    expect(result.checksum).toBe("new-checksum");
    expect(result.seatCount).toBe(2);
    expect(result.sectionCount).toBe(1);
    expect(result.diff.added).toBeGreaterThanOrEqual(0);

    expect(deps.repos.tx).toHaveBeenCalledTimes(1);
    expect(deps.parser.parse).toHaveBeenCalledTimes(1);
    expect(deps.idempotency.begin).toHaveBeenCalledTimes(1);
    expect(deps.idempotency.commit).toHaveBeenCalledTimes(1);
    expect(deps.streaming.publishPlaceLayoutReplaced).toHaveBeenCalledWith({
      placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
      checksum: "new-checksum",
    });
  });

  it("supports dry-run without mutating state", async () => {
    const deps = buildDeps();

    const result = await replacePlaceLayout(deps, {
      placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
      actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
      upload: {
        ref: UPLOAD_REF,
        format: "svg",
        source: "admin_wizard",
      },
      options: {
        dryRun: true,
      },
    });

    expect(result.seatCount).toBe(2);
    expect(result.sectionCount).toBe(1);
    expect(result.checksum.length).toBe(64);
    expect(deps.repos.tx).not.toHaveBeenCalled();
    expect(deps.idempotency.begin).not.toHaveBeenCalled();
  });

  it("throws invalid_input when parser returns fatal issues", async () => {
    const deps = buildDeps({
      parser: {
        parse: vi.fn(async () => ({
          glyphs: [
            {
              seatId: "seat-1",
              sectionId: "section-1",
              label: "A1",
              position: { x: 0, y: 0 },
            },
          ],
          sections: [
            {
              sectionId: "section-1",
              label: "Floor",
              capacity: 1,
              metadata: {},
            },
          ],
          issues: [
            {
              code: "parser-error",
              message: "Seat missing geometry",
              severity: "error" as const,
            },
          ],
          errors: [],
        })),
      } as unknown as ReplacePlaceLayoutDeps["parser"],
    });

    await expect(
      replacePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        upload: {
          ref: UPLOAD_REF,
          format: "svg",
          source: "admin_wizard",
        },
        options: {
          dryRun: true,
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  describe("stale raw CSV storage reclamation", () => {
    it("deletes stale CSVs but keeps the current upload ref", async () => {
      const storage = {
        listObjects: vi.fn(async () => ({
          keys: [
            { key: "place-layouts/raw/place-1/stale-old.csv", size: 500 },
            { key: UPLOAD_REF, size: 1000 }, // current upload ref — should be kept
            { key: "place-layouts/raw/place-1/stale-other.csv", size: 700 },
          ],
          nextCursor: undefined,
        })),
        deleteObject: vi.fn(async () => undefined),
        headObject: vi.fn(async () => ({ exists: true, size: 1000 })),
      };

      const deps = buildDeps({ storage });

      await replacePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        upload: {
          ref: UPLOAD_REF,
          format: "svg",
          source: "admin_wizard",
        },
        options: {
          idempotencyKey: "key-12345678",
        },
      });

      // Should delete the 2 stale objects, not the current upload ref.
      expect(storage.deleteObject).toHaveBeenCalledTimes(2);
      expect(storage.deleteObject).toHaveBeenCalledWith({
        key: "place-layouts/raw/place-1/stale-old.csv",
      });
      expect(storage.deleteObject).toHaveBeenCalledWith({
        key: "place-layouts/raw/place-1/stale-other.csv",
      });

      expect(deps.resourceQuotasRepo.incrementUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          subjectType: "ORG",
          subjectId: "org-1",
          kind: "STORAGE_BYTES_ORG",
          delta: -1200n,
        }),
      );
    });

    it("skips reclamation when storage dep is not provided", async () => {
      const deps = buildDeps();

      await replacePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        upload: {
          ref: UPLOAD_REF,
          format: "svg",
          source: "admin_wizard",
        },
        options: {
          idempotencyKey: "key-88888888",
        },
      });

      expect(deps.resourceQuotasRepo.incrementUsage).not.toHaveBeenCalled();
    });

    it("gracefully handles storage errors without failing the replace", async () => {
      const storage = {
        listObjects: vi.fn(async () => {
          throw new Error("R2 unavailable");
        }),
        deleteObject: vi.fn(),
        headObject: vi.fn(async () => ({ exists: true, size: 1000 })),
      };

      const deps = buildDeps({ storage });

      const result = await replacePlaceLayout(deps, {
        placeId: "15324f4d-ec0e-46d5-9ae3-27f1150cf802",
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        upload: {
          ref: UPLOAD_REF,
          format: "svg",
          source: "admin_wizard",
        },
        options: {
          idempotencyKey: "key-99999999",
        },
      });

      // The replace itself should still succeed.
      expect(result.checksum).toBe("new-checksum");
    });
  });

  // Security review F2 (2026-09-29): the write was ungated and the upload ref
  // was unbound, so any signed-in user could overwrite any venue's seat map.
  describe("authorization", () => {
    const validInput = (overrides: Record<string, unknown> = {}) => ({
      placeId: PLACE_ID,
      actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
      upload: { ref: UPLOAD_REF, format: "csv", source: "designer" },
      options: { idempotencyKey: "key-authz-1234" },
      ...overrides,
    });

    it("rejects an actor who cannot manage the place, before touching storage", async () => {
      const deps = buildDeps({
        authz: {
          canManagePlace: vi.fn(async () => ({ allowed: false })),
        } as unknown as ReplacePlaceLayoutDeps["authz"],
      });

      await expect(
        replacePlaceLayout(deps, validInput()),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });

      expect(deps.authz.canManagePlace).toHaveBeenCalledWith({
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        placeId: PLACE_ID,
      });
      expect(deps.parser.parse).not.toHaveBeenCalled();
      expect(deps.repos.tx).not.toHaveBeenCalled();
      expect(deps.idempotency.begin).not.toHaveBeenCalled();
    });

    it("rejects dry runs from a non-manager too", async () => {
      const deps = buildDeps({
        authz: {
          canManagePlace: vi.fn(async () => ({ allowed: false })),
        } as unknown as ReplacePlaceLayoutDeps["authz"],
      });

      await expect(
        replacePlaceLayout(deps, validInput({ options: { dryRun: true } })),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(deps.parser.parse).not.toHaveBeenCalled();
    });

    it.each([
      [
        "another place's upload",
        `place-layouts/raw/${OTHER_PLACE_ID}/7c9e6679-7425-40de-944b-e07fc1f90ae7.csv`,
      ],
      ["an arbitrary bucket key", "avatars/some-human/photo.jpg"],
      [
        "a traversal out of the place prefix",
        `place-layouts/raw/${PLACE_ID}/../${OTHER_PLACE_ID}/7c9e6679-7425-40de-944b-e07fc1f90ae7.csv`,
      ],
      ["a non-uuid file under the prefix", `place-layouts/raw/${PLACE_ID}/evil.csv`],
      [
        "a nested path under the prefix",
        `place-layouts/raw/${PLACE_ID}/x/7c9e6679-7425-40de-944b-e07fc1f90ae7.csv`,
      ],
    ])("rejects %s as upload.ref", async (_label, ref) => {
      const deps = buildDeps();

      await expect(
        replacePlaceLayout(
          deps,
          validInput({ upload: { ref, format: "csv", source: "designer" } }),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
      expect(deps.parser.parse).not.toHaveBeenCalled();
      expect(deps.repos.tx).not.toHaveBeenCalled();
    });

    it("lets a manager apply their own place's upload", async () => {
      const deps = buildDeps();

      const result = await replacePlaceLayout(deps, validInput());

      expect(result.checksum).toBe("new-checksum");
      expect(deps.parser.parse).toHaveBeenCalledWith(
        expect.objectContaining({ placeId: PLACE_ID, uploadRef: UPLOAD_REF }),
      );
    });
  });

  // CLAUDE.md error-reporting convention: the best-effort CSV cleanup swallows,
  // so it must report.
  describe("reportError on the swallowed CSV cleanup", () => {
    it("reports the cleanup failure and still succeeds", async () => {
      const reportError = vi.fn();
      const boom = new Error("R2 unavailable");
      const deps = buildDeps({
        storage: {
          listObjects: vi.fn(async () => {
            throw boom;
          }),
          deleteObject: vi.fn(),
          headObject: vi.fn(async () => ({ exists: true, size: 1000 })),
        },
        reportError,
      });

      const result = await replacePlaceLayout(deps, {
        placeId: PLACE_ID,
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        upload: { ref: UPLOAD_REF, format: "csv", source: "designer" },
        options: { idempotencyKey: "key-report-1234" },
      });

      expect(result.checksum).toBe("new-checksum");
      expect(reportError).toHaveBeenCalledWith(
        boom,
        expect.objectContaining({
          tags: { useCase: "replacePlaceLayout", site: "csv_cleanup" },
        }),
      );
    });

    it("a throwing reporter does not fail the operation", async () => {
      const deps = buildDeps({
        storage: {
          listObjects: vi.fn(async () => {
            throw new Error("R2 unavailable");
          }),
          deleteObject: vi.fn(),
          headObject: vi.fn(async () => ({ exists: true, size: 1000 })),
        },
        reportError: vi.fn(() => {
          throw new Error("reporter down");
        }),
      });

      const result = await replacePlaceLayout(deps, {
        placeId: PLACE_ID,
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        upload: { ref: UPLOAD_REF, format: "csv", source: "designer" },
        options: { idempotencyKey: "key-report-1234" },
      });
      expect(result.checksum).toBe("new-checksum");
    });
  });

  // F11 (2026-09-29): the raw CSV is HEADed before the parser fetches it.
  describe("raw CSV size gate", () => {
    const run = (deps: ReturnType<typeof buildDeps>) =>
      replacePlaceLayout(deps, {
        placeId: PLACE_ID,
        actorHumanId: "d5a53346-56ea-4803-b13c-7f2367514b6d",
        upload: { ref: UPLOAD_REF, format: "svg", source: "admin_wizard" },
        options: { idempotencyKey: "key-size-gate" },
      });

    it("deletes and refuses a CSV bigger than its presign declaration", async () => {
      const storage = {
        listObjects: vi.fn(async () => ({ keys: [], nextCursor: undefined })),
        deleteObject: vi.fn(async () => undefined),
        headObject: vi.fn(async () => ({
          exists: true,
          size: 4096,
          metadata: { "th-declared-bytes": "10" },
        })),
      };
      const deps = buildDeps({ storage });

      await expect(run(deps)).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "upload_size_exceeded",
      });
      expect(storage.deleteObject).toHaveBeenCalledWith({ key: UPLOAD_REF });
      expect(deps.parser.parse).not.toHaveBeenCalled();
    });

    it("deletes and refuses a CSV over the 5 MiB cap", async () => {
      const storage = {
        listObjects: vi.fn(async () => ({ keys: [], nextCursor: undefined })),
        deleteObject: vi.fn(async () => undefined),
        headObject: vi.fn(async () => ({
          exists: true,
          size: 5 * 1024 * 1024 + 1,
        })),
      };
      const deps = buildDeps({ storage });

      await expect(run(deps)).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(deps.parser.parse).not.toHaveBeenCalled();
    });

    it("refuses a CSV that was never uploaded", async () => {
      const storage = {
        listObjects: vi.fn(async () => ({ keys: [], nextCursor: undefined })),
        deleteObject: vi.fn(async () => undefined),
        headObject: vi.fn(async () => ({ exists: false })),
      };
      const deps = buildDeps({ storage });

      await expect(run(deps)).rejects.toMatchObject({
        code: "UPLOAD_NOT_COMPLETE",
      });
      expect(deps.parser.parse).not.toHaveBeenCalled();
    });

    it("parses a CSV matching its declaration", async () => {
      const storage = {
        listObjects: vi.fn(async () => ({ keys: [], nextCursor: undefined })),
        deleteObject: vi.fn(async () => undefined),
        headObject: vi.fn(async () => ({
          exists: true,
          size: 4096,
          metadata: { "th-declared-bytes": "4096" },
        })),
      };
      const deps = buildDeps({ storage });

      const result = await run(deps);
      expect(result.checksum).toBe("new-checksum");
      expect(deps.parser.parse).toHaveBeenCalledTimes(1);
      expect(storage.deleteObject).not.toHaveBeenCalledWith({
        key: UPLOAD_REF,
      });
    });
  });
});

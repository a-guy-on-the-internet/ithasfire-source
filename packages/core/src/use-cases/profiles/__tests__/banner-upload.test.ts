import { describe, expect, it, vi } from "vitest";

import { uploadRequestId } from "../../storage/publish-stripped-upload";
import { makeOutbox } from "../../storage/__tests__/unrowed-upload-fakes";

import type { FileStoragePort } from "@th/ports/file-storage";
import type { ClockPort } from "@th/ports/clock";
import type { EntityPagesRepo } from "@th/ports/repos/entity-pages";
import type { Repos, TxRepos } from "@th/ports/repos";

import { requestBannerUpload, setBannerFromUpload } from "../index";

function makeClock(now: Date): ClockPort {
  return {
    now: () => now,
  };
}

describe("profile banner upload", () => {
  it("requestBannerUpload returns uploadUrl + key", async () => {
    const storage: Pick<FileStoragePort, "presignPutObject"> = {
      presignPutObject: vi.fn(async () => ({
        uploadUrl: "https://r2.example/upload",
      })),
    } as any;

    const outbox = makeOutbox();
    const repos = {
      resourceQuotas: {
        getEffectiveQuota: vi.fn(async () => ({
          kind: "STORAGE_BYTES_HUMAN" as const,
          limitValue: BigInt(512 * 1024 * 1024),
          currentUsage: 0n,
          isOverride: false,
        })),
        hasPendingExpansionRequest: vi.fn(async () => false),
        incrementUsage: vi.fn(async () => ({ currentUsage: 1234n })),
      },
      pendingObjectDeletions: Object.assign(outbox.repo, { rows: outbox.rows }),
    } as any;

    const out = await requestBannerUpload(
      {
        storage: storage as FileStoragePort,
        clock: makeClock(new Date("2025-01-01T12:00:00.000Z")),
        repos,
      },
      {
        actorHumanId: "00000000-0000-4000-8000-000000000000",
        contentType: "image/png",
        sizeBytes: 1234,
      },
    );

    expect(out.key).toContain(
      "banners/human/00000000-0000-4000-8000-000000000000/",
    );
    expect(out.uploadUrl).toBe("https://r2.example/upload");
    expect(out).not.toHaveProperty("publicUrl");
    // Who asked, and the upload's deletion once its URL has expired
    // (15 min + the 15 min margin), so an upload never finalized does not
    // stay public with its metadata.
    expect(repos.pendingObjectDeletions.rows.get(uploadRequestId(out.key))).toMatchObject({
      targetKey: out.key,
      targetKind: "KEY",
      source: "banner_upload_request",
      sourceId: "00000000-0000-4000-8000-000000000000",
      nextAttemptAt: new Date("2025-01-01T12:30:00.000Z"),
    });
  });

  it("setBannerFromUpload enforces key ownership", async () => {
    const repos: Repos = {
      tx: vi.fn(async (fn: (tx: TxRepos) => any) =>
        fn({
          entityPages: {
            getByOwner: vi.fn(async () => null),
            upsert: vi.fn(async (input) => ({ ...input })),
          } as unknown as EntityPagesRepo,
        } as unknown as TxRepos),
      ),
      entityPages: {} as any,
      humans: {} as any,
    } as any;

    const storage: Pick<
      FileStoragePort,
      "headObject" | "getObjectUrl" | "deleteObject"
    > = {
      headObject: vi.fn(async () => ({ exists: true, size: 1024 })),
      getObjectUrl: vi.fn(async () => ({
        url: "https://cdn.example/banners/human/x.png",
      })),
      deleteObject: vi.fn(async () => undefined),
    } as any;

    await expect(
      setBannerFromUpload(
        { repos, storage: storage as FileStoragePort },
        {
          actorHumanId: "00000000-0000-4000-8000-000000000000",
          key: "banners/human/someone-else/abc.png",
        },
      ),
    ).rejects.toMatchObject({ code: "BANNER_KEY_NOT_OWNED" });
  });
});

import { describe, expect, it, vi } from "vitest";

import { uploadRequestId } from "../../storage/publish-stripped-upload";
import { makeOutbox } from "../../storage/__tests__/unrowed-upload-fakes";

import type { FileStoragePort } from "@th/ports/file-storage";
import type { ClockPort } from "@th/ports/clock";
import type { EntityPagesRepo } from "@th/ports/repos/entity-pages";
import type { Repos, TxRepos } from "@th/ports/repos";

import {
  getMyProfile,
  requestAvatarUpload,
  setAvatarFromUpload,
} from "../index";

function makeClock(now: Date): ClockPort {
  return { now: () => now };
}

describe("account avatar upload", () => {
  it("requestAvatarUpload returns uploadUrl + key", async () => {
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

    const out = await requestAvatarUpload(
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
      "avatars/human/00000000-0000-4000-8000-000000000000/",
    );
    expect(out.uploadUrl).toBe("https://r2.example/upload");
    expect(out).not.toHaveProperty("publicUrl");
    // Who asked, and the upload's deletion once its URL has expired
    // (15 min + the 15 min margin), so an upload never finalized does not
    // stay public with its metadata.
    expect(repos.pendingObjectDeletions.rows.get(uploadRequestId(out.key))).toMatchObject({
      targetKey: out.key,
      targetKind: "KEY",
      source: "avatar_upload_request",
      sourceId: "00000000-0000-4000-8000-000000000000",
      nextAttemptAt: new Date("2025-01-01T12:30:00.000Z"),
    });
  });

  it("setAvatarFromUpload enforces key ownership", async () => {
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
        url: "https://cdn.example/avatars/human/x.png",
      })),
      deleteObject: vi.fn(async () => undefined),
    } as any;

    await expect(
      setAvatarFromUpload(
        { repos, storage: storage as FileStoragePort },
        {
          actorHumanId: "00000000-0000-4000-8000-000000000000",
          key: "avatars/human/someone-else/abc.png",
        },
      ),
    ).rejects.toMatchObject({ code: "AVATAR_KEY_NOT_OWNED" });
  });

  it("getMyProfile returns profile avatarUrl", async () => {
    const repos = {
      entityPages: {
        getByOwner: vi.fn(async () => ({
          id: "page-1",
          ownerType: "HUMAN" as const,
          ownerId: "00000000-0000-4000-8000-000000000000",
          slug: "me",
          displayName: "Me",
          bio: null,
          avatarUrl: "https://cdn.example/a.png",
          bannerUrl: null,
          visibility: "PUBLIC" as const,
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
      },
      humans: {} as any,
    } as any;

    const out = await getMyProfile(
      { repos },
      { actorHumanId: "00000000-0000-4000-8000-000000000000" },
    );

    expect(out.avatarUrl).toBe("https://cdn.example/a.png");
  });
});

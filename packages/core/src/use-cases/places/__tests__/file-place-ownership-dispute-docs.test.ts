import { describe, expect, it, vi } from "vitest";

import {
  filePlaceOwnershipDispute,
  type FilePlaceOwnershipDisputeDeps,
} from "../file-place-ownership-dispute";

// F11 (2026-09-29): dispute documents are HEADed (key prefix, existence,
// size) before the dispute request is written. The quota was charged from
// the presign declaration, so an oversize object is deleted and refused.

const ACTOR = "61000000-0000-4000-8000-000000000001";
const PLACE = "61000000-0000-4000-8000-000000000002";
const KEY = `place-verification/${PLACE}/deed.pdf`;

function buildDeps(head: { exists: boolean; size?: number }) {
  const tx = vi.fn();
  const storage = {
    headObject: vi.fn(async () => head),
    deleteObject: vi.fn(async () => ({ ok: true as const })),
  };
  const deps = {
    repos: {
      tx,
      places: {
        getById: vi.fn(async () => ({
          id: PLACE,
          verificationStatus: "VERIFIED",
        })),
        getVerifiedOwnershipForPlace: vi.fn(async () => null),
      },
    },
    authz: { hasOrgRole: vi.fn() },
    clock: { now: () => new Date("2026-09-29T00:00:00.000Z") },
    storage,
  } as unknown as FilePlaceOwnershipDisputeDeps;
  return { deps, tx, storage };
}

const input = (sizeBytes: number, storageKey = KEY) => ({
  actorHumanId: ACTOR,
  placeId: PLACE,
  owner: { kind: "human" as const, humanId: ACTOR },
  reason: "I own the deed for this building.",
  documents: [
    {
      storageKey,
      fileName: "deed.pdf",
      contentType: "application/pdf" as const,
      sizeBytes,
    },
  ],
});

describe("filePlaceOwnershipDispute document checks", () => {
  it("rejects, without deleting, a document over only its re-stated size", async () => {
    const { deps, tx, storage } = buildDeps({ exists: true, size: 9_000 });

    await expect(
      filePlaceOwnershipDispute(deps, input(1_000)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });

  it("deletes and rejects a document over the cap, before any write", async () => {
    const { deps, tx, storage } = buildDeps({
      exists: true,
      size: 10 * 1024 * 1024 + 1,
    });

    await expect(
      filePlaceOwnershipDispute(deps, input(1_000)),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "upload_size_exceeded",
    });
    expect(storage.deleteObject).toHaveBeenCalledWith({ key: KEY });
    expect(tx).not.toHaveBeenCalled();
  });

  it("rejects a key outside this place's upload prefix", async () => {
    const { deps, tx, storage } = buildDeps({ exists: true, size: 10 });

    await expect(
      filePlaceOwnershipDispute(
        deps,
        input(1_000, "place-verification/another-place/deed.pdf"),
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: "document_key_not_owned",
    });
    expect(storage.headObject).not.toHaveBeenCalled();
    expect(tx).not.toHaveBeenCalled();
  });

  it("passes the size gate for a document matching its declaration", async () => {
    const { deps, tx, storage } = buildDeps({ exists: true, size: 1_000 });
    tx.mockResolvedValue("req-1");

    // The tx itself is stubbed; reaching it proves the checks passed.
    await filePlaceOwnershipDispute(deps, input(1_000)).catch(() => undefined);
    expect(storage.headObject).toHaveBeenCalledWith({ key: KEY });
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(tx).toHaveBeenCalledTimes(1);
  });
});

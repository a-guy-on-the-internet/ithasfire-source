import { describe, expect, it, vi } from "vitest";

import { CsvPlaceLayoutParser } from "../csv-place-layout-parser";
import type { FileStoragePort } from "@th/ports/file-storage";

// ── Helpers ──────────────────────────────────────────────────────────────

function buildStorage(csvContent: string): FileStoragePort {
  const signedUrl = "https://storage.example.com/signed/test.csv";

  // Mock global fetch to return the CSV content
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === signedUrl) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => csvContent,
        };
      }
      return { ok: false, status: 404, headers: { get: () => null } };
    }),
  );

  return {
    getObjectUrl: vi.fn(async () => ({ url: signedUrl })),
    putObject: vi.fn(),
    deleteObject: vi.fn(),
    headObject: vi.fn(),
    listObjects: vi.fn(),
    presignPutObject: vi.fn(),
    moveObject: vi.fn(),
  } as unknown as FileStoragePort;
}

const VALID_CSV = [
  "section,row,seat,x,y,rotation,width,height,tier,notes",
  "Floor,A,1,10,20,0,,,general,",
  "Floor,A,2,15,20,0,,,general,",
].join("\n");

// ── Tests ────────────────────────────────────────────────────────────────

describe("CsvPlaceLayoutParser", () => {
  it("fetches CSV from storage and parses it", async () => {
    const storage = buildStorage(VALID_CSV);
    const parser = new CsvPlaceLayoutParser({ storage });

    const result = await parser.parse({
      placeId: "place-1",
      uploadRef: "place-layouts/raw/place-1/upload-123.csv",
      format: "csv",
      source: "admin_wizard",
    });

    expect(result.glyphs).toHaveLength(2);
    expect(result.sections).toHaveLength(1);
    expect(result.issues.filter((i) => i.severity === "error")).toHaveLength(0);

    expect(storage.getObjectUrl).toHaveBeenCalledWith({
      key: "place-layouts/raw/place-1/upload-123.csv",
      options: { expiresSec: 300 },
    });
  });

  it("returns error issue for unsupported formats", async () => {
    const storage = buildStorage(VALID_CSV);
    const parser = new CsvPlaceLayoutParser({ storage });

    const result = await parser.parse({
      placeId: "place-1",
      uploadRef: "some-ref",
      format: "svg",
      source: "admin_wizard",
    });

    expect(result.glyphs).toHaveLength(0);
    expect(result.issues[0]!.code).toBe("unsupported_format");
    expect(result.issues[0]!.severity).toBe("error");

    // Should not have tried to fetch
    expect(storage.getObjectUrl).not.toHaveBeenCalled();
  });

  it("throws when storage fetch fails", async () => {
    const signedUrl = "https://storage.example.com/signed/missing.csv";

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );

    const storage = {
      getObjectUrl: vi.fn(async () => ({ url: signedUrl })),
    } as unknown as FileStoragePort;

    const parser = new CsvPlaceLayoutParser({ storage });

    await expect(
      parser.parse({
        placeId: "place-1",
        uploadRef: "missing-ref",
        format: "csv",
        source: "api",
      }),
    ).rejects.toThrow("Failed to fetch CSV from storage");
  });

  it("forwards parser options to the underlying parser", async () => {
    // Build a CSV with more than 2 rows
    const bigCsv = [
      "section,row,seat,x,y,rotation,width,height,tier,notes",
      "Floor,A,1,0,0,,,,,",
      "Floor,A,2,5,0,,,,,",
      "Floor,A,3,10,0,,,,,",
      "Floor,A,4,15,0,,,,,",
      "Floor,A,5,20,0,,,,,",
    ].join("\n");

    const storage = buildStorage(bigCsv);
    const parser = new CsvPlaceLayoutParser({
      storage,
      parserOptions: { maxSeats: 3 },
    });

    const result = await parser.parse({
      placeId: "place-1",
      uploadRef: "ref",
      format: "csv",
      source: "admin_wizard",
    });

    expect(result.glyphs).toHaveLength(3);
    expect(
      result.issues.find((i) => i.code === "max_seats_exceeded"),
    ).toBeTruthy();
  });
});

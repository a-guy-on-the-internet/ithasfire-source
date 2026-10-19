import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";

import {
  deriveHlsPrefix,
  eventStorageQuotaSubject,
  collectEventAudioDeletionTargets,
  collectEventMediaDeletionTargets,
} from "../event-media-targets";

const EVENT_ID = "evt-1";
const SOURCE_KEY = "uploads/audio/aud-1.mp3";
const HLS_PLAYLIST_KEY = `events/${EVENT_ID}/audio/aud-1/audio.m3u8`;
const HLS_PREFIX = `events/${EVENT_ID}/audio/aud-1/`;

function audioRepo(rows: unknown[]) {
  return {
    listByEventIdIncludingDeleted: vi.fn(async () => rows),
  } as unknown as Pick<TxRepos, "audioUploads">["audioUploads"];
}

function imagesRepo(rows: unknown[]) {
  return {
    listByEventId: vi.fn(async () => rows),
  } as unknown as Pick<TxRepos, "images">["images"];
}

describe("deriveHlsPrefix", () => {
  it("strips the playlist filename and keeps a trailing slash", () => {
    expect(deriveHlsPrefix(HLS_PLAYLIST_KEY)).toBe(HLS_PREFIX);
  });

  it("returns null when there is no parent folder", () => {
    expect(deriveHlsPrefix("audio.m3u8")).toBeNull();
    expect(deriveHlsPrefix("/audio.m3u8")).toBeNull();
  });
});

describe("collectEventAudioDeletionTargets", () => {
  it("collects source key as KEY, HLS folder as PREFIX, and row ids", async () => {
    const repos = {
      audioUploads: audioRepo([
        { id: "aud-1", sourceKey: SOURCE_KEY, hlsPlaylistKey: HLS_PLAYLIST_KEY },
      ]),
    };

    const result = await collectEventAudioDeletionTargets(repos, EVENT_ID);

    expect(result.exactKeys).toEqual([SOURCE_KEY]);
    expect(result.prefixes).toEqual([HLS_PREFIX]);
    expect(result.audioUploadIds).toEqual(["aud-1"]);
  });

  it("emits only the source KEY when hlsPlaylistKey is null", async () => {
    const repos = {
      audioUploads: audioRepo([
        { id: "aud-1", sourceKey: SOURCE_KEY, hlsPlaylistKey: null },
      ]),
    };

    const result = await collectEventAudioDeletionTargets(repos, EVENT_ID);

    expect(result.exactKeys).toEqual([SOURCE_KEY]);
    expect(result.prefixes).toEqual([]);
    expect(result.audioUploadIds).toEqual(["aud-1"]);
  });

  it("falls back to deleting the playlist key directly when no parent folder", async () => {
    const repos = {
      audioUploads: audioRepo([
        { id: "aud-1", sourceKey: SOURCE_KEY, hlsPlaylistKey: "audio.m3u8" },
      ]),
    };

    const result = await collectEventAudioDeletionTargets(repos, EVENT_ID);

    expect(result.exactKeys).toEqual([SOURCE_KEY, "audio.m3u8"]);
    expect(result.prefixes).toEqual([]);
  });

  it("includes already-soft-deleted audio rows", async () => {
    const repos = {
      audioUploads: audioRepo([
        {
          id: "aud-soft",
          sourceKey: SOURCE_KEY,
          hlsPlaylistKey: HLS_PLAYLIST_KEY,
          deletedAt: new Date("2024-01-01T00:00:00.000Z"),
        },
      ]),
    };

    const result = await collectEventAudioDeletionTargets(repos, EVENT_ID);

    expect(result.audioUploadIds).toEqual(["aud-soft"]);
    expect(result.exactKeys).toEqual([SOURCE_KEY]);
    expect(result.prefixes).toEqual([HLS_PREFIX]);
  });

  it("returns empty target sets when there is no audio", async () => {
    const repos = { audioUploads: audioRepo([]) };

    const result = await collectEventAudioDeletionTargets(repos, EVENT_ID);

    expect(result).toEqual({
      exactKeys: [],
      prefixes: [],
      audioUploadIds: [],
      audioBytes: 0n,
    });
  });

  it("sums sourceSizeBytes across uploads (null treated as 0n)", async () => {
    const repos = {
      audioUploads: audioRepo([
        { id: "aud-1", sourceKey: "a.mp3", hlsPlaylistKey: null, sourceSizeBytes: 1000n },
        { id: "aud-2", sourceKey: "b.mp3", hlsPlaylistKey: null, sourceSizeBytes: null },
        { id: "aud-3", sourceKey: "c.mp3", hlsPlaylistKey: null, sourceSizeBytes: 500n },
      ]),
    };

    const result = await collectEventAudioDeletionTargets(repos, EVENT_ID);

    expect(result.audioBytes).toBe(1500n);
  });

  it("EXCLUDES soft-deleted rows from audioBytes but KEEPS them in targets/ids", async () => {
    const repos = {
      audioUploads: audioRepo([
        {
          id: "aud-live",
          sourceKey: "live.mp3",
          hlsPlaylistKey: null,
          sourceSizeBytes: 1000n,
          deletedAt: null,
        },
        {
          id: "aud-soft",
          sourceKey: "soft.mp3",
          hlsPlaylistKey: null,
          sourceSizeBytes: 9999n, // already credited by the sweep — must NOT recount
          deletedAt: new Date("2024-01-01T00:00:00.000Z"),
        },
      ]),
    };

    const result = await collectEventAudioDeletionTargets(repos, EVENT_ID);

    // Bytes: live-only (excludes the soft-deleted row to avoid double-credit).
    expect(result.audioBytes).toBe(1000n);
    // Coverage: enqueue targets + ids still span BOTH rows.
    expect(result.audioUploadIds).toEqual(["aud-live", "aud-soft"]);
    expect(result.exactKeys).toEqual(["live.mp3", "soft.mp3"]);
  });
});

describe("eventStorageQuotaSubject", () => {
  it("resolves ORG when orgId is set", () => {
    expect(
      eventStorageQuotaSubject({ orgId: "org-1", humanId: "h-1" }),
    ).toEqual({
      subjectType: "ORG",
      subjectId: "org-1",
      kind: "STORAGE_BYTES_ORG",
    });
  });

  it("resolves HUMAN when only humanId is set", () => {
    expect(
      eventStorageQuotaSubject({ orgId: null, humanId: "h-1" }),
    ).toEqual({
      subjectType: "HUMAN",
      subjectId: "h-1",
      kind: "STORAGE_BYTES_HUMAN",
    });
  });

  it("returns null when neither owner is set", () => {
    expect(
      eventStorageQuotaSubject({ orgId: null, humanId: null }),
    ).toBeNull();
  });
});

describe("collectEventMediaDeletionTargets", () => {
  it("merges audio (KEY + PREFIX) and image (KEY) targets", async () => {
    const repos = {
      audioUploads: audioRepo([
        { id: "aud-1", sourceKey: SOURCE_KEY, hlsPlaylistKey: HLS_PLAYLIST_KEY },
      ]),
      images: imagesRepo([
        { key: `events/${EVENT_ID}/images/img-1.jpg` },
        { key: `events/${EVENT_ID}/images/img-2.png` },
      ]),
    };

    const result = await collectEventMediaDeletionTargets(repos, EVENT_ID);

    expect(result.exactKeys).toEqual([
      SOURCE_KEY,
      `events/${EVENT_ID}/images/img-1.jpg`,
      `events/${EVENT_ID}/images/img-2.png`,
    ]);
    expect(result.prefixes).toEqual([HLS_PREFIX]);
  });

  it("sums audioBytes and imageBytes separately (null treated as 0n)", async () => {
    const repos = {
      audioUploads: audioRepo([
        {
          id: "aud-1",
          sourceKey: SOURCE_KEY,
          hlsPlaylistKey: null,
          sourceSizeBytes: 2000n,
        },
      ]),
      images: imagesRepo([
        { key: "img-1.jpg", sizeBytes: 300n },
        { key: "img-2.png", sizeBytes: null },
        { key: "img-3.gif", sizeBytes: 700n },
      ]),
    };

    const result = await collectEventMediaDeletionTargets(repos, EVENT_ID);

    expect(result.audioBytes).toBe(2000n);
    expect(result.imageBytes).toBe(1000n);
  });

  it("EXCLUDES soft-deleted audio + images from bytes but KEEPS them as enqueue targets", async () => {
    const repos = {
      audioUploads: audioRepo([
        {
          id: "aud-live",
          sourceKey: "audio-live.mp3",
          hlsPlaylistKey: null,
          sourceSizeBytes: 2000n,
          deletedAt: null,
        },
        {
          id: "aud-soft",
          sourceKey: "audio-soft.mp3",
          hlsPlaylistKey: null,
          sourceSizeBytes: 5000n, // already credited by the sweep
          deletedAt: new Date("2024-01-01T00:00:00.000Z"),
        },
      ]),
      images: imagesRepo([
        { key: "img-live.jpg", sizeBytes: 300n, deletedAt: null },
        {
          key: "img-soft.png",
          sizeBytes: 8000n, // already credited by the sweep
          deletedAt: new Date("2024-01-01T00:00:00.000Z"),
        },
      ]),
    };

    const result = await collectEventMediaDeletionTargets(repos, EVENT_ID);

    // Bytes: live-only on BOTH media types.
    expect(result.audioBytes).toBe(2000n);
    expect(result.imageBytes).toBe(300n);
    // Coverage: every blob (live + soft-deleted) is still an enqueue target.
    expect(result.exactKeys).toEqual([
      "audio-live.mp3",
      "audio-soft.mp3",
      "img-live.jpg",
      "img-soft.png",
    ]);
  });

  it("returns empty sets for an event with no media", async () => {
    const repos = {
      audioUploads: audioRepo([]),
      images: imagesRepo([]),
    };

    const result = await collectEventMediaDeletionTargets(repos, EVENT_ID);

    expect(result).toEqual({
      exactKeys: [],
      prefixes: [],
      audioBytes: 0n,
      imageBytes: 0n,
    });
  });
});

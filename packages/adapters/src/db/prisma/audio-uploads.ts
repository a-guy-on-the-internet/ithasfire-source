import type {
  AudioUploadsRepo,
  AudioUploadRecord,
  CreateAudioUploadInput,
  MarkAudioUploadedInput,
  MarkAudioTranscodingInput,
  MarkAudioTranscodedInput,
  MarkAudioFailedInput,
  AttachAudioUploadsInput,
  DetachAudioUploadsInput,
  SoftDeleteAudioUploadsInput,
} from "@th/ports/repos/audio-uploads";

import type { PrismaClientOrTx } from "./types";
import type { AudioUploadStatus as PrismaAudioUploadStatus } from "@prisma/client";

type AudioUploadRow = {
  id: string;
  eventId: string;
  sourceKey: string;
  sourceUrl: string;
  sourceContentType: string | null;
  sourceSizeBytes: bigint | null;
  hlsPlaylistKey: string | null;
  hlsPlaylistUrl: string | null;
  segmentCount: number | null;
  durationSeconds: number | null;
  waveformPeaks: unknown;
  status: PrismaAudioUploadStatus;
  uploadedAt: Date | null;
  transcodedAt: Date | null;
  failedAt: Date | null;
  failureReason: string | null;
  attached: boolean;
  attachedAt: Date | null;
  detachedAt: Date | null;
  deletedAt: Date | null;
  createdByHumanId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toRecord(row: AudioUploadRow): AudioUploadRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    sourceKey: row.sourceKey,
    sourceUrl: row.sourceUrl,
    sourceContentType: row.sourceContentType,
    sourceSizeBytes: row.sourceSizeBytes,
    hlsPlaylistKey: row.hlsPlaylistKey,
    hlsPlaylistUrl: row.hlsPlaylistUrl,
    segmentCount: row.segmentCount,
    durationSeconds: row.durationSeconds,
    waveformPeaks: Array.isArray(row.waveformPeaks)
      ? (row.waveformPeaks as number[])
      : null,
    status: row.status as AudioUploadRecord["status"],
    uploadedAt: row.uploadedAt,
    transcodedAt: row.transcodedAt,
    failedAt: row.failedAt,
    failureReason: row.failureReason,
    attached: row.attached,
    attachedAt: row.attachedAt,
    detachedAt: row.detachedAt,
    deletedAt: row.deletedAt,
    createdByHumanId: row.createdByHumanId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function makeAudioUploadsRepo(p: PrismaClientOrTx): AudioUploadsRepo {
  return {
    async create(input: CreateAudioUploadInput): Promise<AudioUploadRecord> {
      const row = await p.audioUpload.create({
        data: {
          id: input.id,
          eventId: input.eventId,
          sourceKey: input.sourceKey,
          sourceUrl: input.sourceUrl,
          sourceContentType: input.sourceContentType,
          sourceSizeBytes: input.sourceSizeBytes,
          createdByHumanId: input.createdByHumanId,
          status: "PENDING",
        },
      });
      return toRecord(row);
    },

    async getById(id: string): Promise<AudioUploadRecord | null> {
      const row = await p.audioUpload.findUnique({ where: { id } });
      return row ? toRecord(row) : null;
    },

    async resolveByIds(ids: string[]): Promise<AudioUploadRecord[]> {
      if (ids.length === 0) return [];
      const rows = await p.audioUpload.findMany({
        where: { id: { in: ids } },
      });
      return rows.map(toRecord);
    },

    async markUploaded(
      input: MarkAudioUploadedInput,
    ): Promise<AudioUploadRecord> {
      const row = await p.audioUpload.update({
        where: { id: input.id },
        data: {
          uploadedAt: input.uploadedAt,
          status: "UPLOADED",
          ...(input.sourceUrl !== undefined
            ? { sourceUrl: input.sourceUrl }
            : {}),
        },
      });
      return toRecord(row);
    },

    async markTranscoding(
      input: MarkAudioTranscodingInput,
    ): Promise<AudioUploadRecord> {
      const row = await p.audioUpload.update({
        where: { id: input.id },
        data: {
          status: "TRANSCODING",
        },
      });
      return toRecord(row);
    },

    async markTranscoded(
      input: MarkAudioTranscodedInput,
    ): Promise<AudioUploadRecord> {
      const row = await p.audioUpload.update({
        where: { id: input.id },
        data: {
          hlsPlaylistUrl: input.hlsPlaylistUrl,
          hlsPlaylistKey: input.hlsPlaylistKey,
          segmentCount: input.segmentCount,
          durationSeconds: input.durationSeconds,
          transcodedAt: input.transcodedAt,
          status: "READY",
          ...(input.waveformPeaks
            ? { waveformPeaks: input.waveformPeaks }
            : {}),
        },
      });
      return toRecord(row);
    },

    async markFailed(input: MarkAudioFailedInput): Promise<AudioUploadRecord> {
      const row = await p.audioUpload.update({
        where: { id: input.id },
        data: {
          failedAt: input.failedAt,
          failureReason: input.failureReason,
          status: "FAILED",
        },
      });
      return toRecord(row);
    },

    async attach(input: AttachAudioUploadsInput): Promise<void> {
      if (input.audioUploadIds.length === 0) return;
      await p.audioUpload.updateMany({
        where: {
          id: { in: input.audioUploadIds },
          eventId: input.eventId,
        },
        data: {
          attached: true,
          attachedAt: input.attachedAt,
          detachedAt: null, // Clear any previous detach
        },
      });
    },

    async detach(input: DetachAudioUploadsInput): Promise<void> {
      if (input.audioUploadIds.length === 0) return;
      await p.audioUpload.updateMany({
        where: {
          id: { in: input.audioUploadIds },
          eventId: input.eventId,
        },
        data: {
          attached: false,
          detachedAt: input.detachedAt,
        },
      });
    },

    async softDelete(input: SoftDeleteAudioUploadsInput): Promise<void> {
      if (input.audioUploadIds.length === 0) return;
      await p.audioUpload.updateMany({
        where: { id: { in: input.audioUploadIds } },
        data: { deletedAt: input.deletedAt },
      });
    },

    async listByEventId(eventId: string): Promise<AudioUploadRecord[]> {
      const rows = await p.audioUpload.findMany({
        where: {
          eventId,
          deletedAt: null,
        },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toRecord);
    },

    async listByEventIdIncludingDeleted(
      eventId: string,
    ): Promise<AudioUploadRecord[]> {
      // Intentionally does NOT filter `deletedAt` — soft-deleted uploads still
      // cascade-delete with the event, and the orphan sweep can't reclaim a
      // cascade-deleted row, so storage cleanup on event delete must include
      // them.
      const rows = await p.audioUpload.findMany({
        where: { eventId },
        orderBy: { createdAt: "asc" },
      });
      return rows.map(toRecord);
    },

    async listPendingTranscode(input: {
      limit: number;
    }): Promise<AudioUploadRecord[]> {
      const rows = await p.audioUpload.findMany({
        where: {
          status: "UPLOADED",
          deletedAt: null,
        },
        orderBy: { uploadedAt: "asc" },
        take: input.limit,
      });
      return rows.map(toRecord);
    },

    async listStalled(input: {
      olderThan: Date;
      limit: number;
    }): Promise<AudioUploadRecord[]> {
      const rows = await p.audioUpload.findMany({
        where: {
          status: { in: ["PENDING", "UPLOADED"] },
          createdAt: { lt: input.olderThan },
          deletedAt: null,
        },
        orderBy: { createdAt: "asc" },
        take: input.limit,
      });
      return rows.map(toRecord);
    },

    async listSoftDeleted(input: {
      deletedBefore: Date;
      limit: number;
    }): Promise<AudioUploadRecord[]> {
      const rows = await p.audioUpload.findMany({
        where: {
          deletedAt: { not: null, lt: input.deletedBefore },
        },
        orderBy: { deletedAt: "asc" },
        take: input.limit,
      });
      return rows.map(toRecord);
    },

    async hardDelete(id: string): Promise<void> {
      await p.audioUpload.delete({ where: { id } });
    },
  };
}

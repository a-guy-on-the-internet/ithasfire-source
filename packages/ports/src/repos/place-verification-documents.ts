import type {
  CreateVerificationDocumentsInput,
  ListStaleVerificationDocsInput,
  MarkVerificationDocsDeletedInput,
  PlaceVerificationDocumentRecord,
} from "@th/types/repos/place-verification";

export interface PlaceVerificationDocumentsRepo {
  createMany(
    input: CreateVerificationDocumentsInput,
  ): Promise<PlaceVerificationDocumentRecord[]>;
  /** Resolve a single document by its primary id (or null if missing). */
  getById(documentId: string): Promise<PlaceVerificationDocumentRecord | null>;
  listByRequestId(
    requestId: string,
  ): Promise<PlaceVerificationDocumentRecord[]>;
  /**
   * Batch-fetch documents across multiple requests. Returns all documents
   * (including soft-deleted) sorted by createdAt asc within each request.
   * Used to hydrate verification history timelines.
   */
  listByRequestIds(
    requestIds: string[],
  ): Promise<PlaceVerificationDocumentRecord[]>;
  /** Mark all documents for a request as deleted (sets deletedAt). */
  markDeleted(input: MarkVerificationDocsDeletedInput): Promise<number>;
  /** Find documents eligible for stale cleanup. */
  listStale(
    input: ListStaleVerificationDocsInput,
  ): Promise<PlaceVerificationDocumentRecord[]>;
}

export type {
  CreateVerificationDocumentsInput,
  ListStaleVerificationDocsInput,
  MarkVerificationDocsDeletedInput,
  PlaceVerificationDocumentRecord,
} from "@th/types/repos/place-verification";

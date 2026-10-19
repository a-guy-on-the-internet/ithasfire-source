import type { EmbedRecord } from "@th/types/repos/embeds";

export interface EmbedsRepo {
  upsert(input: {
    subjectType: string;
    subjectId: string;
    domain: string;
    createdBy: string;
    requireAuth?: boolean;
    linkOut?: boolean;
    /**
     * "list" | "calendar" (see `EmbedRecord.defaultView`). Omitted PRESERVES
     * the stored value on the upsert-by-(subject, domain) path — same
     * semantics as `requireAuth`/`linkOut`, so an admin control that doesn't
     * render can't silently reset a value it never showed.
     */
    defaultView?: string;
    /** Omitted preserves the stored value (see `defaultView`). */
    viewToggle?: boolean;
  }): Promise<EmbedRecord>;

  listBySubject(input: {
    subjectType: string;
    subjectId: string;
  }): Promise<EmbedRecord[]>;

  getById(id: string): Promise<EmbedRecord | null>;

  getActiveBySubjectAndDomain(input: {
    subjectType: string;
    subjectId: string;
    domain: string;
  }): Promise<EmbedRecord | null>;

  revoke(id: string): Promise<EmbedRecord>;
}

export type { EmbedRecord } from "@th/types/repos/embeds";

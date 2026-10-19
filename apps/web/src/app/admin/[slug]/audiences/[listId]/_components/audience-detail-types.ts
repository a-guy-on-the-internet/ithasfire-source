export interface EntryRow {
  id: string;
  contactEmail: string | null;
  contactPhone: string | null;
  displayName: string | null;
  tags: string[];
  consentSource: string | null;
  unsubscribedAt: Date | null;
  createdAt: Date;
}

export interface EntryDraft {
  contactEmail: string;
  contactPhone: string;
  displayName: string;
  tags: string;
}

export type EntryFieldErrors = Partial<
  Record<"contactEmail" | "contactPhone" | "displayName" | "tags", string>
>;

export const EMPTY_DRAFT: EntryDraft = {
  contactEmail: "",
  contactPhone: "",
  displayName: "",
  tags: "",
};

export const PAGE_SIZE = 50;

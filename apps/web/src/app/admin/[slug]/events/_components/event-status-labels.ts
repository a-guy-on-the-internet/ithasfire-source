/**
 * Event status → i18n label key. Plain TS on purpose (no Tamagui / @th/ui
 * imports): shared by `EventStatusBadge` (the chip) and the event rail
 * context (the ledger shell's context-strip fact), and importable from the
 * provider-free AdminShell test harness. `Record<EventStatus, string>` so a
 * new enum member is a compile error here, not a missing label at runtime.
 */
export type EventStatus =
  | "DRAFT"
  | "PUBLISHED"
  | "COMPLETED"
  | "CANCELLED"
  | "ARCHIVED";

export const EVENT_STATUS_LABEL_KEYS: Record<EventStatus, string> = {
  DRAFT: "admin.eventStatusDraft",
  PUBLISHED: "admin.eventStatusPublished",
  COMPLETED: "admin.eventStatusCompleted",
  CANCELLED: "admin.eventStatusCancelled",
  ARCHIVED: "admin.eventStatusArchived",
};

export const isKnownEventStatus = (s: string): s is EventStatus =>
  s in EVENT_STATUS_LABEL_KEYS;

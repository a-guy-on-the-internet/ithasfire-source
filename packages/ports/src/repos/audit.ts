import type {
  AuditLogEntry,
  AuditLogListItem,
  ListAuditLogsForEntityInput,
  ListAuditLogsInput,
  ListAuditLogsResult,
} from "@th/types";

export interface AuditRepo {
  log(entry: AuditLogEntry): Promise<void>;
  /**
   * Paginated, filterable list of audit-log rows. Powers the platform-staff
   * read-only /platform/audit-log viewer. Sorted by `at` descending by
   * default.
   */
  list(input: ListAuditLogsInput): Promise<ListAuditLogsResult>;
  /**
   * Rows of ONE entity (`entity` + `entityId`, exact) whose `action` is one
   * of `actions` (exact), strictly newer than `after` when given, newest
   * first (`at` desc, then `id` desc so equal times read in a stable order),
   * at most `limit`. No count. For use cases that derive state from audit
   * rows (the moderator place page handover, say), where `list`'s
   * contains-style filters could not use an index.
   */
  listForEntity(input: ListAuditLogsForEntityInput): Promise<AuditLogListItem[]>;
}

export type {
  AuditLogEntry,
  AuditLogListItem,
  ListAuditLogsForEntityInput,
  ListAuditLogsInput,
  ListAuditLogsResult,
} from "@th/types";

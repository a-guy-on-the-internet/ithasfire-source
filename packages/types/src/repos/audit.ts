export interface AuditLogEntry {
  entity: string;
  entityId?: string | null;
  action: string;
  data?: unknown;
  at?: Date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Platform-wide read-only audit-log viewer (/platform/audit-log)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Filters for the paginated, staff-only audit-log listing. `entity` and
 * `action` are free-form strings written by ~65 distinct call sites across
 * the codebase (no enum) — filters are contains-style, not exact-match.
 */
export interface ListAuditLogsInput {
  /** Contains-style, case-insensitive filter on `entity`. */
  entity?: string | null;
  /** Contains-style, case-insensitive filter on `action`. */
  action?: string | null;
  /** Exact-match filter on `entityId`. */
  entityId?: string | null;
  /**
   * Filters on `data.actorHumanId` — a convention nearly every write site
   * follows, but NOT a top-level column (it's nested inside the untyped
   * `data` JSON blob). Implemented as a Postgres JSON path filter
   * (`data: { path: ["actorHumanId"], equals }`). There is no expression
   * index backing this path, so it runs a sequential scan over whatever the
   * other filters/date-range narrowed down to first — acceptable given
   * today's sparse audit_log volume; flagged as a follow-up (partial/
   * expression index) if this filter turns out to be hot at real volume.
   */
  actorHumanId?: string | null;
  /** Inclusive lower bound on `at`. */
  atGte?: Date;
  /** Inclusive upper bound on `at`. */
  atLte?: Date;
  sort?: "at_desc" | "at_asc";
  limit?: number;
  offset?: number;
}

export interface AuditLogListItem {
  id: string;
  entity: string;
  entityId: string | null;
  action: string;
  /** Raw, untyped payload — rendered pretty-printed, never hand-formatted. */
  data: unknown;
  /** Best-effort extraction of `data.actorHumanId`; null if absent/malformed. */
  actorHumanId: string | null;
  at: Date;
}

export interface ListAuditLogsResult {
  items: AuditLogListItem[];
  total: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Exact-match reads for one entity (use cases deriving state from audit rows)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rows of ONE entity whose action is one of `actions`, newest first. Every
 * filter is EXACT (unlike {@link ListAuditLogsInput}'s contains-style ones),
 * so the read can use the `(entity, at)` index; no count is taken.
 */
export interface ListAuditLogsForEntityInput {
  entity: string;
  entityId: string;
  /** Exact action names; at least one. */
  actions: readonly string[];
  /** Only rows strictly newer than this. */
  after?: Date | null;
  /** Most rows returned (newest first). */
  limit: number;
}

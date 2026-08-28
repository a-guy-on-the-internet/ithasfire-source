import { openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";

import { buildFtsMatch } from "./people-search-tokens";
import { planQueuedUndo } from "./queued-undo-plan";

let _db: SQLiteDatabase | null = null;
let _ftsAvailable = true;

function db(): SQLiteDatabase {
  if (!_db) {
    _db = openDatabaseSync("scanner.db");
    _db.execSync("PRAGMA journal_mode = WAL;");
    migrate(_db);
  }
  return _db;
}

/** Probe FTS5 availability at migration time. Expo SQLite ships with FTS5 on
 * iOS 16+ / Android 10+, but we fall back to LIKE on older devices. */
function probeFts5(d: SQLiteDatabase): boolean {
  try {
    d.execSync(
      "CREATE VIRTUAL TABLE IF NOT EXISTS _fts_probe USING fts5(x); DROP TABLE _fts_probe;",
    );
    return true;
  } catch {
    return false;
  }
}

function migrate(d: SQLiteDatabase) {
  d.execSync(`
    CREATE TABLE IF NOT EXISTS events (
      event_id    TEXT PRIMARY KEY,
      event_name  TEXT NOT NULL,
      org_id      TEXT NOT NULL,
      start_at    TEXT,
      end_at      TEXT,
      status      TEXT NOT NULL,
      role        TEXT NOT NULL,
      lat         REAL,
      lng         REAL,
      synced_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      ticket_id        TEXT PRIMARY KEY,
      code             TEXT NOT NULL,
      event_id         TEXT NOT NULL,
      status           TEXT NOT NULL,
      owner_human      TEXT,
      scanned_at       TEXT,
      ticket_type_name TEXT,
      order_id         TEXT,
      synced_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_code ON tickets(code);
    CREATE INDEX IF NOT EXISTS idx_tickets_event ON tickets(event_id);

    CREATE TABLE IF NOT EXISTS scan_queue (
      queue_id        TEXT PRIMARY KEY,
      event_id        TEXT NOT NULL,
      ticket_code     TEXT NOT NULL,
      client_key      TEXT NOT NULL,
      enqueued_at     INTEGER NOT NULL,
      attempts        INTEGER NOT NULL DEFAULT 0,
      last_error      TEXT,
      next_attempt_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS recent_scans (
      scan_id        TEXT PRIMARY KEY,
      event_id       TEXT NOT NULL,
      ticket_code    TEXT NOT NULL,
      ticket_id      TEXT,
      holder_display TEXT,
      kind           TEXT NOT NULL,
      scanned_at     INTEGER NOT NULL,
      undone         INTEGER NOT NULL DEFAULT 0,
      -- FR-006a: the scan_queue row this admit is waiting on, when it never
      -- reached the server. NULL means "server-acknowledged (or never
      -- queued)", which is the online-only undo path.
      queue_id       TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_recent_scans_at ON recent_scans(scanned_at DESC);

    -- FR-010: terminal queue drops.
    --
    -- A queued admit that exhausts MAX_ATTEMPTS (or is rejected permanently)
    -- used to be DELETEd with no trace: a ticket admitted at the door that the
    -- server never recorded, invisible to the operator, the organizer and us.
    -- Rows land here instead of vanishing, which is what makes the failed count
    -- and the settings retry possible.
    --
    -- client_key is the load-bearing column. Retry MUST replay with the
    -- ORIGINAL key — the server's idempotency key is (event, code, clientKey)
    -- — so a replay of an admit the server actually did record collapses into a
    -- REPLAY instead of double-admitting.
    CREATE TABLE IF NOT EXISTS dropped_scans (
      drop_id      TEXT PRIMARY KEY,
      queue_id     TEXT,
      event_id     TEXT NOT NULL,
      ticket_code  TEXT NOT NULL,
      client_key   TEXT NOT NULL,
      enqueued_at  INTEGER NOT NULL,
      dropped_at   INTEGER NOT NULL,
      attempts     INTEGER NOT NULL DEFAULT 0,
      reason       TEXT NOT NULL,
      last_error   TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_dropped_scans_event ON dropped_scans(event_id);
    CREATE INDEX IF NOT EXISTS idx_dropped_scans_at ON dropped_scans(dropped_at DESC);

    -- v2: people directory for unified search
    CREATE TABLE IF NOT EXISTS people (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      human_id      TEXT NOT NULL,
      event_id      TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('attendee', 'volunteer')),
      display_name  TEXT,
      email         TEXT,
      signup_status TEXT,
      synced_at     INTEGER NOT NULL,
      UNIQUE (human_id, event_id, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_people_event ON people(event_id);
    CREATE INDEX IF NOT EXISTS idx_people_synced_at ON people(synced_at);
  `);

  // Idempotent column add for installs predating the next_attempt_at field
  // (scan-queue exponential backoff). SQLite rejects ALTER if the column
  // already exists — swallow that case.
  try {
    d.execSync(
      "ALTER TABLE scan_queue ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;",
    );
  } catch {
    // column already present
  }

  // Same precedent, for FR-006a's queue↔recent-scan link. Installs predating
  // this build carry NULL here; `findQueueRowForRecentScan` falls back to an
  // (event_id, ticket_code) match for exactly those rows.
  try {
    d.execSync("ALTER TABLE recent_scans ADD COLUMN queue_id TEXT;");
  } catch {
    // column already present
  }

  _ftsAvailable = probeFts5(d);
  if (_ftsAvailable) {
    try {
      d.execSync(`
        CREATE VIRTUAL TABLE IF NOT EXISTS people_fts USING fts5(
          display_name,
          email_lower,
          content='',
          tokenize='unicode61'
        );
      `);
    } catch {
      _ftsAvailable = false;
    }
  }
}

// ── Events ─────────────────────────────────────────────────────────────────

export type LocalEvent = {
  eventId: string;
  eventName: string;
  orgId: string;
  startAt: string | null;
  endAt: string | null;
  status: string;
  role: string;
  lat: number | null;
  lng: number | null;
};

export function upsertEvents(events: LocalEvent[]): void {
  const d = db();
  const now = Date.now();
  const stmt = d.prepareSync(
    `INSERT OR REPLACE INTO events (event_id, event_name, org_id, start_at, end_at, status, role, lat, lng, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  try {
    for (const e of events) {
      stmt.executeSync(
        e.eventId,
        e.eventName,
        e.orgId,
        e.startAt,
        e.endAt,
        e.status,
        e.role,
        e.lat,
        e.lng,
        now,
      );
    }
  } finally {
    stmt.finalizeSync();
  }
}

// ── Tickets ────────────────────────────────────────────────────────────────

/**
 * Write shape for a manifest ticket. `synced_at` is stamped by
 * {@link upsertTickets} from the local clock, so callers never supply it.
 */
export type LocalTicketInput = {
  ticketId: string;
  code: string;
  eventId: string;
  status: string;
  ownerHuman: string | null;
  scannedAt: string | null;
  ticketTypeName: string | null;
  orderId: string | null;
};

/**
 * Read shape for a manifest ticket — the write shape plus the row's
 * `synced_at` (epoch ms).
 *
 * `syncedAt` was previously dropped on the floor by the row mappers even
 * though the column has always existed. FR-001's "OFFLINE — local manifest
 * as of <synced_at>" provenance badge and FR-004's 10-minute express-mode
 * freshness gate both need it, and an offline result that cannot state how
 * stale it is has no business admitting anyone.
 */
export type LocalTicket = LocalTicketInput & {
  /** Epoch ms at which this row was last written from the server manifest. */
  syncedAt: number;
};

export function upsertTickets(tickets: LocalTicketInput[]): void {
  const d = db();
  const now = Date.now();
  const stmt = d.prepareSync(
    `INSERT OR REPLACE INTO tickets (ticket_id, code, event_id, status, owner_human, scanned_at, ticket_type_name, order_id, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  try {
    for (const t of tickets) {
      stmt.executeSync(
        t.ticketId,
        t.code,
        t.eventId,
        t.status,
        t.ownerHuman,
        t.scannedAt,
        t.ticketTypeName,
        t.orderId,
        now,
      );
    }
  } finally {
    stmt.finalizeSync();
  }
}

type TicketRowSql = {
  ticket_id: string;
  code: string;
  event_id: string;
  status: string;
  owner_human: string | null;
  scanned_at: string | null;
  ticket_type_name: string | null;
  order_id: string | null;
  synced_at: number;
};

const toLocalTicket = (row: TicketRowSql): LocalTicket => ({
  ticketId: row.ticket_id,
  code: row.code,
  eventId: row.event_id,
  status: row.status,
  ownerHuman: row.owner_human,
  scannedAt: row.scanned_at,
  ticketTypeName: row.ticket_type_name,
  orderId: row.order_id,
  // Rows written before this column was mapped still carry a value (the
  // column is NOT NULL), but a hand-migrated/corrupt row could surface a
  // non-number. Coerce to 0 ("infinitely stale") rather than NaN so the
  // freshness gate fails closed.
  syncedAt: typeof row.synced_at === "number" ? row.synced_at : 0,
});

/**
 * Exact-match lookup by ticket code. Codes are bearer credentials: this is
 * the only ticket read path, and it never enumerates.
 *
 * ⚠️ NOT EVENT-SCOPED. The query filters on `code` alone, so a manifest row
 * belonging to a DIFFERENT event is returned happily — bare (typed) codes
 * carry no event context at all. Every caller MUST compare the returned
 * `eventId` against the selected event before treating the row as this
 * event's ticket; see `offline-resolve.ts`, which does exactly that and
 * returns `wrong_event` on mismatch. Missing that check is a cross-event
 * admission bug.
 *
 * `COLLATE NOCASE`: minted codes are lowercase (`tk_<24 hex>`) while both the
 * QR parser (`qr.ts`) and the manual-entry field upper-case what they read,
 * so a case-sensitive `=` would miss every real ticket on the offline path.
 * This is still an EXACT full-string match — only ASCII case is folded — and
 * the underlying codes are hex/alnum, so no credential entropy is traded
 * away. (It does cost the `idx_tickets_code` index, which is BINARY-collated;
 * a per-event manifest is a few thousand rows, so the scan is negligible.)
 */
export function lookupTicketByCode(code: string): LocalTicket | null {
  const row = db().getFirstSync<TicketRowSql>(
    "SELECT * FROM tickets WHERE code = ? COLLATE NOCASE LIMIT 1",
    code,
  );
  return row ? toLocalTicket(row) : null;
}

/**
 * ## Why every code comparison in this file is `COLLATE NOCASE`
 *
 * Minted codes are lowercase (`tk_<24 hex>`) but BOTH the QR parser
 * (`qr.ts` upper-cases what it decodes) and the manual-entry field
 * (`autoCapitalize="characters"`) hand this module an UPPER-CASE string.
 * `lookupTicketByCode` was fixed to collate NOCASE; these three writers were
 * not, and a binary `=` against an upper-cased code updates **zero rows,
 * silently** — no throw, no error, the admitted counter simply never moves.
 *
 * That is the whole bug class, so it is fixed at the class level rather than
 * by asking every call site to remember to pass `result.ticketCode` (the row's
 * true casing). Call sites should still prefer the row's casing where they
 * have it; this makes the wrong choice harmless instead of invisible.
 *
 * Still an EXACT full-string match — only ASCII case is folded, and the
 * underlying codes are hex/alnum, so no credential entropy is traded away.
 */
export function markTicketScannedLocally(code: string): void {
  db().runSync(
    "UPDATE tickets SET status = 'SCANNED', scanned_at = ? WHERE code = ? COLLATE NOCASE",
    new Date().toISOString(),
    code,
  );
}

export function markTicketValidLocally(code: string): void {
  db().runSync(
    "UPDATE tickets SET status = 'VALID', scanned_at = NULL WHERE code = ? COLLATE NOCASE",
    code,
  );
}

export function findSameOrderTickets(
  orderId: string,
  excludeCode: string,
): LocalTicket[] {
  return db()
    .getAllSync<TicketRowSql>(
      // `!=` needs the same collation as `=` above, or the scanned ticket
      // itself reappears in its own "others from this order" list whenever the
      // caller passes an upper-cased code.
      "SELECT * FROM tickets WHERE order_id = ? AND code != ? COLLATE NOCASE AND status = 'VALID'",
      orderId,
      excludeCode,
    )
    .map(toLocalTicket);
}

// ── Counter ────────────────────────────────────────────────────────────────

export type EventCounts = {
  total: number;
  scanned: number;
};

export function getEventCounts(eventId: string): EventCounts {
  const row = db().getFirstSync<{ total: number; scanned: number }>(
    `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN status = 'SCANNED' THEN 1 ELSE 0 END) AS scanned
     FROM tickets
     WHERE event_id = ? AND status IN ('VALID', 'SCANNED')`,
    eventId,
  );
  return { total: row?.total ?? 0, scanned: row?.scanned ?? 0 };
}

// ── Offline scan queue ─────────────────────────────────────────────────────

export type QueuedScan = {
  queueId: string;
  eventId: string;
  ticketCode: string;
  clientKey: string;
  enqueuedAt: number;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number;
};

export function enqueueScan(args: {
  eventId: string;
  ticketCode: string;
  clientKey: string;
}): QueuedScan {
  const queueId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const enqueuedAt = Date.now();
  db().runSync(
    `INSERT INTO scan_queue (queue_id, event_id, ticket_code, client_key, enqueued_at)
     VALUES (?, ?, ?, ?, ?)`,
    queueId,
    args.eventId,
    args.ticketCode,
    args.clientKey,
    enqueuedAt,
  );
  return {
    queueId,
    eventId: args.eventId,
    ticketCode: args.ticketCode,
    clientKey: args.clientKey,
    enqueuedAt,
    attempts: 0,
    lastError: null,
    nextAttemptAt: 0,
  };
}

export function listQueuedScans(): QueuedScan[] {
  return db()
    .getAllSync<{
      queue_id: string;
      event_id: string;
      ticket_code: string;
      client_key: string;
      enqueued_at: number;
      attempts: number;
      last_error: string | null;
      next_attempt_at: number;
    }>("SELECT * FROM scan_queue ORDER BY enqueued_at ASC")
    .map((r) => ({
      queueId: r.queue_id,
      eventId: r.event_id,
      ticketCode: r.ticket_code,
      clientKey: r.client_key,
      enqueuedAt: r.enqueued_at,
      attempts: r.attempts,
      lastError: r.last_error,
      nextAttemptAt: r.next_attempt_at,
    }));
}

/**
 * Subset of the queue currently eligible for retry (nextAttemptAt has
 * elapsed). Items still inside their backoff window are skipped until
 * their slot opens. Ordered FIFO by enqueue time so older scans always
 * win the next slot.
 */
export function listDueQueuedScans(nowMs: number): QueuedScan[] {
  return db()
    .getAllSync<{
      queue_id: string;
      event_id: string;
      ticket_code: string;
      client_key: string;
      enqueued_at: number;
      attempts: number;
      last_error: string | null;
      next_attempt_at: number;
    }>(
      "SELECT * FROM scan_queue WHERE next_attempt_at <= ? ORDER BY enqueued_at ASC",
      nowMs,
    )
    .map((r) => ({
      queueId: r.queue_id,
      eventId: r.event_id,
      ticketCode: r.ticket_code,
      clientKey: r.client_key,
      enqueuedAt: r.enqueued_at,
      attempts: r.attempts,
      lastError: r.last_error,
      nextAttemptAt: r.next_attempt_at,
    }));
}

/**
 * Drop a queue row AND clear every `recent_scans.queue_id` pointing at it, in
 * one transaction.
 *
 * ## Why the link has to be cleared here
 *
 * `recent_scans.queue_id` means "this admit has NOT reached the server". The
 * flusher used to delete the queue row and leave the column set, so the
 * meaning inverted the moment a flush succeeded — and the undo strip read that
 * stale column as "still queued". The sequence that produced a silent no-op:
 * admit fails transiently → enqueued, `queue_id` set → flusher succeeds 15s
 * later → queue row gone, `queue_id` still set → wifi drops → operator taps
 * UNDO inside the 30s window → the button renders ENABLED and the caption
 * still says "· queued" → the local cancel finds no queue row and returns
 * `requires_server` → the offline guard returns → **nothing happens at all**.
 * The operator believes an admission was reverted; the server still holds it.
 *
 * Every removal path goes through here (success, permanent rejection, and the
 * MAX_ATTEMPTS terminal drop), so the column cannot survive its row.
 */
export function removeQueuedScan(queueId: string): void {
  const d = db();
  d.withTransactionSync(() => {
    d.runSync("DELETE FROM scan_queue WHERE queue_id = ?", queueId);
    d.runSync(
      "UPDATE recent_scans SET queue_id = NULL WHERE queue_id = ?",
      queueId,
    );
  });
}

export function bumpQueuedScan(
  queueId: string,
  error: string,
  nextAttemptAt: number,
): void {
  db().runSync(
    "UPDATE scan_queue SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE queue_id = ?",
    error,
    nextAttemptAt,
    queueId,
  );
}

export function countQueuedScans(): number {
  const row = db().getFirstSync<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM scan_queue",
  );
  return row?.cnt ?? 0;
}

// ── Terminal drops (FR-010) ────────────────────────────────────────────────

/** Why a queued admit stopped being retried. Neither reason is recoverable
 * automatically — that is precisely why the row has to become visible. */
export type DroppedScanReason =
  /** Exhausted MAX_ATTEMPTS in the flusher's backoff ladder. */
  | "max_attempts"
  /** The server rejected it in a way that will never succeed on retry. */
  | "permanent_error";

export type DroppedScan = {
  dropId: string;
  /** The `scan_queue` row this came from, for correlation. */
  queueId: string | null;
  eventId: string;
  ticketCode: string;
  /**
   * The ORIGINAL client key. Retry replays with this exact value so the
   * server's (event, code, clientKey) idempotency absorbs a replay of an admit
   * it did record. Regenerating it here would turn a retry into a second,
   * distinct admission.
   */
  clientKey: string;
  enqueuedAt: number;
  droppedAt: number;
  attempts: number;
  reason: DroppedScanReason;
  lastError: string | null;
};

type DroppedRowSql = {
  drop_id: string;
  queue_id: string | null;
  event_id: string;
  ticket_code: string;
  client_key: string;
  enqueued_at: number;
  dropped_at: number;
  attempts: number;
  reason: string;
  last_error: string | null;
};

const toDroppedScan = (r: DroppedRowSql): DroppedScan => ({
  dropId: r.drop_id,
  queueId: r.queue_id ?? null,
  eventId: r.event_id,
  ticketCode: r.ticket_code,
  clientKey: r.client_key,
  enqueuedAt: r.enqueued_at,
  droppedAt: r.dropped_at,
  attempts: r.attempts,
  reason: r.reason === "permanent_error" ? "permanent_error" : "max_attempts",
  lastError: r.last_error,
});

/**
 * Record a terminal drop AND remove its queue row, atomically.
 *
 * Atomicity matters in exactly one direction: the queue row must never be
 * deleted without the drop row existing, or the failure becomes invisible again
 * — which is the entire bug FR-010 closes. (`INSERT OR REPLACE` on `drop_id`
 * keeps a re-run idempotent.)
 */
export function recordDroppedScan(args: {
  queueId: string;
  eventId: string;
  ticketCode: string;
  clientKey: string;
  enqueuedAt: number;
  attempts: number;
  reason: DroppedScanReason;
  lastError: string | null;
}): DroppedScan {
  const d = db();
  const droppedAt = Date.now();
  // Deterministic in the queue row, so a double-flush cannot log the same drop
  // twice under two ids.
  const dropId = `drop-${args.queueId}`;

  d.withTransactionSync(() => {
    d.runSync(
      `INSERT OR REPLACE INTO dropped_scans
         (drop_id, queue_id, event_id, ticket_code, client_key, enqueued_at, dropped_at, attempts, reason, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      dropId,
      args.queueId,
      args.eventId,
      args.ticketCode,
      args.clientKey,
      args.enqueuedAt,
      droppedAt,
      args.attempts,
      args.reason,
      args.lastError,
    );
    d.runSync("DELETE FROM scan_queue WHERE queue_id = ?", args.queueId);
    // Same reason `removeQueuedScan` does it: `recent_scans.queue_id` means
    // "this admit has not reached the server", and a pointer that outlives its
    // row inverts that meaning for the undo strip.
    d.runSync(
      "UPDATE recent_scans SET queue_id = NULL WHERE queue_id = ?",
      args.queueId,
    );
  });

  return {
    dropId,
    queueId: args.queueId,
    eventId: args.eventId,
    ticketCode: args.ticketCode,
    clientKey: args.clientKey,
    enqueuedAt: args.enqueuedAt,
    droppedAt,
    attempts: args.attempts,
    reason: args.reason,
    lastError: args.lastError,
  };
}

/**
 * Terminal drops, newest first.
 *
 * NFR-005: these rows show codes the operator already scanned — the same
 * exposure the recent-scans strip carries — and the read is scoped, never an
 * enumeration of the manifest.
 */
export function listDroppedScans(eventId?: string): DroppedScan[] {
  const d = db();
  const rows = eventId
    ? d.getAllSync<DroppedRowSql>(
        "SELECT * FROM dropped_scans WHERE event_id = ? ORDER BY dropped_at DESC",
        eventId,
      )
    : d.getAllSync<DroppedRowSql>(
        "SELECT * FROM dropped_scans ORDER BY dropped_at DESC",
      );
  return rows.map(toDroppedScan);
}

export function countDroppedScans(eventId?: string): number {
  const d = db();
  const row = eventId
    ? d.getFirstSync<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM dropped_scans WHERE event_id = ?",
        eventId,
      )
    : d.getFirstSync<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM dropped_scans",
      );
  return row?.cnt ?? 0;
}

/** Called when a retry finally lands (or the operator clears the row). */
export function removeDroppedScan(dropId: string): void {
  db().runSync("DELETE FROM dropped_scans WHERE drop_id = ?", dropId);
}

// ── Express-mode re-admit guard (FR-004) ───────────────────────────────────

/**
 * Has THIS DEVICE admitted this ticket in the last `withinMs`?
 *
 * ## The race this exists for
 *
 * `upsertTickets` is `INSERT OR REPLACE` and `use-local-sync` re-writes the FULL
 * manifest every 60s. So a manifest sync that lands between an optimistic local
 * admit and the queue flush that reports it **overwrites the local `SCANNED`
 * back to the server's `VALID`**. The system still converges (the server's
 * REPLAY semantics absorb the double-admit, NFR-004), and in manual mode an
 * operator sees a green state and decides.
 *
 * Express mode removes the operator from that loop: a re-scan inside that
 * window would auto-admit a SECOND time with no gesture at all. So express
 * consults this, and a ticket this device already admitted recently drops to
 * MANUAL CONFIRM instead — the local admit log is authoritative about what this
 * device did, even when the manifest has been rewritten under it.
 *
 * Undone scans do not count: an undo is the operator saying "that admission
 * should not stand", and re-scanning after an undo is a legitimate re-admit.
 */
export function wasRecentlyAdmittedOnThisDevice(args: {
  eventId: string;
  ticketCode: string;
  withinMs: number;
  now?: number;
}): boolean {
  const since = (args.now ?? Date.now()) - args.withinMs;
  const row = db().getFirstSync<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM recent_scans
       WHERE event_id = ?
         AND ticket_code = ? COLLATE NOCASE
         AND kind = 'ticket'
         AND undone = 0
         AND scanned_at >= ?`,
    args.eventId,
    args.ticketCode,
    since,
  );
  return (row?.cnt ?? 0) > 0;
}

// ── Recent scans (for undo) ────────────────────────────────────────────────

export type RecentScan = {
  scanId: string;
  eventId: string;
  ticketCode: string;
  ticketId: string | null;
  holderDisplay: string | null;
  kind: "ticket" | "volunteer";
  scannedAt: number;
  undone: boolean;
  /**
   * FR-006a. The `scan_queue` row this admit is still waiting on, or null when
   * the server acknowledged it (or it was never queued).
   *
   * ⚠️ **Provenance, not truth.** Do NOT render "is this still queued?" off
   * this field. It is a cached pointer written at admit time; the authoritative
   * answer is a live read of `scan_queue` (`listQueuedScans()`), which the
   * strip already re-reads every second. `removeQueuedScan` now clears the
   * column on every removal path, but a row written by an older build — or by
   * a build that crashed between the two statements — can still carry a
   * pointer to a queue row that no longer exists.
   */
  queueId: string | null;
};

export function recordRecentScan(args: {
  eventId: string;
  ticketCode: string;
  ticketId: string | null;
  holderDisplay: string | null;
  kind: "ticket" | "volunteer";
}): RecentScan {
  const scanId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const scannedAt = Date.now();
  db().runSync(
    `INSERT INTO recent_scans (scan_id, event_id, ticket_code, ticket_id, holder_display, kind, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    scanId,
    args.eventId,
    args.ticketCode,
    args.ticketId,
    args.holderDisplay,
    args.kind,
    scannedAt,
  );
  return { scanId, ...args, scannedAt, undone: false, queueId: null };
}

type RecentScanRowSql = {
  scan_id: string;
  event_id: string;
  ticket_code: string;
  ticket_id: string | null;
  holder_display: string | null;
  kind: string;
  scanned_at: number;
  undone: number;
  queue_id: string | null;
};

const toRecentScan = (r: RecentScanRowSql): RecentScan => ({
  scanId: r.scan_id,
  eventId: r.event_id,
  ticketCode: r.ticket_code,
  ticketId: r.ticket_id,
  holderDisplay: r.holder_display,
  kind: r.kind === "volunteer" ? "volunteer" : "ticket",
  scannedAt: r.scanned_at,
  undone: r.undone === 1,
  // Rows written before the queue_id column existed read back as undefined,
  // not null — normalise so callers only ever branch on null.
  queueId: r.queue_id ?? null,
});

export function listRecentScans(limit = 5): RecentScan[] {
  return db()
    .getAllSync<RecentScanRowSql>(
      "SELECT * FROM recent_scans ORDER BY scanned_at DESC LIMIT ?",
      limit,
    )
    .map(toRecentScan);
}

export function markRecentScanUndone(scanId: string): void {
  db().runSync("UPDATE recent_scans SET undone = 1 WHERE scan_id = ?", scanId);
}

/**
 * FR-006a — link a recent scan to the queue row that will carry it.
 *
 * Called from the admit path's enqueue branch, because the recent-scan row is
 * written optimistically BEFORE anyone knows whether the server will answer.
 */
export function attachQueueToRecentScan(scanId: string, queueId: string): void {
  db().runSync(
    "UPDATE recent_scans SET queue_id = ? WHERE scan_id = ?",
    queueId,
    scanId,
  );
}

export type LocalUndoOutcome =
  /** A queue row was cancelled and local status reverted — no network needed. */
  | { kind: "cancelled_queued" }
  /** The scan is (or may be) on the server. Caller must revert online. */
  | { kind: "requires_server" };

/**
 * FR-006a / NFR-004 — undo a scan the server never acknowledged.
 *
 * Cancels the pending `scan_queue` row(s) AND reverts the local ticket status
 * AND marks the recent-scan row undone, **atomically**
 * (`withTransactionSync`). Doing these as three loose statements is how you
 * end up with a ticket reverted to VALID while its admit is still queued: the
 * queue then re-admits it minutes later and the undo silently un-does itself.
 *
 * Returns `requires_server` and writes NOTHING when no queue row is found —
 * absence of a queue row means the server has it (or is about to), and
 * reverting that locally would be a lie the next manifest sync overwrites.
 *
 * The row-selection decision lives in `./queued-undo-plan` (pure, node-tested)
 * because this module imports `expo-sqlite`; see that file for why ALL
 * matching rows are cancelled rather than the one the recent scan is linked
 * to. `queue_id` is accepted for provenance only — the (event, code) match is
 * authoritative, and it also covers `recent_scans` rows written before the
 * column existed.
 *
 * ## The one race, stated plainly
 *
 * The flusher (`use-scan-queue.ts`) can be mid-`mutateAsync` for this row when
 * we delete it. If the server then ACCEPTs, the server says SCANNED while we
 * say VALID until the 60s manifest sync corrects us. The window is narrow —
 * the flusher only runs when `network === "online"` — and the resolution is
 * convergent (server authoritative). An offline-queued *revert* racing a
 * queued *admit* is the genuinely dangerous version, and FR-006b keeps it out
 * of scope.
 *
 * ## What actually puts rows in the queue
 *
 * Not only failures. Three triggers, and the docblock used to name one:
 *
 *   1. **Offline admit.** `unified-scan-screen.tsx` enqueues DIRECTLY when
 *      `network === "offline"` — no server attempt is made at all. At a venue
 *      with no signal this is the normal path, not an error path.
 *   2. **Transient admit failure** (no error code / `INTERNAL_SERVER_ERROR` /
 *      `TIMEOUT` / a network `TypeError`).
 *   3. **Bulk admit**, under either of the above, once per ticket code.
 *
 * The operator-visible symptom of getting this wrong is specific: an UNDO that
 * appears to work (haptic, row disappears) while the admission is still live
 * on the server, or an UNDO that does nothing at all.
 */
export function undoQueuedScanLocally(args: {
  scanId: string;
  eventId: string;
  ticketCode: string;
  /** From the recent-scan row; null for rows written before the column. */
  queueId: string | null;
}): LocalUndoOutcome {
  const d = db();
  let outcome: LocalUndoOutcome = { kind: "requires_server" };

  d.withTransactionSync(() => {
    const rows = d.getAllSync<{ queue_id: string; enqueued_at: number }>(
      `SELECT queue_id, enqueued_at FROM scan_queue
         WHERE event_id = ? AND ticket_code = ? COLLATE NOCASE`,
      args.eventId,
      args.ticketCode,
    );

    const plan = planQueuedUndo({
      rows: rows.map((r) => ({
        queueId: r.queue_id,
        enqueuedAt: r.enqueued_at,
      })),
    });
    if (plan.kind === "requires_server") return;

    for (const queueId of plan.queueIds) {
      d.runSync("DELETE FROM scan_queue WHERE queue_id = ?", queueId);
      d.runSync(
        "UPDATE recent_scans SET queue_id = NULL WHERE queue_id = ?",
        queueId,
      );
    }
    d.runSync(
      "UPDATE tickets SET status = 'VALID', scanned_at = NULL WHERE code = ? COLLATE NOCASE",
      args.ticketCode,
    );
    d.runSync(
      "UPDATE recent_scans SET undone = 1, queue_id = NULL WHERE scan_id = ?",
      args.scanId,
    );
    outcome = { kind: "cancelled_queued" };
  });

  return outcome;
}

// ── Cleanup ────────────────────────────────────────────────────────────────

/**
 * Sign-out purge (NFR-005). EVERY local artifact goes.
 *
 * `dropped_scans` is in the list deliberately and not by accident: those rows
 * carry ticket codes and client keys — bearer credentials — for an operator who
 * is signing out. Leaving them behind would strand another operator's admits on
 * a shared device, which is the exact class of leak this purge exists to
 * prevent. Anything added to `migrate()` must be added here in the same change.
 */
export function clearAll(): void {
  const d = db();
  d.execSync(
    "DELETE FROM tickets; DELETE FROM events; DELETE FROM scan_queue; DELETE FROM recent_scans; DELETE FROM people; DELETE FROM dropped_scans;",
  );
  if (_ftsAvailable) {
    try {
      d.execSync("DELETE FROM people_fts;");
    } catch {
      // FTS table may not exist if probe lied; ignore.
    }
  }
}

// ── People (unified search directory) ──────────────────────────────────────

/**
 * Mirrors `ScannerManifestPerson` from `@th/core` — duplicated here because the
 * scanner tsconfig cannot follow transitive `@th/trpc → @th/core → @th/ports`
 * type dependencies. Keep in sync with
 * packages/core/src/use-cases/scanner/get-scanner-event-manifest.ts.
 */
export type ManifestPerson = {
  humanId: string;
  displayName: string | null;
  email: string | null;
  kind: "attendee" | "volunteer";
  signupStatus?: string | null;
};

export type LocalPersonRow = {
  humanId: string;
  eventId: string;
  kind: "attendee" | "volunteer";
  displayName: string | null;
  email: string | null;
  signupStatus: string | null;
  syncedAt: number;
};

type PeopleRowSql = {
  id: number;
  human_id: string;
  event_id: string;
  kind: string;
  display_name: string | null;
  email: string | null;
  signup_status: string | null;
  synced_at: number;
};

const toLocalPersonRow = (r: PeopleRowSql): LocalPersonRow => ({
  humanId: r.human_id,
  eventId: r.event_id,
  kind: r.kind === "volunteer" ? "volunteer" : "attendee",
  displayName: r.display_name,
  email: r.email,
  signupStatus: r.signup_status,
  syncedAt: r.synced_at,
});

export function upsertPeople(eventId: string, people: ManifestPerson[]): void {
  if (people.length === 0) return;
  const d = db();
  const now = Date.now();

  d.withTransactionSync(() => {
    const upsertStmt = d.prepareSync(
      `INSERT INTO people (human_id, event_id, kind, display_name, email, signup_status, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(human_id, event_id, kind) DO UPDATE SET
         display_name  = excluded.display_name,
         email         = excluded.email,
         signup_status = excluded.signup_status,
         synced_at     = excluded.synced_at`,
    );

    try {
      for (const p of people) {
        upsertStmt.executeSync(
          p.humanId,
          eventId,
          p.kind,
          p.displayName,
          p.email,
          p.signupStatus ?? null,
          now,
        );
        if (_ftsAvailable) {
          const idRow = d.getFirstSync<{ id: number }>(
            "SELECT id FROM people WHERE human_id = ? AND event_id = ? AND kind = ?",
            p.humanId,
            eventId,
            p.kind,
          );
          if (idRow) {
            d.runSync("DELETE FROM people_fts WHERE rowid = ?", idRow.id);
            d.runSync(
              "INSERT INTO people_fts (rowid, display_name, email_lower) VALUES (?, ?, ?)",
              idRow.id,
              p.displayName ?? "",
              (p.email ?? "").toLowerCase(),
            );
          }
        }
      }
    } finally {
      upsertStmt.finalizeSync();
    }
  });
}

/**
 * Tokenize a free-text query into FTS5 prefix tokens. Returns null if the
 * query has no usable tokens (caller should short-circuit to []).
 *
 * Implementation lives in `./people-search-tokens` so it can be unit-tested
 * in node without pulling in expo-sqlite.
 */

export function searchPeople(
  eventId: string,
  query: string,
  limit = 50,
): LocalPersonRow[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const d = db();

  if (_ftsAvailable) {
    const match = buildFtsMatch(trimmed);
    if (!match) return [];
    try {
      const rows = d.getAllSync<PeopleRowSql>(
        `SELECT p.* FROM people p
           JOIN people_fts f ON p.id = f.rowid
          WHERE p.event_id = ? AND people_fts MATCH ?
          ORDER BY rank
          LIMIT ?`,
        eventId,
        match,
        limit,
      );
      return rows.map(toLocalPersonRow);
    } catch {
      // Malformed MATCH expression — fall through to LIKE.
    }
  }

  const like = `%${trimmed}%`;
  const rows = d.getAllSync<PeopleRowSql>(
    `SELECT * FROM people
       WHERE event_id = ?
         AND (display_name LIKE ? COLLATE NOCASE OR email LIKE ? COLLATE NOCASE)
       LIMIT ?`,
    eventId,
    like,
    like,
    limit,
  );
  return rows.map(toLocalPersonRow);
}

/**
 * Display name for one human on one event, or null.
 *
 * FR-001 needs this because the `tickets` manifest stores only `owner_human`
 * (an id) — an offline VALID that says "Unknown" where the holder's name
 * belongs is a materially worse door experience than the online one, and the
 * name is already sitting in the people table the same sync writes.
 *
 * EXACT match on (event, human), never an enumeration: the same posture every
 * other read in this file takes (NFR-005).
 */
export function lookupPersonName(
  eventId: string,
  humanId: string,
): string | null {
  if (!humanId) return null;
  const row = db().getFirstSync<{ display_name: string | null }>(
    `SELECT display_name FROM people
       WHERE event_id = ? AND human_id = ? AND display_name IS NOT NULL
       LIMIT 1`,
    eventId,
    humanId,
  );
  return row?.display_name?.trim() || null;
}

export function dropPeopleForEvent(eventId: string): void {
  const d = db();
  d.withTransactionSync(() => {
    if (_ftsAvailable) {
      try {
        d.runSync(
          "DELETE FROM people_fts WHERE rowid IN (SELECT id FROM people WHERE event_id = ?)",
          eventId,
        );
      } catch {
        // ignore
      }
    }
    d.runSync("DELETE FROM people WHERE event_id = ?", eventId);
  });
}

export function dropAllPeople(): void {
  const d = db();
  d.withTransactionSync(() => {
    if (_ftsAvailable) {
      try {
        d.execSync("DELETE FROM people_fts;");
      } catch {
        // ignore
      }
    }
    d.execSync("DELETE FROM people;");
  });
}

export function dropStalePeople(opts: {
  staleAfterMs: number;
  activeEventIds: string[];
}): void {
  const cutoff = Date.now() - opts.staleAfterMs;
  const d = db();
  d.withTransactionSync(() => {
    if (opts.activeEventIds.length === 0) {
      // No active events — drop anything older than the cutoff.
      if (_ftsAvailable) {
        try {
          d.runSync(
            "DELETE FROM people_fts WHERE rowid IN (SELECT id FROM people WHERE synced_at < ?)",
            cutoff,
          );
        } catch {
          // ignore
        }
      }
      d.runSync("DELETE FROM people WHERE synced_at < ?", cutoff);
      return;
    }
    const placeholders = opts.activeEventIds.map(() => "?").join(", ");
    if (_ftsAvailable) {
      try {
        d.runSync(
          `DELETE FROM people_fts WHERE rowid IN (
             SELECT id FROM people
              WHERE synced_at < ? AND event_id NOT IN (${placeholders})
           )`,
          cutoff,
          ...opts.activeEventIds,
        );
      } catch {
        // ignore
      }
    }
    d.runSync(
      `DELETE FROM people
        WHERE synced_at < ? AND event_id NOT IN (${placeholders})`,
      cutoff,
      ...opts.activeEventIds,
    );
  });
}

/** Test/internal: report whether FTS5 is in use. */
export function isFtsAvailable(): boolean {
  // Trigger lazy init so probe runs on first call.
  db();
  return _ftsAvailable;
}

import type * as Real from "../../src/lib/local-db";
import { planQueuedUndo } from "../../src/lib/queued-undo-plan";

/**
 * In-memory stand-in for `src/lib/local-db.ts` (the device's SQLite).
 *
 * Every export is typed as `typeof Real.<name>`, so a signature change in the
 * real module fails `tsc` here instead of drifting silently. Only what the
 * scan screen's tree calls is implemented; anything else is absent and
 * blows up loudly if a future change starts calling it.
 *
 * ## The SQLITE_BUSY switch
 *
 * `device.failOn("markRecentScanRefused")` makes that function throw on every
 * call until `device.heal()`; `{ once: true }` throws on the next call only.
 * That is how a test puts the store into the state a real door phone gets into
 * under a locked database.
 */

type TicketRow = Real.LocalTicket;
type RecentRow = Real.RecentScan;
type QueueRow = Real.QueuedScan;

const state = {
  tickets: new Map<string, TicketRow>(),
  people: new Map<string, string>(),
  recent: [] as RecentRow[],
  queue: [] as QueueRow[],
  dropped: 0,
  seq: 0,
  failures: new Map<string, { error: Error; once: boolean }>(),
};

const key = (code: string) => code.trim().toUpperCase();
const nextId = () => `${Date.now()}-${(state.seq += 1)}`;

/** Wrap an implementation so `device.failOn(name)` can make it throw. */
const guard = <F extends (...args: never[]) => unknown>(
  name: string,
  impl: F,
): F =>
  ((...args: Parameters<F>) => {
    const failure = state.failures.get(name);
    if (failure) {
      if (failure.once) state.failures.delete(name);
      throw failure.error;
    }
    return impl(...args);
  }) as F;

// ── Manifest ────────────────────────────────────────────────────────────────

export const lookupTicketByCode: typeof Real.lookupTicketByCode = guard(
  "lookupTicketByCode",
  (code: string) => {
    const row = state.tickets.get(key(code));
    return row ? { ...row } : null;
  },
);

export const markTicketScannedLocally: typeof Real.markTicketScannedLocally =
  guard("markTicketScannedLocally", (code: string) => {
    const row = state.tickets.get(key(code));
    if (row) {
      row.status = "SCANNED";
      row.scannedAt = new Date().toISOString();
    }
  });

export const markTicketValidLocally: typeof Real.markTicketValidLocally =
  guard("markTicketValidLocally", (code: string) => {
    const row = state.tickets.get(key(code));
    if (row) {
      row.status = "VALID";
      row.scannedAt = null;
    }
  });

export const findSameOrderTickets: typeof Real.findSameOrderTickets = guard(
  "findSameOrderTickets",
  (orderId: string, excludeCode: string) =>
    [...state.tickets.values()]
      .filter(
        (t) =>
          t.orderId === orderId &&
          key(t.code) !== key(excludeCode) &&
          t.status === "VALID",
      )
      .map((t) => ({ ...t })),
);

export const getEventCounts: typeof Real.getEventCounts = guard(
  "getEventCounts",
  (eventId: string) => {
    const rows = [...state.tickets.values()].filter(
      (t) =>
        t.eventId === eventId && (t.status === "VALID" || t.status === "SCANNED"),
    );
    return {
      total: rows.length,
      scanned: rows.filter((t) => t.status === "SCANNED").length,
    };
  },
);

export const lookupPersonName: typeof Real.lookupPersonName = guard(
  "lookupPersonName",
  (_eventId: string, humanId: string) => state.people.get(humanId) ?? null,
);

// ── Queue ───────────────────────────────────────────────────────────────────

export const enqueueScan: typeof Real.enqueueScan = guard(
  "enqueueScan",
  (args: { eventId: string; ticketCode: string; clientKey: string }) => {
    const row: QueueRow = {
      queueId: `q-${nextId()}`,
      eventId: args.eventId,
      ticketCode: args.ticketCode,
      clientKey: args.clientKey,
      enqueuedAt: Date.now(),
      attempts: 0,
      lastError: null,
      nextAttemptAt: 0,
    };
    state.queue.push(row);
    return { ...row };
  },
);

export const listQueuedScans: typeof Real.listQueuedScans = guard(
  "listQueuedScans",
  () => state.queue.map((q) => ({ ...q })),
);

export const countQueuedScans: typeof Real.countQueuedScans = guard(
  "countQueuedScans",
  () => state.queue.length,
);

export const countDroppedScans: typeof Real.countDroppedScans = guard(
  "countDroppedScans",
  () => state.dropped,
);

// ── Recent scans ────────────────────────────────────────────────────────────

export const recordRecentScan: typeof Real.recordRecentScan = guard(
  "recordRecentScan",
  (args) => {
    const row: RecentRow = {
      scanId: `s-${nextId()}`,
      ...args,
      scannedAt: Date.now(),
      undone: false,
      queueId: null,
      refusedKey: null,
    };
    state.recent.push(row);
    return { ...row };
  },
);

export const listRecentScans: typeof Real.listRecentScans = guard(
  "listRecentScans",
  (limit = 5) =>
    [...state.recent]
      .sort((a, b) => b.scannedAt - a.scannedAt)
      .slice(0, limit)
      .map((r) => ({ ...r })),
);

const recentById = (scanId: string) =>
  state.recent.find((r) => r.scanId === scanId);

export const markRecentScanRefused: typeof Real.markRecentScanRefused = guard(
  "markRecentScanRefused",
  (scanId: string, verdictKey: string) => {
    const row = recentById(scanId);
    if (row) row.refusedKey = verdictKey;
  },
);

export const markRecentScanUndone: typeof Real.markRecentScanUndone = guard(
  "markRecentScanUndone",
  (scanId: string) => {
    const row = recentById(scanId);
    if (row) row.undone = true;
  },
);

export const attachQueueToRecentScan: typeof Real.attachQueueToRecentScan =
  guard("attachQueueToRecentScan", (scanId: string, queueId: string) => {
    const row = recentById(scanId);
    if (row) row.queueId = queueId;
  });

export const wasRecentlyAdmittedOnThisDevice: typeof Real.wasRecentlyAdmittedOnThisDevice =
  guard("wasRecentlyAdmittedOnThisDevice", (args) => {
    const since = (args.now ?? Date.now()) - args.withinMs;
    return state.recent.some(
      (r) =>
        r.eventId === args.eventId &&
        key(r.ticketCode) === key(args.ticketCode) &&
        r.kind === "ticket" &&
        !r.undone &&
        r.refusedKey === null &&
        r.scannedAt >= since,
    );
  });

/** Same rule as the real one: the PURE planner decides, the store obeys. */
export const undoQueuedScanLocally: typeof Real.undoQueuedScanLocally = guard(
  "undoQueuedScanLocally",
  (args) => {
    const rows = state.queue.filter(
      (q) => q.eventId === args.eventId && key(q.ticketCode) === key(args.ticketCode),
    );
    const plan = planQueuedUndo({
      rows: rows.map((r) => ({ queueId: r.queueId, enqueuedAt: r.enqueuedAt })),
    });
    if (plan.kind === "requires_server") return { kind: "requires_server" };
    state.queue = state.queue.filter((q) => !plan.queueIds.includes(q.queueId));
    for (const r of state.recent) {
      if (r.queueId && plan.queueIds.includes(r.queueId)) r.queueId = null;
    }
    const ticket = state.tickets.get(key(args.ticketCode));
    if (ticket) {
      ticket.status = "VALID";
      ticket.scannedAt = null;
    }
    const recent = recentById(args.scanId);
    if (recent) {
      recent.undone = true;
      recent.queueId = null;
    }
    return { kind: "cancelled_queued" };
  },
);

// ── Test controller ─────────────────────────────────────────────────────────

export type FakeTicket = Partial<Real.LocalTicketInput> & { code: string };

export const device = {
  reset(): void {
    state.tickets.clear();
    state.people.clear();
    state.recent = [];
    state.queue = [];
    state.dropped = 0;
    state.seq = 0;
    state.failures.clear();
  },
  /** Seed the synced manifest (what the offline path resolves against). */
  seedTickets(eventId: string, tickets: FakeTicket[]): void {
    for (const t of tickets) {
      state.tickets.set(key(t.code), {
        ticketId: t.ticketId ?? `tid-${t.code}`,
        code: t.code,
        eventId: t.eventId ?? eventId,
        status: t.status ?? "VALID",
        ownerHuman: t.ownerHuman ?? null,
        scannedAt: t.scannedAt ?? null,
        ticketTypeName: t.ticketTypeName ?? null,
        orderId: t.orderId ?? null,
        syncedAt: Date.now(),
      });
    }
  },
  seedPerson(humanId: string, name: string): void {
    state.people.set(humanId, name);
  },
  /** Make `name` throw (a SQLITE_BUSY by default) until `heal()`. */
  failOn(
    name: keyof typeof Real,
    opts: { once?: boolean; error?: Error } = {},
  ): void {
    state.failures.set(name, {
      error: opts.error ?? new Error("SQLITE_BUSY: database is locked"),
      once: opts.once ?? false,
    });
  },
  heal(): void {
    state.failures.clear();
  },
  ticket(code: string): TicketRow | null {
    const row = state.tickets.get(key(code));
    return row ? { ...row } : null;
  },
  queue(): QueueRow[] {
    return state.queue.map((q) => ({ ...q }));
  },
  recent(): RecentRow[] {
    return state.recent.map((r) => ({ ...r }));
  },
};

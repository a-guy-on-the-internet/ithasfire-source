/**
 * FR-001 — offline-first resolve against the locally-synced ticket manifest.
 *
 * PURE. No `expo-*` imports, no SQLite, no network: the caller does the
 * lookup and hands the row in. That split (same as
 * `people-search-tokens.ts` vs `local-db.ts`) is what lets every branch below
 * be asserted in vitest's node environment — and admission decisions are
 * exactly the kind of logic that must be tested rather than eyeballed on a
 * device.
 *
 * ## The rules this module exists to enforce
 *
 * 1. **Absence is UNKNOWN, not invalid.** A code that is not in the manifest
 *    yields "Can't verify offline" (danger) — never a synthesized
 *    "invalid ticket". The manifest is a cache, and a cache miss is not
 *    evidence of forgery. Telling an operator a real ticket is invalid is a
 *    worse failure than telling them to reconnect.
 * 2. **Never synthesize VALID.** Only a row that literally says `VALID`
 *    produces an admittable result. Every other status, and every
 *    unrecognised status, is non-admittable.
 * 3. **Always compare the event.** `lookupTicketByCode` (local-db.ts) is NOT
 *    event-scoped — it matches on `code` alone, so a row for a DIFFERENT
 *    event comes back happily. Bare typed codes carry no event context at
 *    all, and the `hf://` form's embedded id is attacker-supplied. Both the
 *    embedded id AND the row's own `eventId` are checked here. Skipping
 *    either is a cross-event admission bug.
 * 4. **Volunteer passes are not verifiable offline.** Signature verification
 *    is server-side only (packages/transport/trpc/src/routers/scan.ts:53-66,
 *    NFR-005) and must never move client-side. A volunteer JWT gets its own
 *    explicit "needs a connection" state, not the generic error banner.
 * 5. **Provenance is mandatory.** Every result carries `source: "offline"`
 *    plus the manifest age, so the UI can render the badge and FR-004's
 *    express mode can refuse a stale manifest.
 */
import {
  SCAN_UNKNOWN_COPY,
  resolveTicketStatusCopy,
  type ScanStatusTone,
  type TicketScanStatus,
} from "@th/types";

import type { NetworkState } from "../features/network/network-state";
import { parseTicketQrPayload } from "./qr";
import { classifyScanError } from "./scan-error-classification";

// ── Inputs ──────────────────────────────────────────────────────────────────

/**
 * Structural mirror of `LocalTicket` (`./local-db`). Re-declared rather than
 * imported so this module never pulls `expo-sqlite` into a node test; the
 * real `LocalTicket` is assignable to it (asserted in the test file).
 */
export type OfflineManifestTicket = {
  ticketId: string;
  code: string;
  eventId: string;
  status: string;
  ownerHuman: string | null;
  /** ISO timestamp of the local optimistic/synced scan, if any. */
  scannedAt: string | null;
  ticketTypeName: string | null;
  orderId: string | null;
  /** Epoch ms this row was last written from the server manifest. */
  syncedAt: number;
};

/**
 * Loose JWT shape — three dot-separated base64url segments. Byte-identical to
 * the server's `JWT_SHAPE_PATTERN`
 * (packages/core/src/use-cases/scanning/resolve-scan-payload.ts:158) so both
 * sides agree on "this looks like a volunteer pass".
 *
 * Why this check has to come FIRST: `parseTicketQrPayload` accepts ANY
 * trimmed string of 6+ characters as a ticket code, so a volunteer JWT would
 * otherwise sail straight into the ticket branch, miss the manifest, and be
 * reported as "can't verify offline" — technically true but useless, since
 * the operator's actual recovery ("find them with Search once you have
 * signal") is different. Ticket codes never contain `.` (server pattern
 * `^[A-Z0-9]{6,64}$`, minting is `tk_<hex>`; seed fixtures use `TKT-…`), so
 * requiring two dots cannot swallow a legitimate code.
 */
const JWT_SHAPE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export type OfflinePayloadClassification =
  | { kind: "volunteer_jwt" }
  | { kind: "ticket"; ticketCode: string; embeddedEventId: string | null }
  | { kind: "unreadable" };

/**
 * Decide what a raw scanned payload is, without touching storage. Dispatch
 * order mirrors the server: structured `hf://` URL, then volunteer token,
 * then bare ticket code.
 */
export function classifyOfflinePayload(
  raw: string,
): OfflinePayloadClassification {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { kind: "unreadable" };

  // `hf://<eventId>/<code>` is unambiguously a ticket — check before the JWT
  // shape (it can't match anyway) so the embedded event id is preserved.
  const structured = parseTicketQrPayload(trimmed);
  if (structured?.embeddedEventId) {
    return {
      kind: "ticket",
      ticketCode: structured.ticketCode,
      embeddedEventId: structured.embeddedEventId,
    };
  }

  if (JWT_SHAPE_PATTERN.test(trimmed)) return { kind: "volunteer_jwt" };

  if (!structured) return { kind: "unreadable" };
  return {
    kind: "ticket",
    ticketCode: structured.ticketCode,
    embeddedEventId: null,
  };
}

// ── Provenance ──────────────────────────────────────────────────────────────

/**
 * FR-004: an offline VALID older than this must NOT auto-admit; the operator
 * drops back to manual confirm. Exported so the express-mode gate and this
 * module's `stale` flag can never disagree.
 */
export const EXPRESS_MODE_MAX_MANIFEST_AGE_MS = 10 * 60_000;

export type OfflineProvenance = {
  /** Always "offline" — the discriminator the UI badge keys off. */
  source: "offline";
  /**
   * Epoch ms the answering manifest row was synced; null when there was no row
   * — or when the stamp cannot be trusted (see {@link buildProvenance}).
   */
  manifestSyncedAt: number | null;
  /** `now - manifestSyncedAt`. Null when unknown or untrustworthy. */
  manifestAgeMs: number | null;
  /**
   * True when the manifest is older than
   * {@link EXPRESS_MODE_MAX_MANIFEST_AGE_MS} — or when its age is unknown.
   * Unknown counts as stale: fail closed.
   */
  stale: boolean;
};

/**
 * ## The backwards clock fails CLOSED, and clamping was not that
 *
 * `synced_at` is stamped from the LOCAL clock (`upsertTickets`), so `now <
 * syncedAt` is not routine skew — it means the device clock moved backwards
 * (a manual time change, an NTP correction, a dead RTC on boot). The first
 * version clamped that to `Math.max(0, …)`, reasoning that a negative age must
 * not look impossibly fresh. But **0 IS maximally fresh**: it produced
 * `stale: false`, which makes `canExpressAdmitOffline` return true, which lets
 * express auto-admit off an arbitrarily old manifest with no gesture — while
 * `formatManifestProvenance` rendered `OFFLINE · JUST SYNCED`, so the
 * operator's second safeguard read clean too. Every other bad input (null,
 * NaN, non-number, forward drift) already failed closed; this was the one hole.
 *
 * An inconsistent clock means we cannot make ANY trustworthy claim about when
 * this manifest synced — not the age and not the timestamp — so both go null.
 * That routes through the existing "unknown ⇒ stale" branch and the honest
 * `OFFLINE · SYNC UNKNOWN` chip (inverted, the escalated style).
 */
function buildProvenance(args: {
  manifestSyncedAt: number | null;
  now: number;
}): OfflineProvenance {
  const raw =
    typeof args.manifestSyncedAt === "number" &&
    Number.isFinite(args.manifestSyncedAt)
      ? args.manifestSyncedAt
      : null;
  const trustworthy =
    raw !== null && Number.isFinite(args.now) && args.now >= raw;
  const syncedAt = trustworthy ? raw : null;
  const ageMs = syncedAt === null ? null : args.now - syncedAt;
  return {
    source: "offline",
    manifestSyncedAt: syncedAt,
    manifestAgeMs: ageMs,
    stale: ageMs === null || ageMs > EXPRESS_MODE_MAX_MANIFEST_AGE_MS,
  };
}

// ── Results ─────────────────────────────────────────────────────────────────

export type OfflineTicketResult = {
  kind: "ticket";
  ticketId: string;
  ticketCode: string;
  status: TicketScanStatus;
  scannedAt: Date | null;
  holderHumanId: string;
  holderDisplay: string;
  ticketTypeName: string | null;
  /** Always empty offline — volunteer context requires the server. */
  alsoVolunteering: [];
  /** True for exactly one status: a manifest row that literally says VALID. */
  admittable: boolean;
};

export type OfflineWrongEventResult = {
  kind: "wrong_event";
  payloadKind: "ticket";
  scannedEventId: string;
};

/**
 * Reasons we could not answer offline. NONE of these mean "invalid ticket".
 */
export type OfflineUnverifiableReason =
  /** Exact-match lookup found nothing. The manifest is a cache; a miss is unknown. */
  | "not_in_manifest"
  /** The payload didn't parse as anything we recognise. */
  | "unreadable_payload"
  /** A row exists but carries a status this build doesn't know. */
  | "unrecognized_status"
  /** The local store itself failed (SQLite error). Set by the impure caller. */
  | "lookup_failed";

export type OfflineUnverifiableResult = {
  kind: "offline_unverifiable";
  reason: OfflineUnverifiableReason;
};

export type OfflineVolunteerNeedsConnectionResult = {
  kind: "volunteer_needs_connection";
};

type WithProvenance<T> = T & { provenance: OfflineProvenance };

/**
 * Offline analogue of `UnifiedResolveResult`
 * (screens/unified-result-view.tsx:90-94). `ticket` and `wrong_event` are
 * shaped to match so the SAME result view can render them; the two extra
 * kinds exist because "we couldn't check" and "this needs a connection" are
 * states the online resolver has no reason to produce.
 */
export type OfflineResolveResult =
  | WithProvenance<OfflineTicketResult>
  | WithProvenance<OfflineWrongEventResult>
  | WithProvenance<OfflineUnverifiableResult>
  | WithProvenance<OfflineVolunteerNeedsConnectionResult>;

// ── Copy (structured as data, i18n-ready — same shape as @th/types FR-008) ──

export type OfflineCopy = {
  tone: ScanStatusTone;
  labelKey: string;
  label: string;
  guidanceKey: string;
  guidance: string;
};

export const OFFLINE_UNVERIFIABLE_COPY: Record<
  OfflineUnverifiableReason,
  OfflineCopy
> = {
  not_in_manifest: {
    tone: "danger",
    labelKey: "scan.offline.notInManifest.label",
    // Deliberately NOT "Invalid ticket" / "Not found". We do not know.
    label: "Can't verify offline",
    guidanceKey: "scan.offline.notInManifest.guidance",
    // The "that does not mean it's invalid" clause is the SAFETY MECHANISM for
    // a red full-screen state on a possibly-valid ticket, not a softener — a
    // cache miss is not evidence of forgery, and the operator is about to turn
    // someone away on the strength of this sentence. Design §2.2 row 11.
    // "Search" (not "Lookup"): Search is the rail button one tap below this
    // state; Lookup is a different surface, reachable only from Home.
    guidance:
      "This code isn't in the offline list. That does not mean it's invalid — reconnect or use Search before turning anyone away.",
  },
  unreadable_payload: {
    tone: "danger",
    labelKey: "scan.offline.unreadable.label",
    label: "Not recognized",
    guidanceKey: "scan.offline.unreadable.guidance",
    // Reuse the shared malformed copy so both surfaces say the same thing.
    guidance: SCAN_UNKNOWN_COPY.malformed.guidance,
  },
  unrecognized_status: {
    tone: "danger",
    labelKey: "scan.offline.unrecognizedStatus.label",
    label: "Can't verify offline",
    guidanceKey: "scan.offline.unrecognizedStatus.guidance",
    guidance:
      "This ticket's status isn't recognized offline. Reconnect before admitting.",
  },
  lookup_failed: {
    tone: "danger",
    labelKey: "scan.offline.lookupFailed.label",
    label: "Can't verify offline",
    guidanceKey: "scan.offline.lookupFailed.guidance",
    guidance:
      "Couldn't read the offline ticket list on this device. Reconnect and try again.",
  },
};

export const OFFLINE_VOLUNTEER_COPY: OfflineCopy = {
  tone: "warning",
  labelKey: "scan.offline.volunteer.label",
  label: "Needs a connection",
  guidanceKey: "scan.offline.volunteer.guidance",
  // Design §2.2 row 10, verbatim. "Search" is the rail button one tap below
  // this state; "Lookup" is a different screen two navigations away.
  guidance:
    "Volunteer passes are verified on the server. Reconnect, or find them with Search.",
};

// ── Resolve ─────────────────────────────────────────────────────────────────

export type ResolveOfflineScanInput = {
  /** Output of {@link classifyOfflinePayload}. */
  payload: OfflinePayloadClassification;
  /**
   * The manifest row found by EXACT-code lookup, or null when absent.
   * Remember `lookupTicketByCode` is not event-scoped — this row may belong
   * to another event, which is precisely why we re-check below.
   */
  ticket: OfflineManifestTicket | null;
  /** The event the operator has selected. */
  selectedEventId: string;
  /**
   * Manifest sync timestamp (epoch ms). Passed in rather than read from the
   * row so a caller with an event-level sync clock can supply that instead;
   * falls back to the row's own `syncedAt`.
   */
  manifestSyncedAt?: number | null;
  /** Epoch ms. Injected for testability. */
  now: number;
  /**
   * Holder display name, if the caller could resolve one (the tickets table
   * only stores `ownerHuman` = the human id). Defaults to "Unknown", the
   * same fallback the server's resolver uses.
   */
  holderDisplay?: string | null;
};

const sameEventId = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

const parseScannedAt = (iso: string | null): Date | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms) : null;
};

/**
 * Resolve a scanned payload against the local manifest.
 *
 * Order matters and is deliberate:
 *   volunteer → unreadable → embedded-event mismatch → absent row →
 *   row-event mismatch → code mismatch → status.
 * The event checks run BEFORE any status interpretation so a row from
 * another event can never reach the admit path.
 */
export function resolveOfflineScan(
  input: ResolveOfflineScanInput,
): OfflineResolveResult {
  const provenance = buildProvenance({
    manifestSyncedAt: input.manifestSyncedAt ?? input.ticket?.syncedAt ?? null,
    now: input.now,
  });

  const { payload } = input;

  // Rule 4 — volunteer passes need the server.
  if (payload.kind === "volunteer_jwt") {
    return { kind: "volunteer_needs_connection", provenance };
  }

  if (payload.kind === "unreadable") {
    return {
      kind: "offline_unverifiable",
      reason: "unreadable_payload",
      provenance,
    };
  }

  // Rule 3a — the QR declared an event. Reject the mismatch with zero I/O,
  // exactly like the server's hf:// short-circuit.
  if (
    payload.embeddedEventId &&
    !sameEventId(payload.embeddedEventId, input.selectedEventId)
  ) {
    return {
      kind: "wrong_event",
      payloadKind: "ticket",
      scannedEventId: payload.embeddedEventId,
      provenance,
    };
  }

  // Rule 1 — absence is unknown, NOT invalid.
  if (!input.ticket) {
    return {
      kind: "offline_unverifiable",
      reason: "not_in_manifest",
      provenance,
    };
  }

  // Rule 3b — the row's own event. This is the check that matters for bare
  // typed codes, which carry no event context whatsoever.
  if (!sameEventId(input.ticket.eventId, input.selectedEventId)) {
    return {
      kind: "wrong_event",
      payloadKind: "ticket",
      scannedEventId: input.ticket.eventId,
      provenance,
    };
  }

  // Defence in depth: the row must be the one we asked for. A caller that
  // passed a row for a different code (a fuzzy/`LIKE` lookup, a stale
  // closure) must never be able to admit on it. Compared case-insensitively
  // because minted codes are lowercase while the QR parser upper-cases —
  // same reason `lookupTicketByCode` collates NOCASE.
  if (
    input.ticket.code.trim().toUpperCase() !==
    payload.ticketCode.trim().toUpperCase()
  ) {
    return {
      kind: "offline_unverifiable",
      reason: "not_in_manifest",
      provenance,
    };
  }

  // Rule 2 — status is read, never invented.
  const copy = resolveTicketStatusCopy(input.ticket.status);
  if (copy.status === "UNKNOWN") {
    return {
      kind: "offline_unverifiable",
      reason: "unrecognized_status",
      provenance,
    };
  }

  return {
    kind: "ticket",
    ticketId: input.ticket.ticketId,
    ticketCode: input.ticket.code,
    status: copy.status,
    scannedAt: parseScannedAt(input.ticket.scannedAt),
    holderHumanId: input.ticket.ownerHuman ?? "",
    holderDisplay: input.holderDisplay?.trim() || "Unknown",
    ticketTypeName: input.ticket.ticketTypeName,
    alsoVolunteering: [],
    // `copy.admittable` is true for VALID and nothing else (@th/types).
    admittable: copy.admittable,
    provenance,
  };
}

// ── When to go local ────────────────────────────────────────────────────────

/** Why we are answering from the manifest instead of the server. */
export type OfflineFallbackTrigger =
  /** NetInfo says the device has no connection — expected, not an incident. */
  | "device_offline"
  /** `scan.resolvePayload` rejected with a network-classified error. */
  | "resolver_network_error";

/**
 * Should this scan be answered locally? Returns the trigger, or null to stay
 * on the server path.
 *
 * Network-error classification reuses the queue's classifier
 * (`./scan-error-classification`, extracted from `use-scan-queue.ts`) so
 * "was that a network failure?" has exactly one answer in this app. A
 * `degraded` link on its own is NOT a trigger — we only degrade after a
 * server attempt actually fails, so an unreliable-but-working connection
 * still gets the authoritative answer.
 */
export function offlineFallbackTrigger(args: {
  network: NetworkState;
  /** The rejection from a server resolve attempt, if one was made. */
  error?: unknown;
}): OfflineFallbackTrigger | null {
  if (args.network === "offline") return "device_offline";
  if (args.error !== undefined && classifyScanError(args.error) === "network") {
    return "resolver_network_error";
  }
  return null;
}

/**
 * FR-004 gate: may this offline result auto-admit under express mode?
 * Requires an admittable ticket AND a manifest synced inside the freshness
 * window. Anything else drops to manual confirm.
 */
export function canExpressAdmitOffline(result: OfflineResolveResult): boolean {
  return (
    result.kind === "ticket" && result.admittable && !result.provenance.stale
  );
}

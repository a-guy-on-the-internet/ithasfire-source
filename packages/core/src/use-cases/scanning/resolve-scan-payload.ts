/**
 * Unified Scan Resolver
 *
 * Single dispatch entrypoint for the door-scanner pipeline. Given an opaque
 * QR/barcode payload string and the event the operator is currently working,
 * decide whether the payload is:
 *
 *   - a volunteer scan token (HMAC-signed, human+event scoped)
 *   - a ticket code (alnum/`_`/`-`, 6–64 chars, looked up by `Ticket.code`)
 *   - a wrong-event payload (well-formed but for a different event)
 *   - unknown / malformed
 *
 * Dispatch order (FR-004): volunteer first, ticket second.
 *  1. Try `volunteerScanToken.verify(raw)`. On success, branch into volunteer.
 *  2. On signature/scope failure, fall through.
 *  3. Validate the trimmed (NOT case-folded) payload against the ticket-code
 *     shape and look up via `repos.tickets.getByCode`.
 *  4. Otherwise return `{ kind: "unknown" }`.
 *
 * RBAC: `ORG_SCAN_ROLES` against the event's org. The actual mutation
 * (markScanned / checkInVolunteer) is done by separate use cases — this
 * resolver is read-only.
 *
 * Display rules (FR-007a):
 *  - Volunteer & ticket payloads return a sanitized `displayName`
 *    ("First L.") only. We do NOT echo raw email/phone in the output.
 *  - The raw payload string is never logged or surfaced.
 */
import { z } from "zod";

import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { Repos } from "@th/ports/repos";
import type { VolunteerScanTokenPort } from "@th/ports/volunteer-scan-token";

import { parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireOrgMembership } from "../../lib/rbac";
import { fail } from "@th/errors";
import {
  getVolunteerContextForTicketScan,
  type VolunteerCheckInCandidate,
} from "../volunteering";

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

export const resolveScanPayloadInputSchema = z
  .object({
    actorHumanId: z.string().min(1),
    eventId: z.string().uuid(),
    /** Raw, opaque scan payload as captured by the camera/HID. */
    raw: z.string().min(1).max(4096),
  })
  .strict();

export type ResolveScanPayloadInput = z.infer<
  typeof resolveScanPayloadInputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Output (discriminated union by `kind`)
// ─────────────────────────────────────────────────────────────────────────────

export type ResolveScanPayloadAlsoHoldsTicket = {
  ticketId: string;
  ticketCode: string;
  status: "VALID" | "SCANNED";
  scannedAt: Date | null;
};

export type ResolveScanPayloadVolunteerResult = {
  kind: "volunteer";
  humanId: string;
  /** Sanitized "First L." display string. Never raw email/phone. */
  displayName: string;
  /** Eligible volunteer signups for this human at this event, ordered. */
  candidates: VolunteerCheckInCandidate[];
  /**
   * Cross-context enrichment: tickets this human also holds for this event,
   * filtered to `VALID` / `SCANNED` and ordered most-recent-first. Empty
   * array means no admit-eligible / already-admitted tickets.
   */
  alsoHoldsTicket: ResolveScanPayloadAlsoHoldsTicket[];
};

export type ResolveScanPayloadTicketResult = {
  kind: "ticket";
  ticketId: string;
  ticketCode: string;
  status: "VALID" | "SCANNED" | "INVALID" | "REFUNDED" | "LISTED";
  scannedAt: Date | null;
  holderHumanId: string;
  /** Sanitized "First L." display string. Never raw email/phone. */
  holderDisplay: string;
  /** Ticket type label (e.g. "GA", "VIP", "Comp"). Null if no type assigned. */
  ticketTypeName: string | null;
  /** Cross-context enrichment: does this owner ALSO have a volunteer signup? */
  alsoVolunteering: VolunteerCheckInCandidate[];
};

export type ResolveScanPayloadWrongEventResult = {
  kind: "wrong_event";
  /** Which kind of payload was decoded (volunteer vs ticket). */
  payloadKind: "volunteer" | "ticket";
  /** The eventId the payload was actually scoped to. */
  scannedEventId: string;
};

export type ResolveScanPayloadUnknownResult = {
  kind: "unknown";
  reason: "malformed" | "ticket_not_found" | "signature_failed";
};

export type ResolveScanPayloadOutput =
  | ResolveScanPayloadVolunteerResult
  | ResolveScanPayloadTicketResult
  | ResolveScanPayloadWrongEventResult
  | ResolveScanPayloadUnknownResult;

// ─────────────────────────────────────────────────────────────────────────────
// Deps
// ─────────────────────────────────────────────────────────────────────────────

export type ResolveScanPayloadDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  volunteerScanToken: VolunteerScanTokenPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ticket-code shape: bounded, anchored, and matching what we actually mint.
 *
 * `generateTicketCode()` produces `tk_<24 lowercase hex>` — lowercase, with an
 * underscore — and seed/POS codes are hyphenated (`SEED-E01-001-1`,
 * `CASH-E01-02-COMP`). The previous `^[A-Z0-9]{6,64}$` allowed neither `_` nor
 * `-`, so it rejected **every** code the system has ever issued and the ticket
 * branch never ran. Widened to alnum + `_` + `-`, both cases; deliberately no
 * wider — no `.` (so a volunteer JWT can never be mistaken for a ticket code),
 * no whitespace, no URL punctuation.
 *
 * The payload is matched and looked up VERBATIM — no case folding here. The
 * QR encodes `Ticket.code` byte-for-byte, and `Ticket.code` is a plain
 * case-sensitive unique column, so normalising before the lookup is a
 * guaranteed miss. Case tolerance for hand-typed codes lives in the repo
 * (`tickets.getByCode`), which tries the binary-exact unique index first.
 */
const TICKET_CODE_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/**
 * Structured ticket-URL form: `hf://<eventId>/<ticketCode>`. The scheme and
 * the event UUID are case insensitive; the ticket-code group is captured
 * verbatim and must accept `_` and `-` for the same reason as
 * `TICKET_CODE_PATTERN`.
 *
 * When a payload matches this shape we know unambiguously that it is a ticket
 * payload — we can short-circuit before paying the volunteer-token verify cost
 * (NFR-002), and reject wrong-event scans with zero DB I/O (FR-005).
 */
const HF_TICKET_URL_PATTERN =
  /^hf:\/\/([0-9a-f-]{36})\/([A-Za-z0-9_-]{6,64})$/i;

/**
 * Loose JWT shape detector. We use this to distinguish "looked like a
 * volunteer token but signature failed" (`signature_failed`) from "couldn't
 * parse at all" (`malformed`) when verify throws and the payload is not a
 * ticket-code shape either.
 */
const JWT_SHAPE_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/**
 * Volunteer-token verification failures we treat as "fall through to the
 * next decoder". Anything else (e.g. `not_configured`, `network_error`)
 * is an operational failure that must surface to the caller rather than
 * silently skipping the volunteer branch.
 */
const VOLUNTEER_VERIFY_FALLTHROUGH_CODES = new Set<string>([
  "volunteer_qr_invalid",
  "volunteer_qr_expired",
]);

/** Ticket statuses surfaced by FR-006 enrichment as "still holds a ticket". */
const ALSO_HOLDS_TICKET_STATUSES = new Set<"VALID" | "SCANNED">([
  "VALID",
  "SCANNED",
]);

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

export async function resolveScanPayload(
  deps: ResolveScanPayloadDeps,
  rawInput: unknown,
): Promise<ResolveScanPayloadOutput> {
  const input = parseInput(resolveScanPayloadInputSchema, rawInput);
  const scopedLogger = deps.logger?.child({ useCase: "resolveScanPayload" });

  const safeMetric = makeSafeMetric(deps.metrics, scopedLogger);

  // RBAC gate first — read the event up front so we can authorize against
  // its org. We never log the raw payload (FR-007b).
  const event = await deps.repos.tx(async (tx) => {
    const e = await tx.events.getById(input.eventId);
    if (!e || !e.orgId) {
      throw fail("EVENT_NOT_FOUND");
    }
    await requireOrgMembership({
      repos: tx,
      orgId: e.orgId,
      actorHumanId: input.actorHumanId,
      roles: ORG_SCAN_ROLES,
    });
    return e;
  });

  safeMetric("scan.resolve.attempt", { eventId: input.eventId });

  // ── 0. Structured `hf://<eventId>/<ticketCode>` short-circuit ─────────
  // Volunteer JWTs never have this shape, so matching here lets us skip
  // the (potentially remote) volunteer-verify call and reject wrong-event
  // payloads with zero DB I/O (FR-005, NFR-002).
  const hfMatch = HF_TICKET_URL_PATTERN.exec(input.raw.trim());
  if (hfMatch) {
    const urlEventId = (hfMatch[1] ?? "").toLowerCase();
    // Verbatim: the code is a bearer credential compared against a
    // case-sensitive unique column. Upper-casing it here missed every real
    // ticket (`tk_…` is lowercase hex).
    const urlTicketCode = hfMatch[2] ?? "";
    if (urlEventId !== input.eventId) {
      const result: ResolveScanPayloadWrongEventResult = {
        kind: "wrong_event",
        payloadKind: "ticket",
        scannedEventId: urlEventId,
      };
      emitResultMetric(safeMetric, result, {
        crossContextTicketCount: 0,
        crossContextVolunteer: false,
      });
      return result;
    }
    const ticket = await deps.repos.tickets.getByCode(urlTicketCode);
    if (!ticket) {
      const result: ResolveScanPayloadUnknownResult = {
        kind: "unknown",
        reason: "ticket_not_found",
      };
      emitResultMetric(safeMetric, result, {
        crossContextTicketCount: 0,
        crossContextVolunteer: false,
      });
      return result;
    }
    if (ticket.eventId !== input.eventId) {
      // Defense-in-depth: the URL declared this event but the ticket row
      // disagrees. Treat as wrong_event using the ticket's true eventId.
      const result: ResolveScanPayloadWrongEventResult = {
        kind: "wrong_event",
        payloadKind: "ticket",
        scannedEventId: ticket.eventId,
      };
      emitResultMetric(safeMetric, result, {
        crossContextTicketCount: 0,
        crossContextVolunteer: false,
      });
      return result;
    }
    return resolveTicketBranch(deps, input, ticket, scopedLogger, safeMetric);
  }

  // ── 1. Volunteer token branch ───────────────────────────────────────────
  let tokenPayload: Awaited<
    ReturnType<VolunteerScanTokenPort["verify"]>
  > | null = null;
  let signatureFailed = false;
  try {
    tokenPayload = await deps.volunteerScanToken.verify(input.raw);
  } catch (err) {
    // Only known verification-failure codes count as "not a volunteer
    // token, try the next decoder". Operational errors (e.g.
    // `not_configured`, `network_error`) propagate so a misconfigured
    // env surfaces immediately instead of silently routing every scan
    // through the ticket branch.
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code ?? "")
        : "";
    if (!VOLUNTEER_VERIFY_FALLTHROUGH_CODES.has(code)) {
      throw err;
    }
    signatureFailed = true;
    tokenPayload = null;
  }

  if (tokenPayload) {
    if (tokenPayload.eventId !== input.eventId) {
      const result: ResolveScanPayloadWrongEventResult = {
        kind: "wrong_event",
        payloadKind: "volunteer",
        scannedEventId: tokenPayload.eventId,
      };
      emitResultMetric(safeMetric, result, {
        crossContextTicketCount: 0,
        crossContextVolunteer: false,
      });
      return result;
    }

    return resolveVolunteerBranch(
      deps,
      input,
      tokenPayload.humanId,
      scopedLogger,
      safeMetric,
    );
  }

  // ── 2. Ticket-code branch ───────────────────────────────────────────────
  // Trim only — camera/HID capture can pad with whitespace, but the code
  // itself must reach `getByCode` exactly as it was encoded in the QR.
  const candidateCode = input.raw.trim();
  if (TICKET_CODE_PATTERN.test(candidateCode)) {
    const ticket = await deps.repos.tickets.getByCode(candidateCode);
    if (!ticket) {
      const result: ResolveScanPayloadUnknownResult = {
        kind: "unknown",
        reason: "ticket_not_found",
      };
      emitResultMetric(safeMetric, result, {
        crossContextTicketCount: 0,
        crossContextVolunteer: false,
      });
      return result;
    }
    if (ticket.eventId !== input.eventId) {
      const result: ResolveScanPayloadWrongEventResult = {
        kind: "wrong_event",
        payloadKind: "ticket",
        scannedEventId: ticket.eventId,
      };
      emitResultMetric(safeMetric, result, {
        crossContextTicketCount: 0,
        crossContextVolunteer: false,
      });
      return result;
    }

    return resolveTicketBranch(deps, input, ticket, scopedLogger, safeMetric);
  }

  // ── 3. Unknown / malformed / signature_failed ───────────────────────────
  // Three-way distinction (spec §234–256):
  //   - "signature_failed" : looked like a JWT, verify rejected it.
  //   - "ticket_not_found" : ticket-code-shaped, no matching row (handled above).
  //   - "malformed"        : everything else (couldn't parse).
  const reason: ResolveScanPayloadUnknownResult["reason"] =
    signatureFailed && JWT_SHAPE_PATTERN.test(input.raw.trim())
      ? "signature_failed"
      : "malformed";
  const result: ResolveScanPayloadUnknownResult = {
    kind: "unknown",
    reason,
  };
  emitResultMetric(safeMetric, result, {
    crossContextTicketCount: 0,
    crossContextVolunteer: false,
  });
  // Never log the raw payload (FR-007b).
  scopedLogger?.warn("scan.resolve.unknown", {
    eventId: input.eventId,
    payloadLength: input.raw.length,
    reason,
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Volunteer branch
// ─────────────────────────────────────────────────────────────────────────────

async function resolveVolunteerBranch(
  deps: ResolveScanPayloadDeps,
  input: ResolveScanPayloadInput,
  humanId: string,
  logger: LoggerPort | undefined,
  safeMetric: SafeMetric,
): Promise<ResolveScanPayloadVolunteerResult> {
  // Reuse the volunteering use case for eligible-signup logic. It enforces
  // its own RBAC (ORG_SCAN_ROLES post-relaxation) and returns sanitized
  // candidates. We pass the same actor + event.
  const candidates = await getVolunteerContextForTicketScan(
    {
      repos: deps.repos,
      authz: deps.authz,
      clock: deps.clock,
      logger,
      volunteerScanToken: deps.volunteerScanToken,
    },
    {
      actorHumanId: input.actorHumanId,
      eventId: input.eventId,
      humanId,
    },
  );

  // A volunteer token NAMES a human; it does not establish that the bearer
  // IS that human. It is a stateless bearer artifact that now legitimately
  // lives on paper (a volunteer may mint a printable QR for their own
  // signup), so a lost or photographed sheet reaches this branch in
  // somebody else's hands.
  //
  // `candidates` is the live authorization re-read: a volunteer who has
  // withdrawn, been rejected, or otherwise lost eligibility since the token
  // was minted resolves to zero of them. When that read says the bearer has
  // no standing at this event, we do NOT go looking for their tickets —
  // otherwise a stale token still hands the operator the human's raw
  // `ticketCode` values with a one-tap admit beside them, which is a strictly
  // worse disclosure than the "no eligible signups" the volunteer section
  // is simultaneously reporting.
  //
  // Cross-context enrichment is a convenience for a volunteer who IS
  // checking in; it is not a ticket-lookup endpoint keyed on a QR.
  //
  // B2 (account squatting through guest checkout): guest checkout, comps and
  // door sales attach tickets BY EMAIL, so an unverified account may hold
  // someone else's tickets. Its volunteer QR must not put those codes, and a
  // one-tap admit, in front of the operator. The emailed ticket still scans.
  // A failed identity read propagates (nothing is swallowed).
  let alsoHoldsTicket: ResolveScanPayloadAlsoHoldsTicket[] = [];
  const holderEmailVerified =
    candidates.length > 0 &&
    (await deps.repos.humans.getByIdWithIdentity(humanId))?.identity
      .emailVerified === true;
  if (holderEmailVerified) {
    const ticketsForHuman = await deps.repos.tickets.findByEventAndHuman(
      input.eventId,
      humanId,
    );
    // FR-006: surface only VALID + SCANNED tickets to the operator UI. The
    // adapter returns all statuses; we narrow here so the result type stays
    // honest (`status: "VALID" | "SCANNED"`).
    alsoHoldsTicket = ticketsForHuman
      .filter((t): t is typeof t & { status: "VALID" | "SCANNED" } =>
        (ALSO_HOLDS_TICKET_STATUSES as Set<string>).has(t.status),
      )
      .map((t) => ({
        ticketId: t.ticketId,
        ticketCode: t.ticketCode,
        status: t.status,
        scannedAt: t.scannedAt,
      }));
  }

  // Resolve a "First L." display name without echoing PII. Prefer the
  // candidate's already-sanitized display name (it's just `human.name`
  // on the volunteer side; we still strip to first + last initial).
  const candidateName = candidates[0]?.humanDisplayName ?? null;
  const displayName = sanitizeDisplayName(candidateName) ?? "Unknown";

  const result: ResolveScanPayloadVolunteerResult = {
    kind: "volunteer",
    humanId,
    displayName,
    candidates,
    alsoHoldsTicket,
  };
  emitResultMetric(safeMetric, result, {
    crossContextTicketCount: alsoHoldsTicket.length,
    crossContextVolunteer: false,
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ticket branch
// ─────────────────────────────────────────────────────────────────────────────

async function resolveTicketBranch(
  deps: ResolveScanPayloadDeps,
  input: ResolveScanPayloadInput,
  ticket: NonNullable<Awaited<ReturnType<Repos["tickets"]["getByCode"]>>>,
  logger: LoggerPort | undefined,
  safeMetric: SafeMetric,
): Promise<ResolveScanPayloadTicketResult> {
  // Cross-context enrichment: does the ticket owner also have an eligible
  // volunteer signup? Reuse the volunteering use case (same RBAC, same
  // sanitized candidate shape).
  let alsoVolunteering: VolunteerCheckInCandidate[] = [];
  try {
    alsoVolunteering = await getVolunteerContextForTicketScan(
      {
        repos: deps.repos,
        authz: deps.authz,
        clock: deps.clock,
        logger,
        volunteerScanToken: deps.volunteerScanToken,
      },
      {
        actorHumanId: input.actorHumanId,
        eventId: input.eventId,
        humanId: ticket.ownerHumanId,
      },
    );
  } catch (err) {
    // Enrichment is non-blocking. Log and continue with empty list.
    logger?.warn("scan.resolve.volunteer_enrichment_failed", {
      eventId: input.eventId,
      reason: describeReason(err),
    });
    alsoVolunteering = [];
  }

  const [ownerName, ticketType] = await Promise.all([
    loadOwnerDisplayName(deps, ticket.ownerHumanId),
    ticket.ticketTypeId
      ? deps.repos.tickets
          .getTicketTypeById(ticket.ticketTypeId)
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  const holderDisplay = sanitizeDisplayName(ownerName) ?? "Unknown";

  const result: ResolveScanPayloadTicketResult = {
    kind: "ticket",
    ticketId: ticket.id,
    ticketCode: ticket.code,
    status: ticket.status,
    scannedAt: ticket.scannedAt,
    holderHumanId: ticket.ownerHumanId,
    holderDisplay,
    ticketTypeName: ticketType?.name ?? null,
    alsoVolunteering,
  };
  emitResultMetric(safeMetric, result, {
    crossContextTicketCount: 0,
    crossContextVolunteer: alsoVolunteering.length > 0,
  });
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function loadOwnerDisplayName(
  deps: ResolveScanPayloadDeps,
  humanId: string,
): Promise<string | null> {
  try {
    const human = await deps.repos.humans.getById(humanId);
    return human?.name ?? null;
  } catch {
    return null;
  }
}

/**
 * Reduce a full name to "First L." Returns null when no usable input.
 * Examples:
 *   "Jenny Rosen"         → "Jenny R."
 *   "Jenny Marie Rosen"   → "Jenny R."   (last token is the surname)
 *   "Jenny"               → "Jenny"
 *   ""  / null            → null
 */
export function sanitizeDisplayName(
  name: string | null | undefined,
): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) return tokens[0] ?? null;
  const first = tokens[0] ?? "";
  const last = tokens[tokens.length - 1] ?? "";
  const initial = last.charAt(0).toUpperCase();
  return `${first} ${initial}.`;
}

type SafeMetric = (name: string, tags?: Record<string, string>) => void;

/**
 * Build an isolation wrapper around `metrics.increment`. A failing metrics
 * backend MUST NOT bubble out of the resolver; we degrade to a debug log
 * and continue. Returns a no-op when no metrics port is configured.
 */
function makeSafeMetric(
  metrics: MetricsPort | undefined,
  logger: LoggerPort | undefined,
): SafeMetric {
  if (!metrics) return () => {};
  return (name, tags) => {
    try {
      metrics.increment(name, tags);
    } catch (err) {
      logger?.log("debug", "scan.resolve.metrics_failed", {
        metric: name,
        reason: describeReason(err),
      });
    }
  };
}

function emitResultMetric(
  safeMetric: SafeMetric,
  result: ResolveScanPayloadOutput,
  flags: {
    /**
     * Number of admit-eligible tickets the volunteer also holds. We emit
     * this as a tag (`crossContextTicketCount`) — bucketed via a derived
     * boolean to keep tag cardinality bounded — instead of the original
     * boolean `crossContextTicket`, so the operator dashboards can tell
     * "had at least one ticket" apart from "had none".
     */
    crossContextTicketCount: number;
    crossContextVolunteer: boolean;
  },
): void {
  const tags: Record<string, string> = { kind: result.kind };
  if (result.kind === "wrong_event") {
    tags.payloadKind = result.payloadKind;
  }
  if (result.kind === "unknown") {
    tags.reason = result.reason;
  }
  // Tag with the raw count when 0–3 (low cardinality), bucket "many" above.
  // The boolean `crossContextTicket` flag is kept for dashboards that
  // already filter on it; `crossContextTicketCount` is the source of truth.
  tags.crossContextTicket =
    flags.crossContextTicketCount > 0 ? "true" : "false";
  tags.crossContextTicketCount =
    flags.crossContextTicketCount <= 3
      ? String(flags.crossContextTicketCount)
      : "many";
  tags.crossContextVolunteer = flags.crossContextVolunteer ? "true" : "false";
  safeMetric("scan.resolve.result", tags);
}

function describeReason(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) {
    return String((err as { code?: unknown }).code ?? "unknown");
  }
  return "unknown";
}

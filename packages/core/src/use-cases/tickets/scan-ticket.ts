import { z } from "zod";

import { haversineDistance } from "../../lib/geo";
import { asKnownError } from "../../lib/errors";
import { describeError, parseInput } from "../../lib/io";
import { ORG_SCAN_ROLES, requireScannerAccessOnOrg } from "../../lib/rbac";
import type { AuthZPort } from "@th/ports/authz";
import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { MetricsPort } from "@th/ports/metric";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos, TxRepos } from "@th/ports/repos";
import type { OrgRole } from "@th/ports/repos/authz";
import type { EventRecord, EventStatus } from "@th/ports/repos/events";
import { fail } from "@th/errors";
import type {
  RecordTicketScanInput,
  TicketRecord,
  TicketScanOutcome,
  TicketStatus,
} from "@th/ports/repos/tickets";

const IDEMPOTENCY_TTL_SECONDS = 10;
const IDEMPOTENCY_TIME_BUCKET_MS = 2_000;

// Operators routinely open admission an hour before doors. We mirror the
// volunteer scan-window grace (60 min before/after) on the ticket side so
// early arrivals don't get rejected.
const EVENT_START_GRACE_MS = 60 * 60 * 1000;
const EVENT_END_GRACE_MS = 60 * 60 * 1000;
const SUSPICIOUS_DISTANCE_KM = 1.0;

type ScanPermission = {
  scope: "org" | "human";
  role: OrgRole;
};

type EventScanState = "ok" | "inactive_status" | "not_started" | "ended";

const locationSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
  })
  .strict();

export const scanTicketInputSchema = z
  .object({
    actorHumanId: z.uuid(),
    eventId: z.uuid(),
    // Trim only. The code is a bearer credential looked up against a
    // case-sensitive unique column, and real codes are lowercase
    // (`generateTicketCode()` → `tk_<lowercase hex>`), so the old
    // `.toUpperCase()` transform turned every scan into `ticket_not_found`.
    // Case tolerance for hand-typed codes lives in `tickets.getByCode`.
    //
    // The charset mirrors `TICKET_CODE_PATTERN` in
    // `../scanning/resolve-scan-payload.ts`. Defence in depth: this is the
    // procedure that actually BURNS a ticket, and it is reachable directly —
    // not only via the resolver — so without this it was the one door to
    // `getByCode` with no charset gate at all. That matters because the repo's
    // miss-path folds with Postgres `lower()`, which applies per-character
    // simple-lowercase mappings (U+212A KELVIN SIGN → `k`); keeping arbitrary
    // Unicode out of that fold costs nothing and removes a whole question.
    ticketCode: z
      .string()
      .trim()
      .min(6)
      .max(64)
      .regex(/^[A-Za-z0-9_-]{6,64}$/),
    location: locationSchema.optional(),
    // Free text, so it cannot take `ticketCode`'s allowlist — but it reaches TWO
    // columns Postgres will reject bad bytes in: the audit row's `jsonb` and
    // `TicketScan.message` (text). `trim()` removes neither of the offenders.
    //
    // Two distinct triggers, both measured or traced:
    //   NUL (and other C0/C1 controls) → 22P05 in jsonb, and rejected in text.
    //   A LONE surrogate → `JSON.stringify` emits it literally and Postgres's
    //     JSON parser rejects it ("low surrogate must follow a high surrogate").
    // `\p{Surrogate}` under /u matches only UNPAIRED surrogates — a valid pair
    // is one code point and is left alone, so emoji survive.
    //
    // This is not merely defence in depth: `recordScanAttempt` writes `message`
    // INSIDE the transaction, so for that column the strip is the only guard.
    // (CR is stripped with the other controls, so CRLF collapses to LF.)
    // eslint-disable-next-line no-control-regex
    note: z
      .string()
      .transform((value) =>
        value
          .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
          .replace(/\p{Surrogate}/gu, ""),
      )
      .pipe(z.string().trim().max(240))
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    // A machine-generated correlation id, not prose — so it takes an allowlist
    // rather than a strip. It becomes part of the idempotency KEY, which under
    // `IDEMPOTENCY_BACKEND=postgres` is a text primary key that rejects a NUL.
    // That path is fail-closed (it throws before the transaction opens), but
    // this is the same charset gap `note` just had, on the same procedure.
    clientKey: z
      .string()
      .regex(/^[A-Za-z0-9_.:-]*$/)
      .trim()
      .max(128)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
  })
  .strict();

export const scanTicketOutputSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("ACCEPTED"),
      ticketId: z.uuid(),
      eventId: z.uuid(),
      ownerHumanId: z.uuid(),
      scannedAt: z.date(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("REPLAY"),
      ticketId: z.uuid(),
      eventId: z.uuid(),
      ownerHumanId: z.uuid(),
      scannedAt: z.date(),
      previousScannedAt: z.date(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("REJECTED"),
      reason: z.enum([
        "ticket_not_found",
        "event_not_active",
        "event_mismatch",
        "ticket_not_valid",
      ]),
    })
    .strict(),
]);

export type ScanTicketInput = z.infer<typeof scanTicketInputSchema>;
export type ScanTicketOutput = z.infer<typeof scanTicketOutputSchema>;

export type ScanTicketDeps = {
  repos: Repos;
  authz: Pick<AuthZPort, "hasStaffRole">;
  idempotency: IdempotencyPort;
  clock: ClockPort;
  logger?: LoggerPort;
  metrics?: MetricsPort;
  /**
   * The audit write below is a deliberate swallow, so per the project error
   * convention it has to reach Sentry explicitly rather than ride a log line.
   */
  reportError?: ReporterPort;
};

/** What the scan decided, held until the scan's transaction has COMMITTED. */
type ScanAuditIntent = {
  ticket: TicketRecord | null;
  actorHumanId: string;
  actorRole: OrgRole;
  event: EventRecord;
  when: Date;
  outcome: TicketScanOutcome;
  reason: string | null;
  locationLat: number | null;
  locationLng: number | null;
  distanceKm: number | null;
};

interface NormalizedScanTicketInput {
  actorHumanId: string;
  eventId: string;
  ticketCode: string;
  locationLat: number | null;
  locationLng: number | null;
  note: string | null;
  clientKey: string | null;
}

interface StoredScanTicketRecord {
  payloadHash: string;
  response: ScanTicketOutput;
}

export async function scanTicket(
  deps: ScanTicketDeps,
  rawInput: unknown,
): Promise<ScanTicketOutput> {
  const scopedLogger = deps.logger?.child({ useCase: "scanTicket" });
  let normalized: NormalizedScanTicketInput | null = null;
  let metricTags: Record<string, string> | null = null;
  let durationTags: Record<string, string> | null = null;
  let callStartedAt: Date | null = null;

  const execute = async () => {
    callStartedAt = deps.clock.now();
    const input = parseInput(scanTicketInputSchema, rawInput);
    if (input.clientKey && input.clientKey.length < 6) {
      throw fail("CLIENT_KEY_TOO_SHORT");
    }

    normalized = normalizeInput(input);
    const keyTimestamp = callStartedAt ?? deps.clock.now();
    const resolvedClientKey = resolveClientKey(normalized, keyTimestamp);
    const payloadHash = buildPayloadHash(normalized, resolvedClientKey);
    const idempotencyKey = buildIdempotencyKey(
      normalized.eventId,
      normalized.ticketCode,
      resolvedClientKey,
    );

    const finalizeMetrics = (result: ScanTicketOutput) => {
      const tags = buildMetricTags(normalized!.eventId, result);
      metricTags = tags;
      durationTags = { ...tags };
      deps.metrics?.increment("ticket.scan", tags);
      return result;
    };

    const cached =
      await deps.idempotency.get<StoredScanTicketRecord>(idempotencyKey);
    if (cached) {
      if (cached.payloadHash !== payloadHash) {
        scopedLogger?.warn("scanTicket.idempotency_conflict", {
          idempotencyKey,
          eventId: normalized.eventId,
          ticketCode: normalized.ticketCode,
          phase: "cache",
        });
        throw fail("IDEMPOTENCY_KEY_CONFLICT");
      }
      return finalizeMetrics(cached.response);
    }

    const claimed = await deps.idempotency.begin(
      idempotencyKey,
      IDEMPOTENCY_TTL_SECONDS,
    );
    if (!claimed) {
      const replay =
        await deps.idempotency.get<StoredScanTicketRecord>(idempotencyKey);
      if (replay) {
        if (replay.payloadHash !== payloadHash) {
          scopedLogger?.warn("scanTicket.idempotency_conflict", {
            idempotencyKey,
            eventId: normalized.eventId,
            ticketCode: normalized.ticketCode,
            phase: "replay",
          });
          throw fail("IDEMPOTENCY_KEY_CONFLICT");
        }
        return finalizeMetrics(replay.response);
      }
      throw fail("IDEMPOTENCY_LOCK_IN_PROGRESS");
    }

    try {
      const result = await scanTicketInternal(deps, scopedLogger, normalized);
      const parsed = scanTicketOutputSchema.parse(result);
      await deps.idempotency.commit<StoredScanTicketRecord>(idempotencyKey, {
        payloadHash,
        response: parsed,
      });
      return finalizeMetrics(parsed);
    } catch (error) {
      durationTags = normalized
        ? { eventId: normalized.eventId, outcome: "error" }
        : { outcome: "error" };
      scopedLogger?.warn("scanTicket.failed", { error: describeError(error) });
      await deps.idempotency.fail(idempotencyKey, describeError(error));
      throw asKnownError("scan_ticket", error);
    }
  };

  try {
    return scopedLogger
      ? await scopedLogger.withTime("scanTicket", execute)
      : await execute();
  } finally {
    const startedAt = callStartedAt;
    const tags = durationTags;
    const normalizedInput = normalized;
    if (startedAt !== null && normalizedInput !== null) {
      const startTime = startedAt as Date;
      const normalizedValue = normalizedInput as NormalizedScanTicketInput;
      const elapsedMs = deps.clock.now().getTime() - startTime.getTime();
      if (elapsedMs >= 0) {
        const recordTags: Record<string, string> = tags ?? {
          eventId: normalizedValue.eventId,
          outcome: "unknown",
        };
        deps.metrics?.record("ticket.scan.duration_ms", elapsedMs, recordTags);
      }
    }
  }
}

async function scanTicketInternal(
  deps: ScanTicketDeps,
  logger: LoggerPort | undefined,
  input: NormalizedScanTicketInput,
): Promise<ScanTicketOutput> {
  const now = deps.clock.now();

  // Held in a CONTAINER, not a bare `let`. TypeScript does not track
  // assignments made inside a nested function, so a `let … | null = null`
  // mutated in the tx callback is narrowed to `null` at every later use — and
  // `if (x)` then narrows it to `never`, which is assignable to any parameter
  // type, silently disabling the type check on the call it guards.
  const pending: { audit: ScanAuditIntent | null } = { audit: null };

  const outcome = await deps.repos.tx(async (tx) => {
    const event = await tx.events.getById(input.eventId);
    if (!event) {
      throw fail("EVENT_NOT_FOUND");
    }

    const permission = await ensureActorCanScan(
      tx,
      deps.authz,
      input.actorHumanId,
      event,
    );
    const distanceKm = computeDistanceKm(event, input);
    const scanState = evaluateEventScanState(event, now);

    if (distanceKm !== null && distanceKm > SUSPICIOUS_DISTANCE_KM) {
      logger?.warn("scanTicket.suspicious_location", {
        eventId: event.id,
        actorHumanId: input.actorHumanId,
        distanceKm,
      });
      deps.metrics?.increment("ticket.scan.suspicious_location", {
        eventId: event.id,
        bucket: bucketizeDistance(distanceKm),
      });
    }

    if (scanState !== "ok") {
      let auditReason: string;
      switch (scanState) {
        case "not_started":
          auditReason = "event_not_active:not_started";
          break;
        case "ended":
          auditReason = "event_not_active:event_ended";
          break;
        default:
          auditReason = "event_not_active";
      }
      pending.audit = {
        ticket: null,
        actorHumanId: input.actorHumanId,
        actorRole: permission.role,
        event,
        when: now,
        outcome: "REJECTED",
        reason: auditReason,
        locationLat: input.locationLat,
        locationLng: input.locationLng,
        distanceKm,
      };
      return { outcome: "REJECTED", reason: "event_not_active" } as const;
    }

    const ticket = await tx.tickets.getByCode(input.ticketCode);
    if (!ticket) {
      pending.audit = {
        ticket: null,
        actorHumanId: input.actorHumanId,
        actorRole: permission.role,
        event,
        when: now,
        outcome: "REJECTED",
        reason: "ticket_not_found",
        locationLat: input.locationLat,
        locationLng: input.locationLng,
        distanceKm,
      };
      return { outcome: "REJECTED", reason: "ticket_not_found" } as const;
    }

    if (ticket.eventId !== event.id) {
      await recordScanAttempt(
        tx,
        ticket,
        input,
        now,
        "REJECTED",
        "event_mismatch",
      );
      pending.audit = {
        ticket,
        actorHumanId: input.actorHumanId,
        actorRole: permission.role,
        event,
        when: now,
        outcome: "REJECTED",
        reason: "event_mismatch",
        locationLat: input.locationLat,
        locationLng: input.locationLng,
        distanceKm,
      };
      return { outcome: "REJECTED", reason: "event_mismatch" } as const;
    }

    if (ticket.status === "SCANNED") {
      const persisted =
        ticket.scannedAt ??
        (await tx.tickets.getByCode(ticket.code))?.scannedAt ??
        ticket.scannedAt;
      await recordScanAttempt(
        tx,
        ticket,
        input,
        now,
        "REPLAY",
        input.note ?? "already_scanned",
      );
      pending.audit = {
        ticket,
        actorHumanId: input.actorHumanId,
        actorRole: permission.role,
        event,
        when: now,
        outcome: "REPLAY",
        reason: "already_scanned",
        locationLat: input.locationLat,
        locationLng: input.locationLng,
        distanceKm,
      };
      const reference = persisted ?? now;
      return {
        outcome: "REPLAY",
        ticketId: ticket.id,
        eventId: ticket.eventId,
        ownerHumanId: ticket.ownerHumanId,
        scannedAt: reference,
        previousScannedAt: reference,
      } as const;
    }

    if (!isTicketScannable(ticket.status)) {
      await recordScanAttempt(
        tx,
        ticket,
        input,
        now,
        "REJECTED",
        "ticket_not_valid",
      );
      pending.audit = {
        ticket,
        actorHumanId: input.actorHumanId,
        actorRole: permission.role,
        event,
        when: now,
        outcome: "REJECTED",
        reason: "ticket_not_valid",
        locationLat: input.locationLat,
        locationLng: input.locationLng,
        distanceKm,
      };
      return { outcome: "REJECTED", reason: "ticket_not_valid" } as const;
    }

    const mark = await tx.tickets.markScanned(ticket.code, now);
    if (!mark.ok) {
      if (mark.reason === "not_found") {
        await recordScanAttempt(
          tx,
          ticket,
          input,
          now,
          "REJECTED",
          "ticket_not_found",
        );
        pending.audit = {
          ticket,
          actorHumanId: input.actorHumanId,
          actorRole: permission.role,
          event,
          when: now,
          outcome: "REJECTED",
          reason: "ticket_not_found",
          locationLat: input.locationLat,
          locationLng: input.locationLng,
          distanceKm,
        };
        return { outcome: "REJECTED", reason: "ticket_not_found" } as const;
      }

      const latest = await tx.tickets.getByCode(ticket.code);
      const persisted =
        latest?.scannedAt ?? mark.scannedAt ?? ticket.scannedAt ?? now;
      await recordScanAttempt(
        tx,
        ticket,
        input,
        now,
        "REPLAY",
        input.note ?? "already_scanned",
      );
      pending.audit = {
        ticket: latest ?? ticket,
        actorHumanId: input.actorHumanId,
        actorRole: permission.role,
        event,
        when: now,
        outcome: "REPLAY",
        reason: "already_scanned",
        locationLat: input.locationLat,
        locationLng: input.locationLng,
        distanceKm,
      };
      return {
        outcome: "REPLAY",
        ticketId: ticket.id,
        eventId: ticket.eventId,
        ownerHumanId: ticket.ownerHumanId,
        scannedAt: persisted,
        previousScannedAt: persisted,
      } as const;
    }

    ticket.status = "SCANNED";
    ticket.scannedAt = mark.scannedAt;

    await recordScanAttempt(
      tx,
      ticket,
      input,
      mark.scannedAt,
      "ACCEPTED",
      input.note,
    );
    pending.audit = {
      ticket,
      actorHumanId: input.actorHumanId,
      actorRole: permission.role,
      event,
      when: mark.scannedAt,
      outcome: "ACCEPTED",
      reason: input.note ?? null,
      locationLat: input.locationLat,
      locationLng: input.locationLng,
      distanceKm,
    };

    return {
      outcome: "ACCEPTED",
      ticketId: ticket.id,
      eventId: ticket.eventId,
      ownerHumanId: ticket.ownerHumanId,
      scannedAt: mark.scannedAt,
    } as const;
  });

  // POST-COMMIT. The scan is durable before the audit row is attempted, so an
  // audit failure can no longer discard the ticket burn. See `recordScanAudit`.
  if (pending.audit) {
    await recordScanAudit(deps, logger, pending.audit);
  }

  return outcome;
}

function normalizeInput(input: ScanTicketInput): NormalizedScanTicketInput {
  return {
    actorHumanId: input.actorHumanId,
    eventId: input.eventId,
    ticketCode: input.ticketCode,
    locationLat: input.location?.lat ?? null,
    locationLng: input.location?.lng ?? null,
    note: input.note ?? null,
    clientKey: input.clientKey ?? null,
  };
}

function buildPayloadHash(
  input: NormalizedScanTicketInput,
  resolvedClientKey: string,
): string {
  return JSON.stringify({
    actorHumanId: input.actorHumanId,
    eventId: input.eventId,
    ticketCode: input.ticketCode,
    locationLat: input.locationLat,
    locationLng: input.locationLng,
    note: input.note,
    clientKey: input.clientKey,
    resolvedClientKey,
  });
}

/**
 * The `ticketCode` component is now the caller's verbatim string (it used to be
 * upper-cased). That is safe:
 *
 *  - This key only dedupes *identical* retries inside a 10s TTL / 2s time
 *    bucket. An identical retry sends an identical string, so it still lands on
 *    the same key.
 *  - Case variants of one code now produce two keys instead of one, so two
 *    near-simultaneous scans of the same ticket typed with different case can
 *    both get past idempotency. That changes nothing: double-scan protection is
 *    enforced in the database by `markScanned`'s conditional
 *    `updateMany({ code, status: "VALID" })`, which is atomic — the loser sees
 *    `count === 0` and returns REPLAY. The key is an optimisation, not the
 *    invariant.
 *  - Nothing persists these keys across deploys (10s TTL), so there is no
 *    old-format/new-format collision window to manage.
 */
function buildIdempotencyKey(
  eventId: string,
  ticketCode: string,
  clientKey: string,
): string {
  return `ticket:scan:${eventId}:${ticketCode}:${clientKey}`;
}

function resolveClientKey(input: NormalizedScanTicketInput, now: Date): string {
  if (input.clientKey) {
    return input.clientKey;
  }
  return `bucket:${Math.floor(now.getTime() / IDEMPOTENCY_TIME_BUCKET_MS)}`;
}

function buildMetricTags(
  eventId: string,
  result: ScanTicketOutput,
): Record<string, string> {
  const tags: Record<string, string> = { eventId, outcome: result.outcome };
  if (result.outcome === "REJECTED") {
    tags.reason = result.reason;
  } else if (result.outcome === "REPLAY") {
    tags.reason = "already_scanned";
  }
  return tags;
}

function evaluateEventScanState(event: EventRecord, now: Date): EventScanState {
  if (!(["PUBLISHED", "COMPLETED"] as EventStatus[]).includes(event.status)) {
    return "inactive_status";
  }
  if (now.getTime() < event.startsAt.getTime() - EVENT_START_GRACE_MS) {
    return "not_started";
  }
  const eventEnd = event.endsAt ?? event.startsAt;
  if (now.getTime() > eventEnd.getTime() + EVENT_END_GRACE_MS) {
    return "ended";
  }
  return "ok";
}

function computeDistanceKm(
  event: EventRecord,
  input: NormalizedScanTicketInput,
): number | null {
  // Staff telemetry only: at a venue that withholds its address, event
  // lat/lng is the public circle centre or null, so this is approximate/null.
  if (event.lat === null || event.lng === null) {
    return null;
  }
  if (input.locationLat === null || input.locationLng === null) {
    return null;
  }
  const meters = haversineDistance(
    event.lat,
    event.lng,
    input.locationLat,
    input.locationLng,
  );
  return meters / 1000;
}

function bucketizeDistance(distanceKm: number): string {
  if (distanceKm >= 50) return "gte_50km";
  if (distanceKm >= 10) return "gte_10km";
  if (distanceKm >= 5) return "gte_5km";
  if (distanceKm >= 1) return "gte_1km";
  return "lt_1km";
}

async function ensureActorCanScan(
  tx: TxRepos,
  authz: Pick<AuthZPort, "hasStaffRole">,
  actorHumanId: string,
  event: EventRecord,
): Promise<ScanPermission> {
  if (event.orgId) {
    const access = await requireScannerAccessOnOrg({
      repos: tx,
      authz,
      orgId: event.orgId,
      actorHumanId,
      roles: ORG_SCAN_ROLES,
      errorCode: "NOT_AUTHORIZED",
    });
    return { scope: "org", role: access.role };
  }

  if (event.humanId) {
    if (event.humanId !== actorHumanId) {
      // Personal-event owner mismatch: still allow platform admins so
      // support can scan against any tenant or personal event.
      const staff = await authz.hasStaffRole({
        actorHumanId,
        requiredRoles: ["ADMIN"],
      });
      if (!staff.allowed) {
        throw fail("NOT_AUTHORIZED");
      }
    }
    return { scope: "human", role: "OWNER" };
  }

  throw fail("NOT_AUTHORIZED");
}

function isTicketScannable(status: TicketStatus): boolean {
  return status === "VALID";
}

async function recordScanAttempt(
  tx: TxRepos,
  ticket: TicketRecord,
  input: NormalizedScanTicketInput,
  scannedAt: Date,
  outcome: TicketScanOutcome,
  message: string | null,
): Promise<void> {
  const payload: RecordTicketScanInput = {
    ticketId: ticket.id,
    eventId: ticket.eventId,
    actorHumanId: input.actorHumanId,
    scannedAt,
    locationLat: input.locationLat,
    locationLng: input.locationLng,
    outcome,
    message,
  };

  await tx.tickets.recordScan(payload);
}

/**
 * Writes the scan's audit row, AFTER the scan's transaction has committed.
 *
 * It used to run INSIDE that transaction as the last statement on all eight
 * scan paths, and swallow its own failure. That combination silently discarded
 * the scan: Postgres aborts a transaction on any failed statement, answers the
 * subsequent COMMIT with ROLLBACK and NO error, and Prisma does not surface it
 * — so `tx.tickets.markScanned` was rolled back while the callback still
 * returned ACCEPTED. The scanner showed green, the ticket stayed VALID, and the
 * same QR admitted again. Measured, not theorised (2026-09-04).
 *
 * Post-commit, the swallow is honest: the ticket is burned before this runs, so
 * losing an audit row costs an audit row. That is the right trade at a door —
 * an audit hiccup must not deny entry, and must not silently grant it either.
 *
 * Takes the full `Repos` bag, NOT `TxRepos`. `TxRepos = Omit<Repos, "tx">`, so
 * handing it a transaction handle is a compile error rather than a regression.
 */
async function recordScanAudit(
  deps: Pick<ScanTicketDeps, "repos" | "reportError">,
  logger: LoggerPort | undefined,
  input: ScanAuditIntent,
): Promise<void> {
  const data: Record<string, unknown> = {
    actorHumanId: input.actorHumanId,
    actorRole: input.actorRole,
    outcome: input.outcome,
    reason: input.reason,
    eventId: input.event.id,
  };
  if (input.locationLat !== null && input.locationLng !== null) {
    data.location = { lat: input.locationLat, lng: input.locationLng };
  }
  if (input.distanceKm !== null) {
    data.distanceKm = input.distanceKm;
  }

  try {
    await deps.repos.audit.log({
      entity: "ticket",
      entityId: input.ticket?.id ?? null,
      action: `scan.${input.outcome.toLowerCase()}`,
      data,
      at: input.when,
    });
  } catch (error) {
    // Guarded so a throwing reporter cannot manufacture a new failure out of a
    // swallowed one.
    try {
      deps.reportError?.(error, {
        tags: { useCase: "scanTicket", stage: "record_scan_audit" },
        extra: {
          eventId: input.event.id,
          ticketId: input.ticket?.id ?? null,
          outcome: input.outcome,
        },
      });
    } catch {
      // ignored on purpose
    }
    logger?.error("scanTicket.audit_failed", { error: describeError(error) });
  }
}

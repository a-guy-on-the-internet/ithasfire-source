import { z } from "zod";

import type { ClockPort } from "@th/ports/clock";
import type { IdempotencyPort } from "@th/ports/idempotency";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { Repos } from "@th/ports/repos";
import type { DisputeRecord } from "@th/ports/repos/disputes";
import type { DisputeEvidenceRecord } from "@th/ports/repos/dispute-evidence";
import type { EventRecord } from "@th/ports/repos/events";
import type { OrderRecord, OrderTaxLineRecord } from "@th/ports/repos/orders";
import type { PayeeLedgerEntryRecord } from "@th/ports/repos/payee-ledger";
import type {
  TicketRecord,
  TicketScanRecord,
} from "@th/ports/repos/tickets";
import type { DisputeEvidenceSources } from "@th/types/repos/disputes";
import {
  checkDisputeEvidenceLimits,
  DISPUTE_EVIDENCE_COMBINED_MAX_CHARS,
  DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS,
  type DisputeEvidenceFields,
} from "@th/ports/dispute-evidence";
import { fail } from "@th/errors";

import { describeError, parseInput } from "../../../lib/io";
import { isActiveHolderOrderStatus } from "../../../lib/location/holder-eligibility";
import { resolveHolderAddress } from "../../../lib/location/resolve-holder-address";
import { venueConfirmationArm } from "../../../lib/venue-confirmation";
import { computeExpectedPaymentAmount } from "../../../lib/orders/compute-expected-payment-amount";
import { withDisputeEvidenceMutex } from "./_shared/evidence-mutex";
import {
  disputeEvidenceRecordSchema,
  emptyDisputeEvidenceSources,
} from "./schemas";

// ─────────────────────────────────────────────────────────────────────────────
// assembleDisputeEvidence — builds the chargeback evidence package for a
// linked dispute from what we already persist about the order, and stores it
// as a DRAFT for ops to review. TEXT ONLY in v1: no PDF/receipt generation,
// file-id slots stay unset.
//
// Callers: the `charge.dispute.created` webhook (first assembly, never
// forced), the jobs deadline sweep (`sweep-dispute-evidence-deadlines.ts`,
// heals disputes that reached the desk without a package, never forced),
// and the staff desk (`platform.disputes.assemble`, may force).
//
// Idempotent: a second run without `force` returns the stored package
// unchanged; `force` re-assembles (new DRAFT, version bump) unless the
// package was already SUBMITTED, which is terminal — a submitted package is
// the record of what the bank saw and is never overwritten.
//
// EVERY run holds the per-dispute mutex (`_shared/evidence-mutex.ts`) from
// before the existence check through the draft write. Without it a slow
// webhook assembly could read "no package", gather for seconds while ops
// assembled + approved from the desk, then `upsertDraft` over the APPROVED
// row — resetting it to DRAFT v2 and clearing the reviewer. Under the lock
// the non-forced path is create-only: the existence check is re-read inside
// the lock and an existing row is returned untouched.
//
// Reads happen OUTSIDE the transaction: this runs on the webhook path, and
// a dozen lookups inside an interactive tx is how a 30 s timeout turns into
// "no package at all". Only `upsertDraft` + the audit row are transactional.
//
// Every source is recorded in `sources` (found / missing / not_applicable)
// so the desk can show ops what is thin BEFORE they hit submit. A missing
// source never becomes `""` in a field: Stripe treats a posted empty string
// as "unset this field", so absent data stays an absent key.
//
// The desk must ALWAYS have something editable: every text field is bounded
// to the processor's caps, and if full assembly still fails for any reason a
// MINIMAL draft (order id, amount, merchant-of-record statement, every other
// source marked missing) is persisted and the failure reported.
// ─────────────────────────────────────────────────────────────────────────────

export const MERCHANT_OF_RECORD_STATEMENT =
  "Ithas Fire is the merchant of record for this charge: the buyer purchased through the Ithas Fire platform, which collected the payment on behalf of the event organizer.";

const TRUNCATION_MARKER = "\n[truncated]";

/** Most-recent scans kept in the access log for a very large order. */
export const DISPUTE_EVIDENCE_MAX_SCAN_LINES = 200;

export const assembleDisputeEvidenceInputSchema = z
  .object({
    disputeId: z.string().min(1),
    /** Re-assemble an existing DRAFT/APPROVED/SUBMIT_FAILED package. */
    force: z.boolean().optional().default(false),
  })
  .strict();

export const assembleDisputeEvidenceOutputSchema = z
  .object({
    ok: z.literal(true),
    disputeId: z.string().min(1),
    /** Null when a package was (re-)assembled on this call. */
    skipped: z
      .enum(["unlinked", "already_assembled", "already_submitted"])
      .nullable(),
    evidence: disputeEvidenceRecordSchema.nullable(),
    /**
     * True when full assembly failed and the stored package is the minimal
     * fallback draft (see module doc). Ops must fill it in by hand.
     */
    fallback: z.boolean(),
  })
  .strict();

export type AssembleDisputeEvidenceInput = z.infer<
  typeof assembleDisputeEvidenceInputSchema
>;
export type AssembleDisputeEvidenceOutput = z.infer<
  typeof assembleDisputeEvidenceOutputSchema
>;

export type AssembleDisputeEvidenceDeps = {
  repos: Pick<
    Repos,
    | "tx"
    | "disputes"
    | "disputeEvidence"
    | "orders"
    | "events"
    | "humans"
    | "organizations"
    | "places"
    | "savedLocations"
    | "tickets"
    | "payeeLedger"
    | "audit"
  >;
  clock: ClockPort;
  /** Per-dispute mutex shared with submit / edit / approve (see module doc). */
  idempotency: Pick<IdempotencyPort, "begin" | "release">;
  logger?: LoggerPort;
  /**
   * Reports the best-effort per-source lookups that are swallowed into a
   * `missing` provenance mark, and the full-assembly failure that degrades
   * to the minimal fallback draft.
   */
  reportError?: ReporterPort | null;
};

export async function assembleDisputeEvidence(
  deps: AssembleDisputeEvidenceDeps,
  rawInput: unknown,
): Promise<AssembleDisputeEvidenceOutput> {
  const input = parseInput(assembleDisputeEvidenceInputSchema, rawInput);

  const result = await withDisputeEvidenceMutex(deps, input.disputeId, () =>
    assemble(deps, input),
  );

  deps.logger?.info("dispute.evidence.assembled", {
    disputeId: input.disputeId,
    skipped: result.skipped,
    fallback: result.fallback,
    assembledVersion: result.evidence?.assembledVersion ?? null,
  });

  return assembleDisputeEvidenceOutputSchema.parse({
    ok: true,
    disputeId: input.disputeId,
    ...result,
  });
}

type AssembleResult = {
  skipped: AssembleDisputeEvidenceOutput["skipped"];
  evidence: DisputeEvidenceRecord | null;
  fallback: boolean;
};

/** Runs UNDER the dispute mutex — see `assembleDisputeEvidence`. */
async function assemble(
  deps: AssembleDisputeEvidenceDeps,
  input: AssembleDisputeEvidenceInput,
): Promise<AssembleResult> {
  const dispute = await deps.repos.disputes.getById(input.disputeId);
  if (!dispute) {
    throw fail("DISPUTE_NOT_FOUND", { meta: { disputeId: input.disputeId } });
  }

  // Read under the lock: nothing can appear between this check and the
  // write below, so the non-forced path is create-only by construction.
  const existing = await deps.repos.disputeEvidence.getByDisputeId(dispute.id);
  if (existing?.status === "SUBMITTED") {
    return { skipped: "already_submitted", evidence: existing, fallback: false };
  }
  if (existing && !input.force) {
    return { skipped: "already_assembled", evidence: existing, fallback: false };
  }
  if (!dispute.orderId) {
    return { skipped: "unlinked", evidence: null, fallback: false };
  }

  const order = await deps.repos.orders.getById(dispute.orderId);
  if (!order) {
    // Linked at intake, gone now — the desk should see this as unlinked
    // rather than get a half-empty package that reads as evidence.
    return { skipped: "unlinked", evidence: null, fallback: false };
  }

  const now = deps.clock.now();
  // One read per assembly, shared by the full dossier and the fallback draft.
  const taxLines = await loadPlatformTaxLines(deps, dispute, order);
  let fields: DisputeEvidenceFields;
  let sources: DisputeEvidenceSources;
  let fallback = false;
  let fallbackError: string | null = null;
  try {
    const gathered = await gatherSources(deps, dispute, order, taxLines);
    ({ fields, sources } = buildEvidenceFields(gathered, now));
    const limits = checkDisputeEvidenceLimits(fields);
    if (!limits.ok) {
      // Every field is bounded above, so this is unreachable in practice;
      // if it ever fires, fall through to the minimal draft below.
      throw new Error(
        `assembled evidence exceeds processor limits: ${JSON.stringify(limits.violations)}`,
      );
    }
  } catch (err) {
    fallback = true;
    fallbackError = describeError(err);
    ({ fields, sources } = buildFallbackFields(dispute, order, now, taxLines));
    deps.logger?.error("dispute.evidence.assembly_failed_fallback", {
      disputeId: dispute.id,
      orderId: order.id,
      error: fallbackError,
    });
    try {
      deps.reportError?.(err, {
        tags: { useCase: "assembleDisputeEvidence", stage: "fallback" },
        extra: { disputeId: dispute.id, orderId: order.id },
      });
    } catch {
      // Reporter failures never change behaviour.
    }
  }

  const combinedChars = Object.values(fields).reduce(
    (sum, v) => sum + (v?.length ?? 0),
    0,
  );

  const evidence = await deps.repos.tx(async (tx) => {
    const stored = await tx.disputeEvidence.upsertDraft({
      disputeId: dispute.id,
      fields,
      sources,
      assembledAt: now,
    });
    await tx.audit.log({
      entity: "dispute",
      entityId: dispute.id,
      action: "dispute.evidence_assembled",
      data: {
        stripeDisputeId: dispute.stripeDisputeId,
        orderId: order.id,
        assembledVersion: stored.assembledVersion,
        forced: input.force,
        fallback,
        fallbackError,
        // Provenance only — never the evidence text (PII).
        sources,
        combinedChars,
        fieldKeys: Object.keys(fields),
      },
      at: now,
    });
    return stored;
  });

  return { skipped: null, evidence, fallback };
}

// ── Source gathering (plain reads, no transaction) ───────────────────────────

type GatheredSources = {
  dispute: DisputeRecord;
  order: OrderRecord;
  /** The order's persisted PLATFORM tax lines (empty for legacy orders). */
  taxLines: ReadonlyArray<OrderTaxLineRecord>;
  event: EventRecord | null;
  buyerName: string | null;
  buyerEmail: string | null;
  organizerName: string | null;
  venueLabel: string | null;
  venueTimezone: string | null;
  ticketTypeNames: Map<string, string>;
  tickets: TicketRecord[];
  scans: TicketScanRecord[];
  refundDebits: PayeeLedgerEntryRecord[];
  scansApplicable: boolean;
};

/**
 * Each optional lookup is wrapped in `optional()`: a failing read (a
 * flaky venue lookup, say) degrades to a `missing` provenance mark for that
 * source and is reported, instead of aborting the whole package — the order
 * itself is the only source that MUST resolve.
 */
async function gatherSources(
  deps: AssembleDisputeEvidenceDeps,
  dispute: DisputeRecord,
  order: OrderRecord,
  taxLines: ReadonlyArray<OrderTaxLineRecord>,
): Promise<GatheredSources> {
  const repos = deps.repos;
  const optional = async <T>(
    source: string,
    fn: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await fn();
    } catch (err) {
      deps.logger?.error("dispute.evidence.source_lookup_failed", {
        disputeId: dispute.id,
        orderId: order.id,
        source,
        error: describeError(err),
      });
      try {
        deps.reportError?.(err, {
          tags: { useCase: "assembleDisputeEvidence", source },
          extra: { disputeId: dispute.id, orderId: order.id },
        });
      } catch {
        // Reporter failures never change behaviour.
      }
      return null;
    }
  };

  const isMembership = order.kind === "MEMBERSHIP";

  const event = order.eventId
    ? await optional("event", () => repos.events.getById(order.eventId!))
    : null;

  const buyer = await optional("buyer", () =>
    repos.humans.getByIdWithIdentity(order.buyerHumanId),
  );
  const buyerFallback = buyer
    ? null
    : await optional("buyer", () => repos.humans.getById(order.buyerHumanId));
  const buyerName = buyer?.human.name ?? buyerFallback?.name ?? null;
  const buyerEmail = buyer?.identity.email ?? null;

  // Organizer: the event's owner for ticketing; the dispute's denormalised
  // owner (resolved from the order's payee at intake) for memberships.
  const orgId = event?.orgId ?? dispute.ownerOrgId ?? null;
  const humanOwnerId = event?.humanId ?? dispute.ownerHumanId ?? null;
  const organizerName = orgId
    ? ((await optional("organizer", () => repos.organizations.getById(orgId)))
        ?.name ?? null)
    : humanOwnerId
      ? ((await optional("organizer", () => repos.humans.getById(humanOwnerId)))
          ?.name ?? null)
      : null;

  // Venue: Place → SavedLocation → the event's freeform address text — but
  // ONLY when the buyer would see that address themselves right now.
  //
  // Evidence leaves the platform: Stripe forwards it to the cardholder's
  // bank, and the bank can show it to the cardholder. So it is gated exactly
  // like a ticket holder's own surfaces (`resolveHolderAddress`): the true
  // address (and the venue's name, a de-facto address) only once revealed,
  // never for NEVER — "nobody gets this address through Ithas Fire" — and,
  // at a venue that withholds its address, only when the venue vouched for
  // the event. The cardholder is the buyer, so it also goes only to a buyer
  // who would see it on their own order page: a paid (or disputed) order
  // and a ticket still held. Otherwise the evidence names only the coarse
  // area label the public already sees. A venue or ticket read that fails
  // fails closed the same way.
  let venueLabel: string | null = null;
  let venueTimezone: string | null = null;
  const place = event?.placeId
    ? await optional("venue", () => repos.places.getById(event.placeId!))
    : null;
  const buyerHoldsTicket =
    event !== null &&
    isActiveHolderOrderStatus(order.status) &&
    (await optional("tickets", () =>
      repos.tickets.hasActiveTicketForEvent(event.id, order.buyerHumanId),
    )) === true;
  const holderAddress = event
    ? resolveHolderAddress({
        event,
        place,
        venueConfirmationArm: venueConfirmationArm(event, place),
        activeHolder: buyerHoldsTicket,
        actOnBill: false,
        now: deps.clock.now(),
      })
    : null;
  if (holderAddress?.locked) {
    venueLabel = holderAddress.label;
    // A zone is not an address; keep it for the service-date line.
    venueTimezone = place?.timezone ?? null;
  } else if (event?.placeId) {
    if (place) {
      venueLabel = joinNonEmpty(
        [
          place.name,
          place.formattedAddress ??
            joinNonEmpty(
              [
                place.addressLine1,
                place.addressLine2,
                place.city,
                place.region,
                place.postalCode,
                place.countryCode,
              ],
              ", ",
            ),
        ],
        " — ",
      );
      venueTimezone = place.timezone ?? null;
    }
  }
  if (!holderAddress?.locked && !venueLabel && event?.savedLocationId) {
    const saved = await optional("venue", () =>
      repos.savedLocations.getById(event.savedLocationId!),
    );
    if (saved) {
      venueLabel = joinNonEmpty([saved.name, saved.address], " — ");
      venueTimezone = saved.timezone ?? null;
    }
  }
  if (!holderAddress?.locked && !venueLabel && event?.addressText) {
    venueLabel = event.addressText;
  }

  const tickets = isMembership
    ? []
    : ((await optional("tickets", () => repos.tickets.listByOrderId(order.id))) ??
      []);

  const ticketTypeNames = new Map<string, string>();
  const ticketTypeIds = [
    ...new Set(
      order.items
        .filter((item) => item.kind === "ticket" && item.ticketTypeId)
        .map((item) => item.ticketTypeId as string),
    ),
  ];
  for (const ticketTypeId of ticketTypeIds) {
    const ticketType = await optional("tickets", () =>
      repos.tickets.getTicketTypeById(ticketTypeId),
    );
    if (ticketType) ticketTypeNames.set(ticketTypeId, ticketType.name);
  }

  // ONE query for every ticket's scans (was a per-ticket loop).
  const scans =
    tickets.length > 0
      ? ((await optional("scanLog", () =>
          repos.tickets.listScansByTicketIds(tickets.map((t) => t.id)),
        )) ?? [])
      : [];
  scans.sort((a, b) => a.scannedAt.getTime() - b.scannedAt.getTime());

  const ledgerEntries =
    (await optional("refundHistory", () =>
      repos.payeeLedger.listOrderEntries(order.id),
    )) ?? [];
  const refundDebits = ledgerEntries
    .filter((entry) => entry.type === "REFUND_DEBIT")
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return {
    dispute,
    order,
    taxLines,
    event,
    buyerName,
    buyerEmail,
    organizerName,
    venueLabel,
    venueTimezone,
    ticketTypeNames,
    tickets,
    scans,
    refundDebits,
    scansApplicable: !isMembership,
  };
}

// ── Field building ───────────────────────────────────────────────────────────

function buildEvidenceFields(
  g: GatheredSources,
  now: Date,
): { fields: DisputeEvidenceFields; sources: DisputeEvidenceSources } {
  const { order, event, dispute } = g;
  const sources = emptyDisputeEvidenceSources();
  sources.order = "found";
  const isMembership = order.kind === "MEMBERSHIP";
  const timezone = event?.timezone ?? g.venueTimezone ?? "UTC";
  const organizer = g.organizerName ?? "the event organizer";
  sources.organizer = g.organizerName ? "found" : "missing";

  const fields: DisputeEvidenceFields = {};
  // Every text field goes through this so nothing can exceed the per-field
  // cap regardless of how long a policy text or venue name gets.
  const setText = (key: keyof DisputeEvidenceFields, value: string | null) => {
    if (value === null || value.length === 0) return;
    const bounded = boundText(value, DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS);
    fields[key] = bounded.text;
    if (bounded.truncated) sources.truncated = true;
  };

  // ── productDescription ──
  const itemLines = describeItems(g);
  if (isMembership) {
    sources.event = "not_applicable";
    sources.venue = "not_applicable";
    setText(
      "productDescription",
      joinNonEmpty(
        [
          `Recurring membership sold by ${organizer} via Ithas Fire (merchant of record).`,
          itemLines.length > 0 ? `Items: ${itemLines.join("; ")}.` : null,
          `Order ${orderLabel(order)}, ${formatMoney(chargedCents(order), order.currency)} charged, placed ${formatDateTime(order.occurredAt, timezone)}.`,
        ],
        " ",
      ),
    );
  } else {
    sources.event = event ? "found" : "missing";
    sources.venue = g.venueLabel ? "found" : "missing";
    const ticketCount = g.tickets.length || countTicketQty(order);
    const noun = ticketCount === 1 ? "ticket" : "tickets";
    setText(
      "productDescription",
      joinNonEmpty(
        [
          event
            ? `${ticketCount} ${noun} to "${event.title}" on ${formatDateTime(event.startsAt, timezone)}${g.venueLabel ? ` at ${g.venueLabel}` : ""}, sold by ${organizer} via Ithas Fire (merchant of record).`
            : `${ticketCount} event ${noun} sold by ${organizer} via Ithas Fire (merchant of record).`,
          itemLines.length > 0 ? `Items: ${itemLines.join("; ")}.` : null,
          `Order ${orderLabel(order)}, ${formatMoney(chargedCents(order), order.currency)} charged, placed ${formatDateTime(order.occurredAt, timezone)}.`,
        ],
        " ",
      ),
    );
  }

  // ── buyer ──
  if (g.buyerName) {
    setText("customerName", g.buyerName);
    sources.buyer = "found";
  }
  if (g.buyerEmail) {
    setText("customerEmailAddress", g.buyerEmail);
    sources.buyerEmail = "found";
  }
  // Owner ruling 2026-10-08: orders placed before checkoutIp was written carry
  // only the refund-policy acknowledgement IP — the same request IP, captured
  // in the same transaction — so it stands in. The source schema has no
  // distinct "fallback" state; either value counts as "found".
  const purchaseIp = order.checkoutIp ?? order.refundPolicyAckIp ?? null;
  if (purchaseIp) {
    setText("customerPurchaseIp", purchaseIp);
    sources.checkoutIp = "found";
  }
  const billingAddress = joinNonEmpty(
    [
      order.billingAddressLine1,
      order.billingAddressLine2,
      joinNonEmpty([order.billingCity, order.billingState], ", "),
      order.billingPostalCode,
      order.billingCountry,
    ],
    ", ",
  );
  if (billingAddress) {
    setText("billingAddress", billingAddress);
    sources.billingAddress = "found";
  }

  // ── serviceDate ──
  if (event) {
    setText(
      "serviceDate",
      `${formatDateTime(event.startsAt, timezone)} (${timezone})`,
    );
  } else if (isMembership) {
    setText(
      "serviceDate",
      `Membership billing period starting ${formatDateTime(order.occurredAt, timezone)} (${timezone})`,
    );
  }

  // ── refund policy disclosure ──
  const policyParts: string[] = [];
  if (order.refundPolicyText) {
    sources.refundPolicy = "found";
    policyParts.push(
      `Refund policy shown at checkout${order.refundPolicyVersion ? ` (policy version ${order.refundPolicyVersion})` : ""}:`,
      order.refundPolicyText.trim(),
    );
    if (order.refundPolicyAckAt) {
      policyParts.push(
        `The buyer acknowledged this policy at ${formatDateTime(order.refundPolicyAckAt, timezone)}${order.refundPolicyAckIp ? ` from IP ${order.refundPolicyAckIp}` : ""}.`,
      );
    }
  } else if (order.refundPolicyAckAt) {
    // Acknowledgement without the snapshot text — still worth stating.
    sources.refundPolicy = "found";
    policyParts.push(
      `The buyer acknowledged the refund policy at checkout at ${formatDateTime(order.refundPolicyAckAt, timezone)}${order.refundPolicyAckIp ? ` from IP ${order.refundPolicyAckIp}` : ""}${order.refundPolicyVersion ? ` (policy version ${order.refundPolicyVersion})` : ""}.`,
    );
  }
  if (order.termsVersion || order.termsAcceptedAt) {
    sources.termsAcceptance = "found";
    policyParts.push(
      `Terms of Service${order.termsVersion ? ` ${order.termsVersion}` : ""} accepted${order.termsAcceptedAt ? ` at ${formatDateTime(order.termsAcceptedAt, timezone)}` : ""}.`,
    );
  }
  if (policyParts.length > 0) {
    setText("refundPolicyDisclosure", policyParts.join("\n"));
  }

  // ── refund refusal explanation ──
  sources.refundHistory = g.refundDebits.length > 0 ? "found" : "missing";
  setText("refundRefusalExplanation", buildRefundExplanation(g));

  // ── access activity log (scan log) ──
  let scanLogNote: string;
  if (!g.scansApplicable) {
    sources.scanLog = "not_applicable";
    sources.tickets = "not_applicable";
    scanLogNote = "";
  } else {
    sources.tickets = g.tickets.length > 0 ? "found" : "missing";
    sources.scanLog = g.scans.length > 0 ? "found" : "missing";
    if (g.scans.length > 0) {
      const { text, capped } = buildScanLog(g, timezone);
      setText("accessActivityLog", text);
      if (capped) sources.truncated = true;
      scanLogNote = `${g.scans.length} entry scan${g.scans.length === 1 ? "" : "s"} recorded — see the access activity log.`;
    } else {
      scanLogNote = "No entry scans recorded for this order's tickets.";
    }
  }

  // ── card checks / statement descriptor / ticket email provenance ──
  sources.cardChecks = order.paymentCardChecks ? "found" : "missing";
  sources.statementDescriptor = order.billingDescriptor ? "found" : "missing";
  // The ticket confirmation email is sent through the mailer with an
  // idempotency key (`ticket-issued:<orderId>`) that lives in a TTL'd
  // store, not a durable send log. Until a send record exists we cannot
  // PROVE delivery, so the source stays `missing` and the text says
  // nothing about it — never invent a "sent at" the bank could disprove.
  sources.ticketEmail = "missing";

  // ── uncategorized text: the structured order dossier ──
  const dossier = buildDossier(g, timezone, now, scanLogNote);
  const { text: bounded, truncated } = boundUncategorizedText(fields, dossier);
  fields.uncategorizedText = bounded;
  if (truncated) sources.truncated = true;

  return { fields, sources };
}

/**
 * The minimal draft written when full assembly fails: what the order row
 * alone can prove, so ops has a package to edit rather than an empty desk.
 */
function buildFallbackFields(
  dispute: DisputeRecord,
  order: OrderRecord,
  now: Date,
  taxLines: ReadonlyArray<OrderTaxLineRecord>,
): { fields: DisputeEvidenceFields; sources: DisputeEvidenceSources } {
  const sources = emptyDisputeEvidenceSources();
  sources.order = "found";
  sources.statementDescriptor = order.billingDescriptor ? "found" : "missing";
  const lines = [
    `ORDER SUMMARY (prepared ${formatDateTime(now, "UTC")} UTC — automatic assembly failed; ops must complete this package by hand)`,
    `Order: ${orderLabel(order)}`,
    describeCharge(order, taxLines),
    `Disputed amount: ${formatMoney(dispute.amountCents, dispute.currency)}; processor reason code: ${dispute.reason}`,
    `Order placed: ${formatDateTime(order.occurredAt, "UTC")} (UTC)`,
    ...(order.billingDescriptor
      ? [`Statement descriptor: ${order.billingDescriptor}`]
      : []),
    "",
    MERCHANT_OF_RECORD_STATEMENT,
  ];
  const fields: DisputeEvidenceFields = {
    uncategorizedText: boundText(
      lines.join("\n"),
      DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS,
    ).text,
  };
  return { fields, sources };
}

function describeItems(g: GatheredSources): string[] {
  const lines: string[] = [];
  for (const item of g.order.items) {
    if (item.kind === "ticket") {
      const name =
        (item.ticketTypeId && g.ticketTypeNames.get(item.ticketTypeId)) ||
        "ticket";
      lines.push(
        `${item.qty} x ${name} (${formatMoney(item.unitPriceCents, g.order.currency)} each)`,
      );
    } else if (item.kind === "membership") {
      lines.push(
        `${item.qty} x membership period (${formatMoney(item.unitPriceCents, g.order.currency)} each)`,
      );
    }
  }
  return lines;
}

function countTicketQty(order: OrderRecord): number {
  return order.items
    .filter((item) => item.kind === "ticket")
    .reduce((sum, item) => sum + item.qty, 0);
}

function buildRefundExplanation(g: GatheredSources): string {
  const { order } = g;
  const parts: string[] = [];
  if (order.refundPolicyText || order.refundPolicyAckAt) {
    parts.push(
      "The buyer acknowledged the refund policy at checkout (see refund policy disclosure).",
    );
  }
  if (order.nonRefundable) {
    parts.push("The order was sold as non-refundable under that policy.");
  }
  if (g.refundDebits.length > 0) {
    const total = g.refundDebits.reduce(
      (sum, entry) => sum + Math.abs(entry.amountCents),
      0,
    );
    parts.push(
      `${g.refundDebits.length === 1 ? "A refund" : `${g.refundDebits.length} refunds`} totalling ${formatMoney(total, order.currency)} ${g.refundDebits.length === 1 ? "was" : "were"} already issued to the buyer's original payment method (see refund history); the disputed amount should be reduced accordingly.`,
    );
  } else if (order.status === "REFUNDED" || order.status === "PART_REFUNDED") {
    parts.push(
      `Order status is ${order.status === "REFUNDED" ? "refunded" : "partially refunded"}; see refund history.`,
    );
  } else {
    parts.push(
      "No refund has been issued for this order. We have no record of the buyer requesting a refund through the platform before this dispute was filed.",
    );
  }
  parts.push(
    "Ithas Fire is the merchant of record and would have processed any refund request under the policy the buyer accepted.",
  );
  return parts.join(" ");
}

/**
 * The scan log, newest-N when the order is huge (a 4,000-ticket group
 * order does not need every line to prove attendance). Staff names are
 * masked to a stable short id: the buyer's PII is necessary evidence, a
 * volunteer's real name is not.
 */
function buildScanLog(
  g: GatheredSources,
  timezone: string,
): { text: string; capped: boolean } {
  const codeById = new Map(g.tickets.map((t) => [t.id, maskCode(t.code)]));
  const capped = g.scans.length > DISPUTE_EVIDENCE_MAX_SCAN_LINES;
  const shown = capped
    ? g.scans.slice(g.scans.length - DISPUTE_EVIDENCE_MAX_SCAN_LINES)
    : g.scans;
  const lines = shown.map(
    (scan) =>
      `${formatDateTime(scan.scannedAt, timezone)} — ticket ${codeById.get(scan.ticketId) ?? "unknown"} — ${scan.outcome} — scanned by ${maskStaff(scan.actorHumanId)}${scan.message ? ` — ${scan.message}` : ""}`,
  );
  const header = capped
    ? `Entry scan log for order ${orderLabel(g.order)} (${g.scans.length} scans; the ${DISPUTE_EVIDENCE_MAX_SCAN_LINES} most recent shown, times in ${timezone}):`
    : `Entry scan log for order ${orderLabel(g.order)} (${g.scans.length} scan${g.scans.length === 1 ? "" : "s"}, times in ${timezone}):`;
  return { text: [header, ...lines].join("\n"), capped };
}

function buildDossier(
  g: GatheredSources,
  timezone: string,
  now: Date,
  scanLogNote: string,
): string {
  const { order, dispute, event } = g;
  const lines: string[] = [];
  lines.push(`ORDER SUMMARY (prepared ${formatDateTime(now, "UTC")} UTC)`);
  lines.push(`Order: ${orderLabel(order)}`);
  lines.push(`Order kind: ${order.kind === "MEMBERSHIP" ? "membership" : "event ticketing"}; sales channel: ${order.paymentChannel}${order.source !== "PRIMARY" ? ` (${order.source.toLowerCase()})` : ""}`);
  lines.push(describeCharge(g.order, g.taxLines));
  lines.push(`Disputed amount: ${formatMoney(dispute.amountCents, dispute.currency)}; processor reason code: ${dispute.reason}`);
  lines.push(`Order placed: ${formatDateTime(order.occurredAt, timezone)} (${timezone})`);
  if (order.billingDescriptor) {
    lines.push(`Statement descriptor: ${order.billingDescriptor}`);
  }
  if (order.paymentMethodType) {
    lines.push(`Payment method: ${order.paymentMethodType}`);
  }
  if (order.paymentCardChecks) {
    const c = order.paymentCardChecks;
    lines.push(
      `Card verification at authorization: address line 1 ${c.addressLine1Check ?? "not checked"}, postal code ${c.addressPostalCodeCheck ?? "not checked"}, CVC ${c.cvcCheck ?? "not checked"}`,
    );
  }
  if (event) {
    lines.push("");
    lines.push("EVENT");
    lines.push(`Title: ${event.title}`);
    lines.push(`Starts: ${formatDateTime(event.startsAt, timezone)} (${timezone})`);
    if (event.endsAt) {
      lines.push(`Ends: ${formatDateTime(event.endsAt, timezone)} (${timezone})`);
    }
    if (g.venueLabel) lines.push(`Place: ${g.venueLabel}`);
    if (g.organizerName) lines.push(`Organizer: ${g.organizerName}`);
  }

  if (g.scansApplicable) {
    lines.push("");
    lines.push(`TICKETS (${g.tickets.length})`);
    if (g.tickets.length === 0) {
      lines.push("No ticket records found for this order.");
    }
    for (const ticket of g.tickets) {
      lines.push(
        `Ticket ${maskCode(ticket.code)} — status ${ticket.status} — issued ${formatDateTime(ticket.issuedAt, timezone)}${ticket.scannedAt ? ` — first scanned ${formatDateTime(ticket.scannedAt, timezone)}` : " — not scanned"}`,
      );
    }
    lines.push("");
    lines.push("ENTRY SCANS");
    // The per-scan lines live in accessActivityLog; only the count here so
    // the two fields do not double-count against the combined cap.
    lines.push(scanLogNote);
  }

  lines.push("");
  lines.push(`REFUND HISTORY (${g.refundDebits.length})`);
  if (g.refundDebits.length === 0) {
    lines.push(`No refunds issued. Order status: ${order.status}.`);
  } else {
    for (const entry of g.refundDebits) {
      lines.push(
        `${formatDateTime(entry.createdAt, timezone)} — refund of ${formatMoney(Math.abs(entry.amountCents), entry.currency)}${entry.description ? ` — ${entry.description}` : ""}`,
      );
    }
    lines.push(`Order status: ${order.status}.`);
  }

  lines.push("");
  lines.push(MERCHANT_OF_RECORD_STATEMENT);
  return lines.join("\n");
}

/**
 * Cuts `uncategorizedText` from the END so the whole package fits both the
 * per-field cap and the combined cap given every other field already set.
 */
function boundUncategorizedText(
  fields: DisputeEvidenceFields,
  text: string,
): { text: string; truncated: boolean } {
  const otherChars = Object.entries(fields).reduce(
    (sum, [key, value]) =>
      key === "uncategorizedText" || value === undefined
        ? sum
        : sum + value.length,
    0,
  );
  const budget = Math.min(
    DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS,
    DISPUTE_EVIDENCE_COMBINED_MAX_CHARS - otherChars,
  );
  return boundText(text, budget);
}

export function boundText(
  text: string,
  budget: number,
): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const keep = Math.max(0, budget - TRUNCATION_MARKER.length);
  return { text: text.slice(0, keep) + TRUNCATION_MARKER, truncated: true };
}

/**
 * What the cardholder was actually charged — the PaymentIntent amount, not
 * the organiser's gross. The card network compares evidence against the
 * charge, so a package that states the ticket face value ("45.00") for a
 * "51.29" charge reads as a mismatch. `computeExpectedPaymentAmount` is the
 * same house helper the payment-verification path uses: per-item
 * `buyerTotalCents` (face + platform fee + grossed-up processor fee) when
 * checkout stamped it, else gross + platform fee, plus order-level tax, and
 * platform credit lines already folded in.
 */
function chargedCents(order: OrderRecord): number {
  try {
    return computeExpectedPaymentAmount(order);
  } catch {
    // The fallback draft must survive a corrupt items column; the column
    // sum is the honest lower bound (under-counts a pass-through processor
    // fee, never over-states the charge).
    return order.amountGrossCents + order.feesPlatformCents + order.taxAmountCents;
  }
}

/**
 * The order's PLATFORM tax lines. The read is display-only: a failure is
 * reported and degrades the tax wording to the generic "tax", never the package.
 */
async function loadPlatformTaxLines(
  deps: AssembleDisputeEvidenceDeps,
  dispute: DisputeRecord,
  order: OrderRecord,
): Promise<OrderTaxLineRecord[]> {
  try {
    const lines = await deps.repos.orders.listTaxLines(order.id);
    return lines.filter((l) => l.collector === "PLATFORM");
  } catch (err) {
    try {
      deps.logger?.error("dispute.evidence.source_lookup_failed", {
        disputeId: dispute.id,
        orderId: order.id,
        source: "taxLines",
        error: describeError(err),
      });
    } catch {
      // A throwing logger never aborts assembly.
    }
    try {
      deps.reportError?.(err, {
        tags: { useCase: "assembleDisputeEvidence", source: "taxLines" },
        extra: { disputeId: dispute.id, orderId: order.id },
      });
    } catch {
      // Reporter failures never change behaviour.
    }
    return [];
  }
}

/**
 * Labels are shown verbatim (they carry proper nouns); only the generic sales
 * line reads mid-sentence as "sales tax". An empty label is just "tax".
 */
function taxLabelForSentence(line: OrderTaxLineRecord): string {
  const label = line.label.trim();
  if (!label) return "tax";
  return line.code === "SALES" && label === "Sales tax" ? "sales tax" : label;
}

/**
 * Display-only wording for the tax part of the charge. Persisted lines are
 * listed one by one; no lines (legacy) or lines that do not sum to the order's
 * tax column fall back to a single generic "tax" part.
 */
function describeTax(
  order: OrderRecord,
  taxLines: ReadonlyArray<OrderTaxLineRecord>,
): string[] {
  const tax = order.taxAmountCents;
  if (tax <= 0) return [];
  const lines = taxLines.filter((l) => l.amountCents > 0);
  const sum = lines.reduce((acc, l) => acc + l.amountCents, 0);
  if (lines.length === 0 || sum !== tax) {
    return [`${formatMoney(tax, order.currency)} tax`];
  }
  return lines.map(
    (l) =>
      `${formatMoney(l.amountCents, order.currency)} ${taxLabelForSentence(l)}`,
  );
}

function describeCharge(
  order: OrderRecord,
  taxLines: ReadonlyArray<OrderTaxLineRecord>,
): string {
  const charged = chargedCents(order);
  const tickets = order.amountGrossCents;
  const tax = order.taxAmountCents;
  // Everything the buyer paid above face value + tax: platform fee and (in
  // pass-through mode) the processor fee. Integer arithmetic only.
  const fees = Math.max(0, charged - tickets - tax);
  const parts = [
    `${formatMoney(tickets, order.currency)} ${order.kind === "MEMBERSHIP" ? "membership" : "tickets"}`,
    ...describeTax(order, taxLines),
    ...(fees > 0 ? [`${formatMoney(fees, order.currency)} fees`] : []),
  ];
  return `Amount charged: ${formatMoney(charged, order.currency)} (of which ${parts.join(", ")})`;
}

// ── Formatting helpers (integer money, IANA-zoned dates) ─────────────────────

function joinNonEmpty(
  parts: ReadonlyArray<string | null | undefined>,
  separator: string,
): string | null {
  const kept = parts
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0);
  return kept.length > 0 ? kept.join(separator) : null;
}

function orderLabel(order: OrderRecord): string {
  return order.id;
}

/** Last 4 of the ticket code — enough to match a scan, not enough to reuse. */
function maskCode(code: string): string {
  return `…${code.slice(-4)}`;
}

/** Scanner identity as a stable short id, never a staff member's name. */
export function maskStaff(actorHumanId: string): string {
  return `staff #${actorHumanId.replace(/-/g, "").slice(-4).toLowerCase()}`;
}

/** Integer-cents formatting: no floating point anywhere near money. */
export function formatMoney(cents: number, currency: string): string {
  const negative = cents < 0;
  const abs = Math.abs(Math.trunc(cents));
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${frac} ${currency.toUpperCase()}`;
}

export function formatDateTime(date: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  } catch {
    // Unknown IANA name on a legacy row — fall back to UTC rather than throw.
    return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
}

export type { DisputeEvidenceRecord };

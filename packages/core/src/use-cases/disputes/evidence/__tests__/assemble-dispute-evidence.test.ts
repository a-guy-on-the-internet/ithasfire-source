import { describe, expect, it, vi } from "vitest";

import {
  checkDisputeEvidenceLimits,
  DISPUTE_EVIDENCE_FIELD_KINDS,
  DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS,
} from "@th/ports/dispute-evidence";
import type { PayeeLedgerEntryRecord } from "@th/ports/repos/payee-ledger";
import type { TicketRecord, TicketScanRecord } from "@th/ports/repos/tickets";

import {
  assembleDisputeEvidence,
  DISPUTE_EVIDENCE_MAX_SCAN_LINES,
  MERCHANT_OF_RECORD_STATEMENT,
} from "../assemble-dispute-evidence";
import { buildDisputeEvidenceMutexKey } from "../_shared/evidence-mutex";
import {
  buildDispute,
  buildEvent,
  buildEvidence,
  buildOrder,
  buildTaxLine,
  buildTickets,
  clock,
  DISPUTE_ID,
  EVENT_ID,
  makeFakeRepos,
  NOW,
  ORDER_ID,
  ORG_ID,
  PLACE_ID,
} from "./fixtures";

const deps = (fake: ReturnType<typeof makeFakeRepos>, extra = {}) => ({
  repos: fake.repos,
  idempotency: fake.idempotency,
  clock,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  ...extra,
});

describe("assembleDisputeEvidence", () => {
  it("builds a full text-only package from a rich ticketing order", async () => {
    const fake = makeFakeRepos();

    const result = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });

    expect(result.skipped).toBeNull();
    const evidence = result.evidence!;
    expect(evidence.status).toBe("DRAFT");
    expect(evidence.assembledVersion).toBe(1);
    const f = evidence.fields;

    // productDescription: quantity, title, date in the EVENT timezone, venue,
    // organizer, MoR, and the itemised ticket types.
    expect(f.productDescription).toContain('2 tickets to "Rock Show"');
    expect(f.productDescription).toContain("May 31, 2026");
    expect(f.productDescription).toContain("8:00 PM CDT");
    expect(f.productDescription).toContain("Drkmttr — 1111 Test Ave");
    expect(f.productDescription).toContain("sold by Drkmttr Collective via Ithas Fire (merchant of record)");
    expect(f.productDescription).toContain("2 x General Admission (23.00 USD each)");

    expect(f.customerName).toBe("Buyer Person");
    expect(f.customerEmailAddress).toBe("buyer@example.com");
    expect(f.customerPurchaseIp).toBe("203.0.113.7");
    expect(f.billingAddress).toBe("100 Main St, Nashville, TN, 37201, US");
    expect(f.serviceDate).toContain("May 31, 2026");
    expect(f.serviceDate).toContain("(America/Chicago)");

    // Refund policy disclosure: exact text + ack stamp + ToS.
    expect(f.refundPolicyDisclosure).toContain("(policy version 2026-04)");
    expect(f.refundPolicyDisclosure).toContain(
      "All sales are final. No refunds except event cancellation.",
    );
    expect(f.refundPolicyDisclosure).toContain("from IP 203.0.113.7");
    expect(f.refundPolicyDisclosure).toContain("Terms of Service 2026-04 accepted at");

    expect(f.refundRefusalExplanation).toContain("No refund has been issued");
    expect(f.refundRefusalExplanation).not.toMatch(/legal|lawsuit|prosecut/i);

    // Scan log lands in accessActivityLog with masked codes and the scanner
    // as a short id — never a volunteer's real name.
    expect(f.accessActivityLog).toContain("ticket …1234 — ACCEPTED — scanned by staff #er_1");
    expect(f.accessActivityLog).not.toContain("TKT-ABCD-1234");
    expect(f.accessActivityLog).not.toContain("Door Staff");

    // The dossier.
    const dossier = f.uncategorizedText!;
    expect(dossier).toContain(`Order: ${ORDER_ID}`);
    // The EVENT block names the place as "Place:", never "Venue:".
    expect(dossier).toMatch(/\nPlace: \S/);
    expect(dossier).not.toContain("Venue:");
    // The CHARGE, not the organiser's gross: 50.00 face + 1.50 platform fee
    // + 4.00 tax, broken down, currency stated once.
    expect(dossier).toContain(
      "Amount charged: 55.50 USD (of which 50.00 USD tickets, 4.00 USD tax, 1.50 USD fees)",
    );
    expect(dossier).not.toContain("(USD)");
    expect(f.productDescription).toContain("55.50 USD charged");
    expect(dossier).toContain("Disputed amount: 50.00 USD; processor reason code: fraudulent");
    expect(dossier).toContain("Statement descriptor: IHF* ROCK SHOW");
    expect(dossier).toContain("Payment method: card");
    expect(dossier).toContain("address line 1 pass, postal code pass, CVC pass");
    expect(dossier).toContain("TICKETS (2)");
    expect(dossier).toContain("Ticket …1234 — status USED");
    expect(dossier).toContain("Ticket …5678 — status VALID");
    // The dossier carries a count + pointer, not a second copy of the log.
    expect(dossier).toContain("ENTRY SCANS\n1 entry scan recorded — see the access activity log.");
    expect(dossier).not.toContain("scanned by");
    expect(dossier).not.toContain("Door Staff");
    expect(dossier).toContain("REFUND HISTORY (0)");
    expect(dossier).toContain(MERCHANT_OF_RECORD_STATEMENT);
    // Never a claim we cannot prove.
    expect(dossier).not.toMatch(/confirmation email/i);
    expect(result.fallback).toBe(false);

    // File slots stay unset; nothing is ever coalesced to "".
    for (const [key, kind] of Object.entries(DISPUTE_EVIDENCE_FIELD_KINDS)) {
      const value = f[key as keyof typeof f];
      if (kind === "file") expect(value).toBeUndefined();
      expect(value).not.toBe("");
    }

    expect(checkDisputeEvidenceLimits(f).ok).toBe(true);

    expect(evidence.sources).toEqual({
      order: "found",
      buyer: "found",
      buyerEmail: "found",
      checkoutIp: "found",
      billingAddress: "found",
      event: "found",
      venue: "found",
      organizer: "found",
      refundPolicy: "found",
      termsAcceptance: "found",
      tickets: "found",
      scanLog: "found",
      refundHistory: "missing",
      cardChecks: "found",
      ticketEmail: "missing",
      statementDescriptor: "found",
      truncated: false,
    });

    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "dispute",
        entityId: DISPUTE_ID,
        action: "dispute.evidence_assembled",
        data: expect.objectContaining({
          orderId: ORDER_ID,
          assembledVersion: 1,
          forced: false,
        }),
      }),
    );
    // Audit carries provenance and keys, never the evidence text.
    const auditData = fake.audit.mock.calls[0]![0].data as Record<string, unknown>;
    expect(JSON.stringify(auditData)).not.toContain("buyer@example.com");
  });

  it("records missing sources instead of inventing values", async () => {
    const fake = makeFakeRepos({
      order: buildOrder({
        checkoutIp: null,
        refundPolicyAckIp: null,
        billingAddressLine1: null,
        billingCity: null,
        billingState: null,
        billingPostalCode: null,
        billingCountry: null,
        refundPolicyText: null,
        refundPolicyAckAt: null,
        termsVersion: null,
        termsAcceptedAt: null,
        paymentCardChecks: null,
        billingDescriptor: null,
      }),
      buyer: null,
      place: null,
      tickets: [],
      scans: [],
    });

    const { evidence } = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });
    const f = evidence!.fields;

    expect(f.customerName).toBeUndefined();
    expect(f.customerEmailAddress).toBeUndefined();
    expect(f.customerPurchaseIp).toBeUndefined();
    expect(f.billingAddress).toBeUndefined();
    expect(f.refundPolicyDisclosure).toBeUndefined();
    expect(f.accessActivityLog).toBeUndefined();
    expect(f.uncategorizedText).toContain("No ticket records found");
    expect(f.uncategorizedText).toContain("ENTRY SCANS\nNo entry scans recorded");
    expect(evidence!.sources).toMatchObject({
      buyer: "missing",
      buyerEmail: "missing",
      checkoutIp: "missing",
      billingAddress: "missing",
      venue: "missing",
      refundPolicy: "missing",
      termsAcceptance: "missing",
      tickets: "missing",
      scanLog: "missing",
      cardChecks: "missing",
      statementDescriptor: "missing",
    });
    expect(checkDisputeEvidenceLimits(f).ok).toBe(true);
  });

  it("marks a source missing and reports when its lookup throws, without failing the package", async () => {
    const reportError = vi.fn();
    const fake = makeFakeRepos({ failingSources: new Set(["venue"]) });

    const { evidence } = await assembleDisputeEvidence(
      deps(fake, { reportError }),
      { disputeId: DISPUTE_ID },
    );

    expect(evidence!.sources.venue).toBe("missing");
    expect(evidence!.fields.productDescription).not.toContain("Drkmttr —");
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "assembleDisputeEvidence", source: "venue" },
      }),
    );
  });

  it("survives a throwing reporter", async () => {
    const reportError = vi.fn(() => {
      throw new Error("sentry down");
    });
    const fake = makeFakeRepos({ failingSources: new Set(["scanLog"]) });

    const result = await assembleDisputeEvidence(
      deps(fake, { reportError }),
      { disputeId: DISPUTE_ID },
    );

    expect(result.skipped).toBeNull();
    expect(result.evidence!.sources.scanLog).toBe("missing");
  });

  it("keeps every read outside the transaction; only the draft write and audit row are transactional", async () => {
    const fake = makeFakeRepos();
    await assembleDisputeEvidence(deps(fake), { disputeId: DISPUTE_ID });
    expect([...fake.txTouched].sort()).toEqual(["audit", "disputeEvidence"]);
    expect(fake.repos.tickets.listScansByTicketIds).toHaveBeenCalledTimes(1);
    expect(fake.repos.tickets.listScansByTicketIds).toHaveBeenCalledWith([
      "ticket_1",
      "ticket_2",
    ]);
  });

  it("bounds every text field to the per-field cap (a 30k refund policy still yields a valid package)", async () => {
    const fake = makeFakeRepos({
      order: buildOrder({ refundPolicyText: "p".repeat(30_000) }),
    });
    const { evidence } = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });
    const f = evidence!.fields;
    expect(f.refundPolicyDisclosure!.length).toBeLessThanOrEqual(
      DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS,
    );
    expect(f.refundPolicyDisclosure!.endsWith("\n[truncated]")).toBe(true);
    expect(evidence!.sources.truncated).toBe(true);
    expect(checkDisputeEvidenceLimits(f).ok).toBe(true);
  });

  it("caps the access log at the most recent N scans for a huge order", async () => {
    const tickets: TicketRecord[] = [];
    const scans: TicketScanRecord[] = [];
    const total = DISPUTE_EVIDENCE_MAX_SCAN_LINES + 50;
    for (let i = 0; i < total; i += 1) {
      tickets.push({ ...buildTickets()[0]!, id: `ticket_${i}`, code: `TKT-${String(i).padStart(8, "0")}` });
      scans.push({
        id: `scan_${i}`,
        ticketId: `ticket_${i}`,
        eventId: EVENT_ID,
        actorHumanId: "scanner_1",
        actorName: "Door Staff",
        outcome: "ACCEPTED",
        message: null,
        scannedAt: new Date(Date.UTC(2026, 5, 1, 0, 0, i)),
        locationLat: null,
        locationLng: null,
      });
    }
    const fake = makeFakeRepos({ tickets, scans });
    const { evidence } = await assembleDisputeEvidence(deps(fake), { disputeId: DISPUTE_ID });
    const log = evidence!.fields.accessActivityLog!;
    expect(log).toContain(`(${total} scans; the ${DISPUTE_EVIDENCE_MAX_SCAN_LINES} most recent shown`);
    // Oldest 50 dropped, newest kept.
    expect(log).not.toContain("ticket …0000 —");
    expect(log).toContain(`ticket …${String(total - 1).padStart(4, "0").slice(-4)} —`);
    expect(log.split("\n").length).toBe(DISPUTE_EVIDENCE_MAX_SCAN_LINES + 1);
    expect(evidence!.sources.truncated).toBe(true);
  });

  it("persists a minimal fallback draft when full assembly throws, and reports", async () => {
    const reportError = vi.fn();
    // A corrupt items column makes field building throw; the fallback
    // never touches items, so it still writes.
    const fake = makeFakeRepos({
      order: buildOrder({ items: undefined as unknown as never }),
    });
    const result = await assembleDisputeEvidence(deps(fake, { reportError }), {
      disputeId: DISPUTE_ID,
    });

    expect(result.fallback).toBe(true);
    expect(result.skipped).toBeNull();
    const f = result.evidence!.fields;
    expect(Object.keys(f)).toEqual(["uncategorizedText"]);
    expect(f.uncategorizedText).toContain("automatic assembly failed");
    expect(f.uncategorizedText).toContain(`Order: ${ORDER_ID}`);
    expect(f.uncategorizedText).toContain("Disputed amount: 50.00 USD");
    expect(f.uncategorizedText).toContain(MERCHANT_OF_RECORD_STATEMENT);
    expect(result.evidence!.status).toBe("DRAFT");
    expect(result.evidence!.sources).toMatchObject({
      order: "found",
      buyer: "missing",
      scanLog: "missing",
      event: "missing",
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tags: { useCase: "assembleDisputeEvidence", stage: "fallback" },
      }),
    );
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dispute.evidence_assembled",
        data: expect.objectContaining({ fallback: true }),
      }),
    );
  });

  it("force takes the per-dispute mutex and refuses while another operation holds it", async () => {
    const fake = makeFakeRepos({ evidence: buildEvidence() });
    const key = buildDisputeEvidenceMutexKey(DISPUTE_ID);
    await fake.idempotency.begin(key, 60, "someone-else");

    await expect(
      assembleDisputeEvidence(deps(fake), { disputeId: DISPUTE_ID, force: true }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_STATE_INVALID" });
    expect(fake.upsertDraft).not.toHaveBeenCalled();

    await fake.idempotency.release(key, "someone-else");
    const result = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
      force: true,
    });
    expect(result.evidence!.assembledVersion).toBe(2);
    // Released afterwards: the key is free again.
    expect(fake.idempotency.__mocks.release).toHaveBeenCalledWith(key, expect.any(String));
    expect(await fake.idempotency.begin(key, 60, "probe")).toBe(true);
  });

  it("non-forced assembly (webhook / sweep) also holds the dispute mutex and releases it", async () => {
    const fake = makeFakeRepos();
    const key = buildDisputeEvidenceMutexKey(DISPUTE_ID);
    const result = await assembleDisputeEvidence(deps(fake), { disputeId: DISPUTE_ID });
    expect(result.evidence!.assembledVersion).toBe(1);
    expect(fake.idempotency.__mocks.begin).toHaveBeenCalledWith(key, 300, expect.any(String));
    expect(fake.idempotency.__mocks.release).toHaveBeenCalledTimes(1);
    expect(await fake.idempotency.begin(key, 60, "probe")).toBe(true);
  });

  it("non-forced assembly refuses while the mutex is held (a desk submit in flight)", async () => {
    const fake = makeFakeRepos();
    await fake.idempotency.begin(buildDisputeEvidenceMutexKey(DISPUTE_ID), 60, "submit");
    await expect(
      assembleDisputeEvidence(deps(fake), { disputeId: DISPUTE_ID }),
    ).rejects.toMatchObject({ code: "DISPUTE_EVIDENCE_STATE_INVALID" });
    expect(fake.upsertDraft).not.toHaveBeenCalled();
  });

  it("non-forced assembly is create-only: an existing APPROVED package (ops got there first) is returned untouched", async () => {
    const approved = buildEvidence({
      status: "APPROVED",
      reviewedByHumanId: "staff_admin",
      reviewedAt: clock.now(),
      fields: { productDescription: "ops-approved text" },
    });
    const fake = makeFakeRepos({ evidence: approved });

    const result = await assembleDisputeEvidence(deps(fake), { disputeId: DISPUTE_ID });

    expect(result.skipped).toBe("already_assembled");
    expect(result.evidence).toEqual(approved);
    expect(fake.evidence.get(DISPUTE_ID)).toEqual(approved);
    expect(fake.upsertDraft).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it("truncates the dossier from the end with a marker when the package would exceed the limits", async () => {
    // 4,000 tickets with a scan each pushes the dossier well past the
    // 20,000-char per-field cap.
    const tickets: TicketRecord[] = [];
    const scans: TicketScanRecord[] = [];
    for (let i = 0; i < 4_000; i += 1) {
      tickets.push({
        ...buildTickets()[0]!,
        id: `ticket_${i}`,
        code: `TKT-${String(i).padStart(8, "0")}`,
      });
      scans.push({
        id: `scan_${i}`,
        ticketId: `ticket_${i}`,
        eventId: EVENT_ID,
        actorHumanId: "scanner_1",
        actorName: "Door Staff",
        outcome: "ACCEPTED",
        message: null,
        scannedAt: new Date("2026-06-01T00:45:00.000Z"),
        locationLat: null,
        locationLng: null,
      });
    }
    const fake = makeFakeRepos({ tickets, scans });

    const { evidence } = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });

    const text = evidence!.fields.uncategorizedText!;
    expect(text.endsWith("\n[truncated]")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(DISPUTE_EVIDENCE_TEXT_FIELD_MAX_CHARS);
    expect(evidence!.sources.truncated).toBe(true);
    // The rest of the package still fits the combined cap.
    expect(checkDisputeEvidenceLimits(evidence!.fields).ok).toBe(true);
  });

  it("is idempotent: a second run without force returns the stored package unchanged", async () => {
    const fake = makeFakeRepos();
    const first = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });
    const second = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });

    expect(second.skipped).toBe("already_assembled");
    expect(second.evidence).toEqual(first.evidence);
    expect(fake.upsertDraft).toHaveBeenCalledTimes(1);
    expect(fake.audit).toHaveBeenCalledTimes(1);
  });

  it("re-assembles on force: version bump, back to DRAFT, review stamps cleared", async () => {
    const fake = makeFakeRepos({
      evidence: buildEvidence({
        status: "APPROVED",
        reviewedByHumanId: "staff_admin",
        reviewedAt: clock.now(),
        fields: { productDescription: "hand-edited" },
      }),
    });

    const result = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
      force: true,
    });

    expect(result.skipped).toBeNull();
    expect(result.evidence!.status).toBe("DRAFT");
    expect(result.evidence!.assembledVersion).toBe(2);
    expect(result.evidence!.reviewedByHumanId).toBeNull();
    expect(result.evidence!.fields.productDescription).toContain("Rock Show");
    expect(fake.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "dispute.evidence_assembled",
        data: expect.objectContaining({ forced: true, assembledVersion: 2 }),
      }),
    );
  });

  it("never overwrites a SUBMITTED package, even with force", async () => {
    const submitted = buildEvidence({
      status: "SUBMITTED",
      submittedAt: clock.now(),
      submittedByHumanId: "staff_admin",
    });
    const fake = makeFakeRepos({ evidence: submitted });

    const result = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
      force: true,
    });

    expect(result.skipped).toBe("already_submitted");
    expect(result.evidence).toEqual(submitted);
    expect(fake.upsertDraft).not.toHaveBeenCalled();
  });

  it("skips an unlinked dispute (no order) without writing anything", async () => {
    const fake = makeFakeRepos({
      dispute: buildDispute({ orderId: null, status: "NEEDS_TRIAGE" }),
    });

    const result = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });

    expect(result).toEqual({
      ok: true,
      disputeId: DISPUTE_ID,
      skipped: "unlinked",
      evidence: null,
      fallback: false,
    });
    expect(fake.upsertDraft).not.toHaveBeenCalled();
    expect(fake.audit).not.toHaveBeenCalled();
  });

  it("throws DISPUTE_NOT_FOUND for an unknown dispute", async () => {
    const fake = makeFakeRepos({ dispute: null });
    await expect(
      assembleDisputeEvidence(deps(fake), { disputeId: "nope" }),
    ).rejects.toMatchObject({ code: "DISPUTE_NOT_FOUND" });
  });

  it("describes a membership order without an event or scan log", async () => {
    const fake = makeFakeRepos({
      dispute: buildDispute({ ownerOrgId: ORG_ID }),
      order: buildOrder({
        kind: "MEMBERSHIP",
        eventId: null,
        items: [
          {
            ...buildOrder().items[0]!,
            kind: "membership",
            ticketTypeId: null,
            qty: 1,
            unitPriceCents: 5_000,
            amountCents: 5_000,
          },
        ],
      }),
      event: null,
    });

    const { evidence } = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });
    const f = evidence!.fields;

    expect(f.productDescription).toContain(
      "Recurring membership sold by Drkmttr Collective via Ithas Fire (merchant of record)",
    );
    expect(f.productDescription).toContain("1 x membership period (50.00 USD each)");
    expect(f.productDescription).not.toContain("tickets to");
    expect(f.serviceDate).toContain("Membership billing period starting");
    expect(f.accessActivityLog).toBeUndefined();
    expect(f.uncategorizedText).not.toContain("ENTRY SCAN LOG");
    expect(f.uncategorizedText).toContain("Order kind: membership");
    expect(evidence!.sources).toMatchObject({
      event: "not_applicable",
      venue: "not_applicable",
      scanLog: "not_applicable",
      tickets: "not_applicable",
      organizer: "found",
    });
    expect(fake.repos.tickets.listByOrderId).not.toHaveBeenCalled();
  });

  it("states issued refunds from the ledger for a partially refunded order", async () => {
    const refund: PayeeLedgerEntryRecord = {
      id: "ledger_refund",
      idempotencyKey: "refund-debit:x",
      payeeId: "payee_1",
      type: "REFUND_DEBIT",
      amountCents: -1_500,
      currency: "usd",
      sourceKind: "refund",
      sourceId: "re_1",
      orderId: ORDER_ID,
      settlementId: null,
      disputeId: null,
      relatedEntryId: null,
      availableAt: null,
      consumedByEntryId: null,
      description: "Partial refund",
      metadata: null,
      createdAt: new Date("2026-05-10T10:00:00.000Z"),
    } as PayeeLedgerEntryRecord;
    const fake = makeFakeRepos({
      order: buildOrder({ status: "PART_REFUNDED" }),
      ledgerEntries: [refund],
    });

    const { evidence } = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });
    const f = evidence!.fields;

    expect(f.refundRefusalExplanation).toContain(
      "A refund totalling 15.00 USD was already issued",
    );
    expect(f.uncategorizedText).toContain("REFUND HISTORY (1)");
    expect(f.uncategorizedText).toContain("refund of 15.00 USD — Partial refund");
    expect(f.uncategorizedText).toContain("Order status: PART_REFUNDED");
    expect(evidence!.sources.refundHistory).toBe("found");
  });

  it("states the cardholder's actual charge for a $45 + $4 tax + $2.29 fees order (live-run shape)", async () => {
    // Checkout stamps per-item buyerTotalCents = face + platform fee +
    // grossed-up processor fee; tax is order-level on top.
    const fake = makeFakeRepos({
      dispute: buildDispute({ amountCents: 5_129 }),
      order: buildOrder({
        amountGrossCents: 4_500,
        feesPlatformCents: 50,
        taxAmountCents: 400,
        items: [
          {
            ...buildOrder().items[0]!,
            qty: 1,
            unitPriceCents: 4_500,
            amountCents: 4_500,
            meta: { buyerTotalCents: 4_729, processorFeeShareCents: 179 },
          },
        ],
      }),
    });
    const { evidence } = await assembleDisputeEvidence(deps(fake), { disputeId: DISPUTE_ID });
    const dossier = evidence!.fields.uncategorizedText!;
    expect(dossier).toContain(
      "Amount charged: 51.29 USD (of which 45.00 USD tickets, 4.00 USD tax, 2.29 USD fees)",
    );
    expect(dossier).toContain("Disputed amount: 51.29 USD");
    expect(dossier).not.toContain("Amount charged: 45.00");
    expect(evidence!.fields.productDescription).toContain("51.29 USD charged");
  });

  it("marks checkoutIp found for any non-null value (loopback included) and missing only when null", async () => {
    const loopback = makeFakeRepos({ order: buildOrder({ checkoutIp: "127.0.0.1" }) });
    const withIp = await assembleDisputeEvidence(deps(loopback), { disputeId: DISPUTE_ID });
    expect(withIp.evidence!.sources.checkoutIp).toBe("found");
    expect(withIp.evidence!.fields.customerPurchaseIp).toBe("127.0.0.1");

    const none = makeFakeRepos({
      order: buildOrder({ checkoutIp: null, refundPolicyAckIp: null }),
    });
    const withoutIp = await assembleDisputeEvidence(deps(none), { disputeId: DISPUTE_ID });
    expect(withoutIp.evidence!.sources.checkoutIp).toBe("missing");
    expect(withoutIp.evidence!.fields.customerPurchaseIp).toBeUndefined();
  });

  // Owner ruling 2026-10-08: customer_purchase_ip = checkoutIp ?? refundPolicyAckIp.
  describe("customerPurchaseIp source", () => {
    it("uses checkoutIp when present, over the refund-policy ack IP", async () => {
      const fake = makeFakeRepos({
        order: buildOrder({ checkoutIp: "198.51.100.1", refundPolicyAckIp: "198.51.100.2" }),
      });
      const { evidence } = await assembleDisputeEvidence(deps(fake), { disputeId: DISPUTE_ID });
      expect(evidence!.fields.customerPurchaseIp).toBe("198.51.100.1");
      expect(evidence!.sources.checkoutIp).toBe("found");
    });

    it("falls back to refundPolicyAckIp for older orders with no checkoutIp", async () => {
      const fake = makeFakeRepos({
        order: buildOrder({ checkoutIp: null, refundPolicyAckIp: "198.51.100.2" }),
      });
      const { evidence } = await assembleDisputeEvidence(deps(fake), { disputeId: DISPUTE_ID });
      expect(evidence!.fields.customerPurchaseIp).toBe("198.51.100.2");
      expect(evidence!.sources.checkoutIp).toBe("found");
    });

    it("omits the field and marks the source missing when neither IP exists", async () => {
      const fake = makeFakeRepos({
        order: buildOrder({ checkoutIp: null, refundPolicyAckIp: null }),
      });
      const { evidence } = await assembleDisputeEvidence(deps(fake), { disputeId: DISPUTE_ID });
      expect(evidence!.fields).not.toHaveProperty("customerPurchaseIp");
      expect(evidence!.sources.checkoutIp).toBe("missing");
    });
  });

  it("labels POS/resale orders by channel and source in the dossier", async () => {
    const fake = makeFakeRepos({
      order: buildOrder({ paymentChannel: "POS", source: "RESALE" }),
    });
    const { evidence } = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });
    expect(evidence!.fields.uncategorizedText).toContain(
      "sales channel: POS (resale)",
    );
  });
});

// ── The venue in evidence is gated like the buyer's own address ─────────────
//
// Evidence leaves the platform (Stripe → the cardholder's bank → possibly the
// cardholder), so it may name the venue and its street ONLY when the buyer
// would see them now: revealed, and not NEVER. Otherwise the coarse label.

describe("assembleDisputeEvidence — venue address gate", () => {
  const HOUR = 60 * 60 * 1000;

  /**
   * The fixture's venue, withholding its address. The fixture event is owned
   * by ORG_ID, and so is this venue: the venue's own show (owner arm).
   */
  const withheldPlace = {
    id: PLACE_ID,
    name: "Drkmttr",
    locationMode: "OBSCURED",
    locationRadiusMeters: 800,
    formattedAddress: "1111 Test Ave, Nashville, TN 37201",
    addressLine1: null,
    addressLine2: null,
    city: "Nashville",
    region: "TN",
    postalCode: "37201",
    countryCode: "US",
    timezone: "America/Chicago",
    orgIdsWithAccess: [ORG_ID],
    humanIdsWithAccess: [],
    acceptsCommunityListings: false,
  };

  async function evidenceFor(
    eventOverrides: Parameters<typeof buildEvent>[0],
    place?: Record<string, unknown>,
    extra: Partial<Parameters<typeof makeFakeRepos>[0]> = {},
  ) {
    const fake = makeFakeRepos({
      event: buildEvent({ locality: "Nashville", region: "TN", ...eventOverrides }),
      ...(place ? { place: place as never } : {}),
      ...extra,
    });
    const { evidence } = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });
    return evidence!;
  }

  it("NEVER: the coarse area only — no venue name, no street", async () => {
    const evidence = await evidenceFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "NEVER",
      addressRevealAt: null,
    });
    const text = JSON.stringify(evidence.fields);
    expect(evidence.fields.productDescription).toContain("at Nashville, TN");
    expect(text).not.toContain("1111 Test Ave");
    expect(text).not.toContain("Drkmttr —");
  });

  it("before the reveal: the coarse area only", async () => {
    const evidence = await evidenceFor({
      locationMode: "OBSCURED",
      addressRevealPreset: "DAY_BEFORE",
      addressRevealAt: new Date(NOW.getTime() + HOUR),
    });
    const text = JSON.stringify(evidence.fields);
    expect(evidence.fields.productDescription).toContain("at Nashville, TN");
    expect(text).not.toContain("1111 Test Ave");
  });

  it("after the reveal at a withheld venue: the Place's name and street, not the Event projection", async () => {
    const evidence = await evidenceFor(
      {
        locationMode: "OBSCURED",
        locationRadiusMeters: 800,
        addressRevealPreset: "DAY_BEFORE",
        addressRevealAt: new Date(NOW.getTime() - HOUR),
        // Part 1's storage: the Event row is the venue's public projection.
        addressText: "East Nashville",
      },
      withheldPlace,
    );
    expect(evidence.fields.productDescription).toContain(
      "Drkmttr — 1111 Test Ave",
    );
    expect(JSON.stringify(evidence.fields)).not.toContain("East Nashville");
  });

  it("an EXACT event row at a withheld venue is locked (it has no reveal date)", async () => {
    const evidence = await evidenceFor({}, withheldPlace);
    const text = JSON.stringify(evidence.fields);
    expect(text).not.toContain("1111 Test Ave");
    expect(text).not.toContain("Drkmttr —");
  });

  const revealedAtWithheldVenue = {
    locationMode: "OBSCURED" as const,
    locationRadiusMeters: 800,
    addressRevealPreset: "IMMEDIATELY" as const,
    addressRevealAt: new Date(NOW.getTime() - HOUR),
    addressText: "East Nashville",
  };

  it("C1: a third party's event the venue never confirmed: the coarse area only, for good", async () => {
    const evidence = await evidenceFor(revealedAtWithheldVenue, {
      ...withheldPlace,
      orgIdsWithAccess: ["99999999-9999-4999-8999-999999999999"],
    });
    const text = JSON.stringify(evidence.fields);
    expect(evidence.fields.productDescription).toContain("at Nashville, TN");
    expect(text).not.toContain("1111 Test Ave");
    expect(text).not.toContain("Drkmttr —");
  });

  it("a buyer who no longer holds a ticket: the coarse area only", async () => {
    const refunded = buildTickets().map((t) => ({ ...t, status: "REFUNDED" }));
    const evidence = await evidenceFor(revealedAtWithheldVenue, withheldPlace, {
      tickets: refunded as never,
    });
    const text = JSON.stringify(evidence.fields);
    expect(text).not.toContain("1111 Test Ave");
    expect(text).not.toContain("Drkmttr —");
  });
});

describe("assembleDisputeEvidence — tax wording in the charge line", () => {
  const charged = async (
    taxLines: ReturnType<typeof buildTaxLine>[],
    order = buildOrder(),
    extra = {},
  ) => {
    const fake = makeFakeRepos({ order, taxLines });
    const result = await assembleDisputeEvidence(deps(fake, extra), {
      disputeId: DISPUTE_ID,
    });
    return {
      fake,
      line: result.evidence!.fields.uncategorizedText!
        .split("\n")
        .find((l) => l.startsWith("Amount charged:"))!,
    };
  };

  it("one SALES line reads as 'sales tax' (and is read once)", async () => {
    const { fake, line } = await charged([buildTaxLine()]);
    expect(line).toBe(
      "Amount charged: 55.50 USD (of which 50.00 USD tickets, 4.00 USD sales tax, 1.50 USD fees)",
    );
    expect(fake.repos.orders.listTaxLines).toHaveBeenCalledTimes(1);
  });

  it("lists every PLATFORM line", async () => {
    const { line } = await charged(
      [
        buildTaxLine({ amountCents: 250 }),
        buildTaxLine({
          id: "taxline_2",
          code: "MPLS_ENTERTAINMENT",
          label: "Minneapolis entertainment tax",
          amountCents: 150,
        }),
      ],
    );
    expect(line).toContain(
      "2.50 USD sales tax, 1.50 USD Minneapolis entertainment tax, 1.50 USD fees",
    );
  });

  it("keeps GST/HST upper-case", async () => {
    const { line } = await charged([buildTaxLine({ label: "GST/HST" })]);
    expect(line).toContain("4.00 USD GST/HST");
  });

  it("lines that do not sum to the order's tax fall back to 'tax'", async () => {
    const { line } = await charged([buildTaxLine({ amountCents: 300 })]);
    expect(line).toContain("4.00 USD tax,");
    expect(line).not.toContain("sales tax");
  });

  it("a failing tax-line read is reported and degrades to 'tax'", async () => {
    const fake = makeFakeRepos({ taxLines: [buildTaxLine()] });
    (fake.repos.orders.listTaxLines as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("db down"),
    );
    const reportError = vi.fn();
    const result = await assembleDisputeEvidence(deps(fake, { reportError }), {
      disputeId: DISPUTE_ID,
    });
    expect(result.fallback).toBe(false);
    expect(result.evidence!.fields.uncategorizedText).toContain("4.00 USD tax,");
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it("a failed read reports with the taxLines source tag", async () => {
    const fake = makeFakeRepos({ taxLines: [buildTaxLine()] });
    (fake.repos.orders.listTaxLines as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("db down"),
    );
    const reportError = vi.fn();
    await assembleDisputeEvidence(deps(fake, { reportError }), {
      disputeId: DISPUTE_ID,
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: { useCase: "assembleDisputeEvidence", source: "taxLines" },
      }),
    );
  });

  it("a PLATFORM line plus an ORGANISER line: only the PLATFORM line is listed", async () => {
    const { line } = await charged([
      buildTaxLine(),
      buildTaxLine({
        id: "taxline_2",
        code: "VENUE_LEVY",
        label: "Venue levy",
        collector: "ORGANISER",
        amountCents: 300,
      }),
    ]);
    expect(line).toContain("4.00 USD sales tax, 1.50 USD fees");
    expect(line).not.toContain("Venue levy");
  });

  it("an empty label reads as 'tax'", async () => {
    const { line } = await charged([buildTaxLine({ label: " " })]);
    expect(line).toContain("4.00 USD tax,");
  });

  it("the fallback draft uses the same wording, from the same single read", async () => {
    const fake = makeFakeRepos({
      order: buildOrder({ items: undefined as unknown as never }),
      taxLines: [buildTaxLine()],
    });
    const result = await assembleDisputeEvidence(deps(fake), {
      disputeId: DISPUTE_ID,
    });
    expect(result.fallback).toBe(true);
    expect(result.evidence!.fields.uncategorizedText).toContain(
      "4.00 USD sales tax",
    );
    expect(fake.repos.orders.listTaxLines).toHaveBeenCalledTimes(1);
  });

  it("a failed read with a THROWING reporter and logger still assembles", async () => {
    const fake = makeFakeRepos({ taxLines: [buildTaxLine()] });
    (fake.repos.orders.listTaxLines as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("db down"),
    );
    const boom = () => {
      throw new Error("reporter down");
    };
    const result = await assembleDisputeEvidence(
      deps(fake, {
        reportError: boom,
        logger: { info: vi.fn(), warn: vi.fn(), error: boom },
      }),
      { disputeId: DISPUTE_ID },
    );
    expect(result.fallback).toBe(false);
    expect(result.evidence!.fields.uncategorizedText).toContain("4.00 USD tax,");
  });
});

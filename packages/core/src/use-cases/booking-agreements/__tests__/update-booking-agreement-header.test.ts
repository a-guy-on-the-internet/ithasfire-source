import { describe, expect, it, vi } from "vitest";

import type { AgreementRecord } from "@th/ports/repos/agreements";

import { updateBookingAgreementHeader } from "../update-booking-agreement-header";
import type { UpdateBookingAgreementHeaderDeps } from "../update-booking-agreement-header";
import {
  AGREEMENT_ID,
  NOW,
  TERMS_ID,
  VENUE_PAYEE_ID,
  buildLinkedBookingRequest,
  makeBookingRequestsFake,
  OUTSIDER_ID,
  PERFORMER_ID,
  VENUE_ADMIN_ID,
  VENUE_VIEWER_ID,
  buildAgreementRecord,
  makeAgreementsRepoFake,
  makeAuditFake,
  makeAuthzFake,
  makeClock,
  withTx,
  type AgreementsRepoFakeOptions,
} from "./helpers";

function buildDeps(
  agreement: AgreementRecord | null = buildAgreementRecord(),
  options: AgreementsRepoFakeOptions = {},
) {
  const agreements = makeAgreementsRepoFake(agreement, options);
  const audit = makeAuditFake();
  const authz = makeAuthzFake();

  const deps = {
    repos: withTx({
      agreements: agreements.repo,
      authz,
      audit,
    }) as unknown as UpdateBookingAgreementHeaderDeps["repos"],
    clock: makeClock(),
  } satisfies UpdateBookingAgreementHeaderDeps;

  return { deps, agreements, audit, authz };
}

const baseInput = {
  actorHumanId: PERFORMER_ID,
  agreementId: AGREEMENT_ID,
};

describe("updateBookingAgreementHeader", () => {
  it("lets the proposer human edit a DRAFT header and audits the change", async () => {
    const { deps, agreements, audit } = buildDeps();

    const result = await updateBookingAgreementHeader(deps, {
      ...baseInput,
      title: "Friday headline slot",
      guaranteeCents: 50_000,
    });

    expect(result.title).toBe("Friday headline slot");
    expect(result.guaranteeCents).toBe(50_000);
    expect(result.status).toBe("DRAFT");
    expect(agreements.record()?.title).toBe("Friday headline slot");
    expect(agreements.repo.updateHeader).toHaveBeenCalledWith(
      expect.objectContaining({ expectedFrom: ["DRAFT"] }),
    );
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "booking_agreement",
        action: "booking_agreement.header_updated",
        at: NOW,
      }),
    );
  });

  it("lets a counterparty-org ADMIN edit (collaborative drafting)", async () => {
    const { deps } = buildDeps();

    const result = await updateBookingAgreementHeader(deps, {
      ...baseInput,
      actorHumanId: VENUE_ADMIN_ID,
      description: "Load-in at 6pm.",
    });

    expect(result.description).toBe("Load-in at 6pm.");
  });

  it("rejects a counterparty-org VIEWER (edit-level role required)", async () => {
    const { deps } = buildDeps();

    await expect(
      updateBookingAgreementHeader(deps, {
        ...baseInput,
        actorHumanId: VENUE_VIEWER_ID,
        title: "Nope",
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
  });

  it("rejects a non-party actor", async () => {
    const { deps } = buildDeps();

    await expect(
      updateBookingAgreementHeader(deps, {
        ...baseInput,
        actorHumanId: OUTSIDER_ID,
        title: "Nope",
      }),
    ).rejects.toMatchObject({ code: "NOT_AGREEMENT_PARTY" });
  });

  it("rejects edits while PROPOSED (must pull back first)", async () => {
    const { deps } = buildDeps(buildAgreementRecord({ status: "PROPOSED" }));

    await expect(
      updateBookingAgreementHeader(deps, { ...baseInput, title: "Edited" }),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_DRAFT" });
  });

  it("validates proposedEndDate against the MERGED proposedDate", async () => {
    const { deps } = buildDeps(
      buildAgreementRecord({
        proposedDate: new Date("2026-07-10T20:00:00.000Z"),
      }),
    );

    await expect(
      updateBookingAgreementHeader(deps, {
        ...baseInput,
        proposedEndDate: new Date("2026-07-10T19:00:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: "proposed_end_before_start",
    });
  });

  it("rejects an empty update", async () => {
    const { deps } = buildDeps();

    await expect(
      updateBookingAgreementHeader(deps, { ...baseInput }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects non-integer guaranteeCents (no float money)", async () => {
    const { deps } = buildDeps();

    await expect(
      updateBookingAgreementHeader(deps, {
        ...baseInput,
        guaranteeCents: 99.5,
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("surfaces the write-time CAS conflict when the status flips mid-flight", async () => {
    const { deps } = buildDeps(buildAgreementRecord(), {
      updateConflict: true,
    });

    await expect(
      updateBookingAgreementHeader(deps, { ...baseInput, title: "Racing" }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "agreement_status_changed",
    });
  });

  it("404s on a missing agreement", async () => {
    const { deps } = buildDeps(null);

    await expect(
      updateBookingAgreementHeader(deps, { ...baseInput, title: "Ghost" }),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_FOUND" });
  });
});

/**
 * FR-001: once the terms carry a deal, the header guarantee is The deal's —
 * derived on every deal save — so a typed CHANGE is refused, under the terms
 * lock the deal write takes. Echoing the same value still saves.
 */
describe("updateBookingAgreementHeader — guarantee set by the deal", () => {
  function buildDealDeps(opts: {
    /** Stored remainder holder on the terms: set = a deal exists. */
    remainderPayeeId: string | null;
    linked?: boolean;
    guaranteeCents?: number | null;
  }) {
    const agreements = makeAgreementsRepoFake(
      buildAgreementRecord({ guaranteeCents: opts.guaranteeCents ?? 40_000 }),
    );
    const audit = makeAuditFake();
    const calls: string[] = [];
    const deals = {
      lockTerms: vi.fn(async (id: string) => {
        calls.push(`lock:${id}`);
        return true;
      }),
    };
    const payoutTerms = {
      getById: vi.fn(async (id: string) => {
        calls.push(`terms:${id}`);
        return { id, isDefault: false, remainderPayeeId: opts.remainderPayeeId };
      }),
    };
    const deps = {
      repos: withTx({
        agreements: agreements.repo,
        authz: makeAuthzFake(),
        audit,
        bookingRequests: makeBookingRequestsFake({
          bookingRequest: opts.linked === false ? null : buildLinkedBookingRequest(),
        }),
        deals,
        payoutTerms,
      }) as unknown as UpdateBookingAgreementHeaderDeps["repos"],
      clock: makeClock(),
    } satisfies UpdateBookingAgreementHeaderDeps;
    return { deps, agreements, deals, payoutTerms, calls };
  }

  const editor = { actorHumanId: VENUE_ADMIN_ID, agreementId: AGREEMENT_ID };

  it("refuses a CHANGE to guaranteeCents while a deal exists, after taking the terms lock", async () => {
    const { deps, agreements, calls } = buildDealDeps({ remainderPayeeId: VENUE_PAYEE_ID });

    await expect(
      updateBookingAgreementHeader(deps, { ...editor, guaranteeCents: 50_000 }),
    ).rejects.toMatchObject({
      code: "AGREEMENT_NOT_EDITABLE",
      meta: { reason: "guarantee_set_by_deal", agreementId: AGREEMENT_ID },
    });
    expect(calls[0]).toBe(`lock:${TERMS_ID}`);
    expect(agreements.repo.updateHeader).not.toHaveBeenCalled();
    expect(agreements.record()?.guaranteeCents).toBe(40_000);
  });

  it("refuses clearing it too (null is a change)", async () => {
    const { deps } = buildDealDeps({ remainderPayeeId: VENUE_PAYEE_ID });
    await expect(
      updateBookingAgreementHeader(deps, { ...editor, guaranteeCents: null }),
    ).rejects.toMatchObject({ code: "AGREEMENT_NOT_EDITABLE" });
  });

  it("accepts the same value echoed back alongside a real edit", async () => {
    const { deps, agreements } = buildDealDeps({ remainderPayeeId: VENUE_PAYEE_ID });

    const result = await updateBookingAgreementHeader(deps, {
      ...editor,
      title: "Friday headline slot",
      guaranteeCents: 40_000,
    });

    expect(result.title).toBe("Friday headline slot");
    expect(result.guaranteeCents).toBe(40_000);
    expect(agreements.record()?.guaranteeCents).toBe(40_000);
  });

  it("allows the change while the terms carry no deal", async () => {
    const { deps } = buildDealDeps({ remainderPayeeId: null });
    const result = await updateBookingAgreementHeader(deps, { ...editor, guaranteeCents: 50_000 });
    expect(result.guaranteeCents).toBe(50_000);
  });

  it("allows it on an agreement with no originating request (no act side to derive for)", async () => {
    const { deps, deals } = buildDealDeps({ remainderPayeeId: VENUE_PAYEE_ID, linked: false });
    const result = await updateBookingAgreementHeader(deps, {
      actorHumanId: PERFORMER_ID,
      agreementId: AGREEMENT_ID,
      guaranteeCents: 50_000,
    });
    expect(result.guaranteeCents).toBe(50_000);
    expect(deals.lockTerms).not.toHaveBeenCalled();
  });

  it("takes no lock and reads no terms when the edit leaves the guarantee alone", async () => {
    const { deps, deals, payoutTerms } = buildDealDeps({ remainderPayeeId: VENUE_PAYEE_ID });
    await updateBookingAgreementHeader(deps, { ...editor, title: "Friday headline slot" });
    expect(deals.lockTerms).not.toHaveBeenCalled();
    expect(payoutTerms.getById).not.toHaveBeenCalled();
  });
});

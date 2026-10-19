import { describe, expect, it, vi } from "vitest";

import type { TxRepos } from "@th/ports/repos";
import {
  CURRENT_CHARGEBACK_TERMS_TEXT,
  CURRENT_CHARGEBACK_TERMS_VERSION,
  getCurrentChargebackTermsSnapshot,
  requireAnyChargebackTermsForRiskOwner,
  requireCurrentChargebackTermsForRiskOwner,
} from "./chargeback-terms";

/**
 * The organizer chargeback / payout-hold terms are LEGAL COPY. Every other
 * test in the repo reads `CURRENT_CHARGEBACK_TERMS_VERSION` rather than
 * pinning the literal, so a bump stays a one-line change — this file is the
 * single place that pins the literal, which makes bumping it a deliberate
 * act rather than a side effect of editing prose.
 */
describe("CURRENT_CHARGEBACK_TERMS_VERSION", () => {
  it("is the 2026-09-03 revision", () => {
    expect(CURRENT_CHARGEBACK_TERMS_VERSION).toBe("2026-09-03");
  });
});

const paragraphs = CURRENT_CHARGEBACK_TERMS_TEXT.split("\n\n");

describe("CURRENT_CHARGEBACK_TERMS_TEXT", () => {
  it("is ten non-empty paragraphs joined on a blank line", () => {
    // The renderer (`ChargebackTermsContent.tsx`) splits on exactly this
    // separator and maps every entry, keyed by the paragraph text — an empty
    // or duplicated entry would collide keys and drop a paragraph.
    expect(paragraphs).toHaveLength(10);
    for (const paragraph of paragraphs) {
      expect(paragraph.trim()).toBe(paragraph);
      expect(paragraph.length).toBeGreaterThan(0);
    }
    expect(new Set(paragraphs).size).toBe(paragraphs.length);
  });

  it("leaks no internal identifier into organizer-facing copy", () => {
    // `reservePct` appeared verbatim in the 2026-05-17 text. Legal copy names
    // behaviour, never schema — and this one never even had a column.
    for (const identifier of [
      "reservePct",
      "PayeeLedgerEntry",
      "debitDisputeLoss",
      "feeBorneBy",
    ]) {
      expect(CURRENT_CHARGEBACK_TERMS_TEXT).not.toContain(identifier);
    }
  });

  it("does not restate the four claims the 2026-05-17 text got wrong", () => {
    // Each of these overstated what the platform takes, or promised an SLA
    // no code implements. See docs/records/2026-09-02-chargeback-terms-counsel-brief.md.
    for (const stale of [
      "and any related processor fees",
      "rolling reserves",
      "within 24 hours",
      "10 business days",
    ]) {
      expect(CURRENT_CHARGEBACK_TERMS_TEXT).not.toContain(stale);
    }
  });

  it("states the corrections that replaced them", () => {
    const text = CURRENT_CHARGEBACK_TERMS_TEXT;
    // Dispute fee: platform's on ticketing, payee's on memberships.
    expect(text).toContain(
      "the card network's dispute fee is ours and is not passed on to you",
    );
    // Recovery is capped at what the payee was credited, and refunds zero it.
    expect(text).toContain(
      "We never take back more than you were paid for the order",
    );
    // Dispute recovery is payouts-only and never a bank debit...
    expect(text).toContain(
      "Ithas Fire recovers dispute balances from your payouts and does not debit your bank account",
    );
    // ...but a refund reverses the transfer, so the copy must NOT promise the
    // same for refunds (`reverseTransfersForItems` pulls from the connected
    // account, and Stripe governs a resulting negative balance).
    expect(text).toContain(
      "A refund works differently: it reverses the transfer we already sent you",
    );
    // The real membership seasoning reserve, not "no reserves at launch".
    expect(text).toContain(
      "10% of each membership payout for your first 90 days",
    );
    // A reachable route to contest a hold replaces the placeholder SLAs.
    expect(text).toContain("support@ithasfire.com");
  });
});

describe("getCurrentChargebackTermsSnapshot", () => {
  it("returns exactly the current version and text — no other fields", () => {
    expect(getCurrentChargebackTermsSnapshot()).toEqual({
      version: CURRENT_CHARGEBACK_TERMS_VERSION,
      text: CURRENT_CHARGEBACK_TERMS_TEXT,
    });
  });
});

const ORG_ID = "33333333-3333-4333-8333-333333333333";
const ACCEPTOR_ID = "11111111-1111-4111-8111-111111111111";

function reposForOrgOn(version: string | null) {
  return {
    organizations: {
      getById: vi.fn(async () => ({
        id: ORG_ID,
        chargebackTermsVersion: version,
        chargebackTermsAcceptedAt: version ? new Date("2026-06-01") : null,
        chargebackTermsAcceptedByHumanId: version ? ACCEPTOR_ID : null,
      })),
    },
    humans: { getById: vi.fn() },
  } as unknown as Pick<TxRepos, "organizations" | "humans">;
}

const OWNER = { type: "ORGANIZATION", id: ORG_ID } as const;

describe("the version bump's runtime blast radius", () => {
  it("fails the STRICT Connect gate for an owner still on 2026-05-17", async () => {
    await expect(
      requireCurrentChargebackTermsForRiskOwner({
        repos: reposForOrgOn("2026-05-17"),
        owner: OWNER,
      }),
    ).rejects.toMatchObject({
      code: "chargeback_terms_required",
      requiredVersion: "2026-09-03",
      meta: { owner: OWNER, requiredVersion: "2026-09-03" },
    });
  });

  it("still passes the VERSION-AGNOSTIC publish/checkout backstop", async () => {
    // The whole point of the split gate: a copy correction must not take
    // every already-published paid event offline.
    await expect(
      requireAnyChargebackTermsForRiskOwner({
        repos: reposForOrgOn("2026-05-17"),
        owner: OWNER,
      }),
    ).resolves.toBeUndefined();
  });

  it("passes the strict gate once the owner accepts the current version", async () => {
    await expect(
      requireCurrentChargebackTermsForRiskOwner({
        repos: reposForOrgOn(CURRENT_CHARGEBACK_TERMS_VERSION),
        owner: OWNER,
      }),
    ).resolves.toBeUndefined();
  });

  it("fails both gates for an owner who never accepted", async () => {
    await expect(
      requireAnyChargebackTermsForRiskOwner({
        repos: reposForOrgOn(null),
        owner: OWNER,
      }),
    ).rejects.toMatchObject({ code: "chargeback_terms_required" });
  });
});

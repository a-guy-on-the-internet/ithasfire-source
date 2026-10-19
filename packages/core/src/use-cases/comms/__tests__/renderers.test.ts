import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  listNotificationRendererVariants,
  renderNotification,
} from "../renderers";

describe("settlement.payout-completed renderer", () => {
  const basePayload = {
    payeeId: "10000000-0000-4000-8000-000000000001",
    payoutId: "20000000-0000-4000-8000-000000000002",
    payoutItemId: "30000000-0000-4000-8000-000000000003",
    amountCents: 12_500,
    currency: "usd",
    settlementCount: 2,
  } as const;

  const NOW = new Date("2026-06-23T00:00:00.000Z");

  // The 2026-09-20 first real payout, as the enriched notifier now sends it.
  const fullPayload = {
    ...basePayload,
    amountCents: 1_064,
    settlementCount: 2,
    kind: "payout",
    payoutDateIso: "2026-09-20T05:00:03.000Z",
    payoutsUrl: "https://ithasfire.com/admin/ithas-fire/payments",
    orgName: "Ithas Fire",
    displayTimezone: "America/Chicago",
    lines: [
      {
        eventTitle: "Launch Party",
        eventStartsAtIso: "2026-09-18T01:00:00.000Z",
        eventTimezone: "America/Chicago",
        ticketCount: 3,
        amountCents: 900,
        orderId: "60000000-0000-4000-8000-000000000001",
      },
      {
        eventTitle: null,
        eventStartsAtIso: null,
        eventTimezone: null,
        ticketCount: 1,
        amountCents: 300,
        orderId: "60000000-0000-4000-8000-000000000002",
      },
    ],
    recoveredDebtCents: 0,
    connectAccountFeeCents: 136,
    reserveHeldCents: 0,
    reserveReleasedCents: 0,
    otherSalesCount: 0,
    otherSalesCents: 0,
    balanceAfterCents: 4_200,
    nextPayableAtIso: "2026-09-27T05:00:00.000Z",
    bankDelayDays: 2,
    stripeDashboardUrl: "https://connect.stripe.com/express_login",
  } as const;

  type Vars = {
    kind: string;
    amountCents: number;
    lines: Array<{ amountCents: number }>;
    otherSalesCents: number;
    reserveReleasedCents: number;
    adjustmentsCents: number;
    recoveredDebtCents: number;
    connectAccountFeeCents: number;
    reserveHeldCents: number;
  };

  /**
   * The contract identity the renderer must make true by construction:
   *   Σlines + other + released + adjustments − debt − fee − reserveHeld
   *     === amountCents
   * For the no-transfer kinds `amountCents` IS the reserve / the debt (the
   * single destination row), so that one withholding is excluded — the
   * literal identity would double-count it by exactly that amount.
   */
  function reconciles(vars: Vars): boolean {
    const debtRow =
      vars.kind === "applied_to_balance" ? 0 : vars.recoveredDebtCents;
    const reserveRow = vars.kind === "reserved" ? 0 : vars.reserveHeldCents;
    const sum =
      vars.lines.reduce((acc, l) => acc + l.amountCents, 0) +
      vars.otherSalesCents +
      vars.reserveReleasedCents +
      vars.adjustmentsCents -
      debtRow -
      vars.connectAccountFeeCents -
      reserveRow;
    return sum === vars.amountCents;
  }

  function varsOf(result: ReturnType<typeof renderNotification>): Vars {
    return result.email?.template?.variables as unknown as Vars;
  }

  it("renders a transactional SUCCESS in-app + email payload with a link", () => {
    const payload = {
      ...basePayload,
      payoutsUrl: "https://example.com/admin/acme/payments",
      payoutDateIso: "2026-06-21T00:00:00.000Z",
    } as const;

    const result = renderNotification("settlement.payout-completed", payload, {
      now: NOW,
    });

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "You've been paid",
      // "sales" (credits ≈ orders), never "events"; "was sent", never "is on
      // its way to your bank" — we send it, the bank decides when it lands.
      body: "$125.00 from 2 sales was sent to your Stripe account.",
      kind: "SUCCESS",
      action: {
        label: "View payouts",
        href: "https://example.com/admin/acme/payments",
      },
      expiresAt: null,
      tags: ["settlement", "payout", "completed"],
      metadata: {
        payoutId: payload.payoutId,
        payoutItemId: payload.payoutItemId,
        payeeId: payload.payeeId,
        currency: payload.currency,
      },
      template: null,
    });

    expect(result.email).toEqual({
      subject: "You've been paid $125.00",
      text: expect.stringContaining(
        "View payouts: https://example.com/admin/acme/payments",
      ),
      template: expect.objectContaining({ key: "settlement.payout_sent" }),
      tags: ["settlement", "payout", "completed"],
      metadata: expect.objectContaining({
        payoutItemId: payload.payoutItemId,
        payeeId: payload.payeeId,
      }),
    });

    expect(result.fingerprint).toEqual({
      variant: "settlement.payout-completed",
      payoutItemId: payload.payoutItemId,
      amountCents: payload.amountCents,
      currency: payload.currency,
    });
  });

  it("Email template contract — must match @th/ui-email's settlement.payout_sent props exactly", () => {
    const result = renderNotification("settlement.payout-completed", fullPayload, {
      now: NOW,
    });

    // Exact object, not objectContaining: a stray or missing prop fails
    // render_failed AFTER the derived idempotency key is claimed.
    expect(result.email?.template).toEqual({
      key: "settlement.payout_sent",
      variables: {
        kind: "payout",
        amountCents: 1_064,
        currency: "usd",
        orgName: "Ithas Fire",
        payoutDateIso: "2026-09-20T05:00:03.000Z",
        displayTimezone: "America/Chicago",
        lines: [
          {
            eventTitle: "Launch Party",
            eventStartsAtIso: "2026-09-18T01:00:00.000Z",
            eventTimezone: "America/Chicago",
            ticketCount: 3,
            amountCents: 900,
            orderId: "60000000-0000-4000-8000-000000000001",
          },
          {
            eventTitle: null,
            eventStartsAtIso: null,
            eventTimezone: null,
            ticketCount: 1,
            amountCents: 300,
            orderId: "60000000-0000-4000-8000-000000000002",
          },
        ],
        recoveredDebtCents: 0,
        connectAccountFeeCents: 136,
        reserveHeldCents: 0,
        reserveReleasedCents: 0,
        otherSalesCount: 0,
        otherSalesCents: 0,
        // 900 + 300 − 136 = 1064: nothing left to explain.
        adjustmentsCents: 0,
        balanceAfterCents: 4_200,
        nextPayableAtIso: "2026-09-27T05:00:00.000Z",
        bankDelayDays: 2,
        payoutsUrl: "https://ithasfire.com/admin/ithas-fire/payments",
        stripeDashboardUrl: "https://connect.stripe.com/express_login",
        settlementCount: 2,
      },
    });
    expect(reconciles(varsOf(result))).toBe(true);
    expect(result.inApp?.action).toEqual({
      label: "View payouts",
      href: "https://ithasfire.com/admin/ithas-fire/payments",
    });
    expect(result.email?.subject).toBe("You've been paid $10.64");
  });

  it("writes the plain-text statement: day-month dates in the payee's zone, withholdings, balance, links", () => {
    const result = renderNotification("settlement.payout-completed", fullPayload, {
      now: NOW,
    });
    const text = result.email?.text ?? "";

    // Day-month order to match the HTML template ("Sun 20 Sep", not
    // "Sun, Sep 20"); 05:00Z on the 20th is 00:00 Sunday in Chicago.
    expect(text.startsWith("ITHAS FIRE — PAYOUT · Sun 20 Sep\n")).toBe(true);
    expect(text).toContain(
      "$10.64\nSent to your Stripe account on Sunday 20 September.",
    );
    expect(text).toMatch(/We sent it \.+ Sun 20 Sep\n/);
    expect(text).toMatch(
      /Your bank \.+ on Stripe's schedule, about 2 days for this account\n/,
    );
    expect(text).toContain("WHERE IT CAME FROM");
    // 01:00Z on the 18th is Thu the 17th in Chicago.
    expect(text).toMatch(/Launch Party \(Thu 17 Sep, 3 tickets\) \.+ \$9\.00/);
    expect(text).toMatch(/Sale \(1 ticket\) \.+ \$3\.00/);
    expect(text).toMatch(/Stripe account fee withheld \.+ −\$1\.36/);
    expect(text).toMatch(/Sent to your Stripe account \.+ −\$10\.64/);
    expect(text).toMatch(
      /Still owed to Ithas Fire \.+ \$42\.00 — next payout Sun 27 Sep/,
    );
    expect(text).not.toContain("other sales");
    expect(text).not.toContain("Reserve released");
    expect(text).not.toContain("Other adjustments");
    expect(text).not.toContain("Applied to an earlier refund");
    expect(text).not.toContain("Held in reserve");
    expect(text).not.toContain("Nothing was withheld.");
    expect(text).toContain("$42.00 is still coming.");
    expect(text).toContain(
      "View payouts: https://ithasfire.com/admin/ithas-fire/payments",
    );
    expect(text).toContain(
      "Stripe dashboard: https://connect.stripe.com/express_login",
    );
  });

  it("reserve release: the returned reserve is a source row, the statement reconciles, and 'Nothing was withheld' is NOT claimed", () => {
    // One $100 credit, $20 of matured reserve returned on the same transfer
    // → $120 sent. Without the release row the reader sees $20 from nowhere.
    const result = renderNotification(
      "settlement.payout-completed",
      {
        ...fullPayload,
        amountCents: 12_000,
        settlementCount: 1,
        lines: [{ ...fullPayload.lines[0], amountCents: 10_000 }],
        connectAccountFeeCents: 0,
        reserveReleasedCents: 2_000,
        balanceAfterCents: null,
        nextPayableAtIso: null,
      },
      { now: NOW },
    );
    const vars = varsOf(result);
    expect(vars.adjustmentsCents).toBe(0);
    expect(vars.reserveReleasedCents).toBe(2_000);
    expect(reconciles(vars)).toBe(true);

    const text = result.email?.text ?? "";
    expect(text).toMatch(/Launch Party \(Thu 17 Sep, 3 tickets\) \.+ \$100\.00/);
    expect(text).toMatch(/Reserve released back to you \.+ \+\$20\.00/);
    expect(text).toMatch(/Sent to your Stripe account \.+ −\$120\.00/);
    expect(text).not.toContain("Other adjustments");
    // A "+$20.00" row sits directly above the closing line; "Nothing was
    // withheld" there would read as a contradiction. Matches the HTML gate.
    expect(text).not.toContain("Nothing was withheld.");
    // Row order: sales, release, (deductions), destination.
    expect(text.indexOf("Launch Party")).toBeLessThan(
      text.indexOf("Reserve released"),
    );
    expect(text.indexOf("Reserve released")).toBeLessThan(
      text.indexOf("Sent to your Stripe account ."),
    );
  });

  it("line cap: 30 credits → 25 lines plus an 'other sales' row carrying the rest, reconciled", () => {
    // What the notifier sends for 30 credits of $1..$30: the 25 largest as
    // lines, the 5 smallest ($1+$2+$3+$4+$5 = $15) as "other sales".
    const lines = Array.from({ length: 25 }, (_, i) => ({
      eventTitle: `Show ${i + 6}`,
      eventStartsAtIso: null,
      eventTimezone: null,
      ticketCount: 1,
      amountCents: (i + 6) * 100,
      orderId: null,
    }));
    const linesCents = lines.reduce((acc, l) => acc + l.amountCents, 0);
    const result = renderNotification(
      "settlement.payout-completed",
      {
        ...fullPayload,
        settlementCount: 30,
        amountCents: linesCents + 1_500,
        lines,
        connectAccountFeeCents: 0,
        otherSalesCount: 5,
        otherSalesCents: 1_500,
      },
      { now: NOW },
    );
    const vars = varsOf(result);
    expect(vars.lines).toHaveLength(25);
    expect(vars.adjustmentsCents).toBe(0);
    expect(reconciles(vars)).toBe(true);

    const text = result.email?.text ?? "";
    expect(text).toMatch(/5 other sales \.+ \+\$15\.00/);
    expect(text).not.toContain("Other adjustments");
    expect(text).toContain("Nothing was withheld.");
    // The "other sales" row follows the itemised lines.
    expect(text.indexOf("Show 30")).toBeLessThan(text.indexOf("5 other sales"));
  });

  it("refund residual: Σcredits > sent → a signed 'Other adjustments' row, and NOT 'Nothing was withheld'", () => {
    // A REFUND_DEBIT shrank the payable to $60 but the $100 SETTLEMENT_CREDIT
    // row is unchanged. The −$40 must be shown, not silently absorbed.
    const result = renderNotification(
      "settlement.payout-completed",
      {
        ...fullPayload,
        amountCents: 6_000,
        settlementCount: 1,
        lines: [{ ...fullPayload.lines[0], amountCents: 10_000 }],
        connectAccountFeeCents: 0,
        balanceAfterCents: 0,
        nextPayableAtIso: null,
      },
      { now: NOW },
    );
    const vars = varsOf(result);
    expect(vars.adjustmentsCents).toBe(-4_000);
    expect(reconciles(vars)).toBe(true);

    const text = result.email?.text ?? "";
    expect(text).toMatch(/Other adjustments \.+ −\$40\.00/);
    expect(text).toMatch(/Sent to your Stripe account \.+ −\$60\.00/);
    expect(text).not.toContain("Nothing was withheld.");
    expect(text).toContain("Nothing else is waiting to be paid.");
    // Deductions come after the source rows and before the destination.
    expect(text.indexOf("Launch Party")).toBeLessThan(
      text.indexOf("Other adjustments"),
    );
    expect(text.indexOf("Other adjustments")).toBeLessThan(
      text.indexOf("Sent to your Stripe account ."),
    );
  });

  it("a minimal legacy payload renders with defaults and an UNCHANGED fingerprint", () => {
    const result = renderNotification("settlement.payout-completed", basePayload, {
      now: NOW,
    });

    // Fingerprint never reads the enrichment fields — a re-send of an old
    // payload must dedupe against the pre-enrichment key.
    expect(result.fingerprint).toEqual({
      variant: "settlement.payout-completed",
      payoutItemId: basePayload.payoutItemId,
      amountCents: 12_500,
      currency: "usd",
    });
    expect(result.email?.template).toEqual({
      key: "settlement.payout_sent",
      variables: {
        kind: "payout",
        amountCents: 12_500,
        currency: "usd",
        orgName: null,
        payoutDateIso: NOW.toISOString(),
        displayTimezone: "UTC",
        lines: [],
        recoveredDebtCents: 0,
        connectAccountFeeCents: 0,
        reserveHeldCents: 0,
        reserveReleasedCents: 0,
        // No itemised lines at all → every sale is "other", at the gross
        // the deductions reconcile to, so there is nothing left to adjust.
        otherSalesCount: 2,
        otherSalesCents: 12_500,
        adjustmentsCents: 0,
        balanceAfterCents: null,
        nextPayableAtIso: null,
        bankDelayDays: null,
        payoutsUrl: null,
        stripeDashboardUrl: "https://connect.stripe.com/express_login",
        settlementCount: 2,
      },
    });
    expect(reconciles(varsOf(result))).toBe(true);
    expect(result.inApp?.action).toBeNull();

    const text = result.email?.text ?? "";
    expect(text.startsWith("ITHAS FIRE — PAYOUT · Tue 23 Jun\n")).toBe(true);
    // No per-order lines → one row for the lot, at the gross.
    expect(text).toMatch(/2 sales \.+ \$125\.00/);
    expect(text).not.toContain("other sales");
    expect(text).toMatch(/Sent to your Stripe account \.+ −\$125\.00/);
    // Unknown balance: no "still owed" row and no claim either way.
    expect(text).not.toContain("Still owed");
    expect(text).not.toContain("is still coming");
    expect(text).not.toContain("Nothing else is waiting");
    expect(text).toContain("Nothing was withheld.");
    expect(text).not.toContain("View payouts:");
    expect(text).toContain(
      "Stripe dashboard: https://connect.stripe.com/express_login",
    );
  });

  it("negative balance: the Still-owed row shows the signed figure and no closing sentence is claimed", () => {
    const result = renderNotification(
      "settlement.payout-completed",
      { ...fullPayload, balanceAfterCents: -5_000, nextPayableAtIso: null },
      { now: NOW },
    );
    const text = result.email?.text ?? "";
    expect(text).toContain("Still owed");
    expect(text).toContain("-$50.00");
    expect(text).not.toContain("is still coming");
    expect(text).not.toContain("Nothing else");
  });

  it("zero balance is kind-aware: 'outstanding' for the no-transfer kinds, 'waiting to be paid' for a payout", () => {
    const held = renderNotification(
      "settlement.payout-completed",
      {
        ...fullPayload,
        kind: "reserved",
        reserveHeldCents: 1_064,
        balanceAfterCents: 0,
        nextPayableAtIso: null,
      },
      { now: NOW },
    );
    expect(held.email?.text).toContain("Nothing else is outstanding.");
    expect(held.email?.text).not.toContain("waiting to be paid");

    const paid = renderNotification(
      "settlement.payout-completed",
      { ...fullPayload, balanceAfterCents: 0, nextPayableAtIso: null },
      { now: NOW },
    );
    expect(paid.email?.text).toContain("Nothing else is waiting to be paid.");
    expect(paid.email?.text).not.toContain("outstanding");
  });

  it("omits bank timing when bankDelayDays is null, and says it when known", () => {
    const unknown = renderNotification(
      "settlement.payout-completed",
      { ...fullPayload, bankDelayDays: null },
      { now: NOW },
    );
    expect(unknown.email?.text).toMatch(/Your bank \.+ on Stripe's schedule\n/);
    expect(unknown.email?.text).not.toContain("about");
    expect(unknown.email?.text).not.toContain("for this account");

    const oneDay = renderNotification(
      "settlement.payout-completed",
      { ...fullPayload, bankDelayDays: 1 },
      { now: NOW },
    );
    expect(oneDay.email?.text).toContain("about 1 day for this account");
  });

  it("caps the dot-leader column so a 140-char title cannot push every value off the edge", () => {
    const longTitle = "A".repeat(140);
    const result = renderNotification(
      "settlement.payout-completed",
      {
        ...fullPayload,
        lines: [{ ...fullPayload.lines[0], eventTitle: longTitle }],
        amountCents: 900 - 136,
      },
      { now: NOW },
    );
    const text = result.email?.text ?? "";
    // The long label gets the 2-dot minimum; short labels align to the
    // capped column (40-char label + space + dots + space = index 43).
    expect(text).toContain(`${longTitle} (Thu 17 Sep, 3 tickets) .. $9.00`);
    const feeRow = text.split("\n").find((l) => l.startsWith("Stripe account fee"))!;
    expect(feeRow.indexOf(" −$1.36")).toBeLessThanOrEqual(43);
  });

  it("reserved: never says 'paid', lists the reserve once as where the money went, still reconciles", () => {
    // kind: "reserved" = the rolling reserve (and the fee) consumed the whole
    // payout. No transfer, but the money is still theirs.
    const payload = {
      ...fullPayload,
      kind: "reserved",
      amountCents: 1_064,
      reserveHeldCents: 1_064,
      connectAccountFeeCents: 136,
    } as const;

    const result = renderNotification("settlement.payout-completed", payload, {
      now: NOW,
    });

    expect(result.email?.subject).toBe(
      "Your $10.64 payout is being held in reserve",
    );
    expect(result.email?.subject.toLowerCase()).not.toContain("paid");
    expect(result.inApp).toEqual(
      expect.objectContaining({
        title: "Payout held in reserve",
        body: "$10.64 from 2 sales is being held in reserve and will be released with a future payout. No bank transfer was sent.",
        kind: "INFO",
      }),
    );
    // amountCents IS the reserve here: 1200 − 136 − 1064 = 0, no residual.
    const vars = varsOf(result);
    expect(vars.adjustmentsCents).toBe(0);
    expect(reconciles(vars)).toBe(true);

    const text = result.email?.text ?? "";
    expect(text.toLowerCase()).not.toContain("paid");
    expect(text.startsWith("ITHAS FIRE — PAYOUT HELD · Sun 20 Sep\n")).toBe(true);
    expect(text).toContain("Held in reserve on Sunday 20 September.");
    expect(text).toContain("No bank transfer was sent.");
    expect(text).not.toContain("We sent it");
    expect(text).not.toContain("Your bank");
    // The reserve is the destination ROW, listed once — not also as a
    // withholding above it (the intro sentence names it too; count rows).
    expect(text.match(/Held in reserve \.+/g)).toHaveLength(1);
    expect(text).toMatch(/Held in reserve \.+ −\$10\.64/);
    expect(text).toMatch(/Stripe account fee withheld \.+ −\$1\.36/);
    expect(text).not.toContain("Other adjustments");
    expect(text).not.toContain("Nothing was withheld.");
    expect(result.email?.template).toEqual(
      expect.objectContaining({
        key: "settlement.payout_sent",
        variables: expect.objectContaining({ kind: "reserved" }),
      }),
    );
  });

  it("renders distinct applied-to-balance copy for a fully-withheld payout", () => {
    // kind: "applied_to_balance" = debt recovery consumed the whole payout.
    // No money moved, so "you've been paid" would lie and silence would look
    // like a missing payout — the copy must say where the money went.
    const payload = {
      ...basePayload,
      kind: "applied_to_balance",
      recoveredDebtCents: 12_500,
      payoutsUrl: "https://example.com/admin/acme/payments",
    } as const;

    const result = renderNotification("settlement.payout-completed", payload, {
      now: NOW,
    });

    expect(result.inApp).toEqual(
      expect.objectContaining({
        title: "Payout applied to your outstanding balance",
        body: "$125.00 from 2 sales was applied to your outstanding balance from a lost dispute. No bank transfer was sent.",
        kind: "INFO",
      }),
    );
    // "covered", not "was applied to" — the latter reads as money taken.
    expect(result.email?.subject).toBe(
      "Your $125.00 payout covered your outstanding balance",
    );
    expect(result.email?.subject.toLowerCase()).not.toContain("paid");
    // amountCents IS the debt here: the destination row carries it and the
    // "Applied to an earlier refund" deduction is suppressed.
    const vars = varsOf(result);
    expect(vars.adjustmentsCents).toBe(0);
    expect(reconciles(vars)).toBe(true);
    const text = result.email?.text ?? "";
    expect(text).toContain("No bank transfer was sent.");
    expect(text.toLowerCase()).not.toContain("paid");
    expect(text).not.toContain("Applied to an earlier refund");
    expect(text).toMatch(
      /Applied to your outstanding balance \.+ −\$125\.00/,
    );
    expect(text).not.toContain("Nothing was withheld.");
  });

  it("treats an explicit kind: 'payout' identically to the omitted default", () => {
    const explicit = renderNotification(
      "settlement.payout-completed",
      { ...basePayload, kind: "payout" } as const,
      { now: NOW },
    );
    const omitted = renderNotification("settlement.payout-completed", basePayload, {
      now: NOW,
    });

    expect(explicit.inApp).toEqual(omitted.inApp);
    expect(explicit.email).toEqual(omitted.email);
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "settlement.payout-completed",
        {
          ...basePayload,
          payeeId: "not-a-uuid",
        },
        { now: NOW },
      ),
    ).toThrow();

    expect(() =>
      renderNotification(
        "settlement.payout-completed",
        {
          ...basePayload,
          kind: "not-a-kind",
        },
        { now: NOW },
      ),
    ).toThrow();

    expect(() =>
      renderNotification(
        "settlement.payout-completed",
        {
          ...basePayload,
          unexpected: "field",
        },
        { now: NOW },
      ),
    ).toThrow();

    // Lines are strict too: an extra key on a row is a contract drift.
    expect(() =>
      renderNotification(
        "settlement.payout-completed",
        {
          ...fullPayload,
          lines: [{ ...fullPayload.lines[0], extra: true }],
        },
        { now: NOW },
      ),
    ).toThrow();

    // An empty zone string is a bug upstream, not "UTC".
    expect(() =>
      renderNotification(
        "settlement.payout-completed",
        {
          ...fullPayload,
          lines: [{ ...fullPayload.lines[0], eventTimezone: "" }],
        },
        { now: NOW },
      ),
    ).toThrow();
  });
});

describe("volunteer.occurrence-cancelled renderer", () => {
  const basePayload = {
    askId: "40000000-0000-4000-8000-000000000004",
    askTitle: "Door help every Friday",
    occurrenceId: "50000000-0000-4000-8000-000000000005",
    roleName: "Door",
    startsAtIso: "2026-07-10T19:00:00.000Z",
    endsAtIso: "2026-07-10T23:00:00.000Z",
    askUrl: "https://example.com/v/40000000-0000-4000-8000-000000000004",
  } as const;

  it("renders a claimant-facing cancellation with a schedule action", () => {
    const result = renderNotification(
      "volunteer.occurrence-cancelled",
      basePayload,
      { now: new Date("2026-07-01T00:00:00.000Z") },
    );

    expect(result.category).toBe("transactional");
    expect(result.inApp?.title).toBe(
      "Your Door shift for Door help every Friday was cancelled",
    );
    expect(result.inApp?.action).toEqual({
      label: "View the schedule",
      href: basePayload.askUrl,
    });
    // Stale cancellations expire with the slot itself.
    expect(result.inApp?.expiresAt).toEqual(new Date(basePayload.endsAtIso));
    expect(result.email?.text).toContain(basePayload.askUrl);
    expect(result.fingerprint).toMatchObject({
      variant: "volunteer.occurrence-cancelled",
      occurrenceId: basePayload.occurrenceId,
    });
  });

  it("rejects an unknown extra field (strict schema)", () => {
    expect(() =>
      renderNotification(
        "volunteer.occurrence-cancelled",
        { ...basePayload, unexpected: "field" },
        { now: new Date("2026-07-01T00:00:00.000Z") },
      ),
    ).toThrow();
  });
});

describe("volunteer.spot-opened renderer", () => {
  const basePayload = {
    eventId: "40000000-0000-4000-8000-000000000004",
    eventTitle: "Night Market",
    roleId: "60000000-0000-4000-8000-000000000006",
    roleName: "Security",
    shiftId: "70000000-0000-4000-8000-000000000007",
    shiftLabel: "Teardown",
    pendingCount: 3,
    withdrawnSignupId: "80000000-0000-4000-8000-000000000008",
    signupsUrl: "https://example.com/admin/org/events/evt/volunteers",
  } as const;

  it("renders an admin-facing in-app payload with a Review signups action", () => {
    const result = renderNotification("volunteer.spot-opened", basePayload, {
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "A volunteer spot opened at Night Market",
      body: "A volunteer spot opened on Night Market — Security/Teardown. 3 pending applications are waiting.",
      kind: "INFO",
      action: {
        label: "Review signups",
        href: basePayload.signupsUrl,
      },
      expiresAt: null,
      tags: ["volunteer", "signup", "spot-opened"],
      metadata: {
        eventId: basePayload.eventId,
        roleId: basePayload.roleId,
        shiftId: basePayload.shiftId,
        withdrawnSignupId: basePayload.withdrawnSignupId,
        pendingCount: "3",
      },
      template: null,
    });

    expect(result.email).toEqual({
      subject: "A volunteer spot opened at Night Market",
      text: expect.stringContaining(basePayload.signupsUrl),
      tags: ["volunteer", "signup", "spot-opened"],
      metadata: expect.objectContaining({
        eventId: basePayload.eventId,
        withdrawnSignupId: basePayload.withdrawnSignupId,
      }),
    });

    expect(result.fingerprint).toMatchObject({
      variant: "volunteer.spot-opened",
      withdrawnSignupId: basePayload.withdrawnSignupId,
      pendingCount: 3,
    });
  });

  it("renders shiftless targets with singular pending copy", () => {
    const result = renderNotification(
      "volunteer.spot-opened",
      {
        ...basePayload,
        shiftId: null,
        shiftLabel: null,
        pendingCount: 1,
      },
      { now: new Date("2026-06-01T00:00:00.000Z") },
    );

    expect(result.inApp?.body).toBe(
      "A volunteer spot opened on Night Market — Security. 1 pending application is waiting.",
    );
    expect(result.inApp?.metadata).not.toHaveProperty("shiftId");
    expect(result.fingerprint).toMatchObject({ shiftId: null });
  });
});

describe("volunteer.signup-approved renderer", () => {
  const basePayload = {
    eventId: "40000000-0000-4000-8000-000000000004",
    askId: null,
    eventTitle: "Night Market",
    roleId: "60000000-0000-4000-8000-000000000006",
    roleName: "Security",
    signupId: "80000000-0000-4000-8000-000000000008",
    shiftLabel: null,
    shiftStartsAtIso: null,
    shiftEndsAtIso: null,
    reviewerName: "Alex Rivera",
    organizerContactEmail: null,
    destinationUrl:
      "https://example.com/events/40000000-0000-4000-8000-000000000004",
  } as const;

  it("links event-path approvals to the event page (View event action)", () => {
    const result = renderNotification("volunteer.signup-approved", basePayload, {
      now: new Date("2026-06-01T00:00:00.000Z"),
    });

    expect(result.inApp?.action).toEqual({
      label: "View event",
      href: basePayload.destinationUrl,
    });
    expect(result.email?.text).toContain(basePayload.destinationUrl);
    expect(result.email?.template?.variables).toMatchObject({
      destinationUrl: basePayload.destinationUrl,
      destinationLabel: "View event",
    });
  });

  it("links ask-path approvals to the public ask page (View details action)", () => {
    const askUrl = "https://example.com/v/50000000-0000-4000-8000-000000000005";
    const result = renderNotification(
      "volunteer.signup-approved",
      {
        ...basePayload,
        eventId: null,
        askId: "50000000-0000-4000-8000-000000000005",
        destinationUrl: askUrl,
      },
      { now: new Date("2026-06-01T00:00:00.000Z") },
    );

    expect(result.inApp?.action).toEqual({
      label: "View details",
      href: askUrl,
    });
    expect(result.email?.text).toContain(askUrl);
    expect(result.email?.template?.variables).toMatchObject({
      destinationUrl: askUrl,
      destinationLabel: "View details",
    });
  });

  it("renders a null action when no destination URL is provided", () => {
    const result = renderNotification(
      "volunteer.signup-approved",
      { ...basePayload, destinationUrl: null },
      { now: new Date("2026-06-01T00:00:00.000Z") },
    );

    expect(result.inApp?.action).toBeNull();
    expect(result.email?.text).not.toContain("https://example.com/events");
    expect(result.email?.template?.variables).toMatchObject({
      destinationUrl: null,
    });
  });
});

// The email templates render the shift window in this zone; without it a UTC
// server mailed a 7pm Chicago shift as the next day (prod, 2026-10-13).
describe("volunteer renderers pass the shift's timezone to the email template", () => {
  const ids = {
    eventId: "40000000-0000-4000-8000-000000000004",
    roleId: "60000000-0000-4000-8000-000000000006",
    signupId: "80000000-0000-4000-8000-000000000008",
  };
  // 2026-10-12 19:00–22:00 CDT.
  const window = {
    shiftStartsAtIso: "2026-10-13T00:00:00.000Z",
    shiftEndsAtIso: "2026-10-13T03:00:00.000Z",
  };
  const ctx = { now: new Date("2026-06-01T00:00:00.000Z") };

  it("volunteer.signup-received", () => {
    const result = renderNotification(
      "volunteer.signup-received",
      {
        ...ids,
        eventTitle: "Night Market",
        roleName: "Security",
        status: "PENDING",
        ...window,
        timezone: "America/Chicago",
      },
      ctx,
    );
    expect(result.email?.template?.variables).toMatchObject({
      shiftStartsAtISO: window.shiftStartsAtIso,
      timezone: "America/Chicago",
    });
  });

  it("volunteer.signup-approved", () => {
    const result = renderNotification(
      "volunteer.signup-approved",
      {
        ...ids,
        eventTitle: "Night Market",
        roleName: "Security",
        ...window,
        timezone: "America/Chicago",
      },
      ctx,
    );
    expect(result.email?.template?.variables).toMatchObject({
      shiftStartsAtISO: window.shiftStartsAtIso,
      timezone: "America/Chicago",
    });
  });

  it("volunteer.shift-reminder", () => {
    const result = renderNotification(
      "volunteer.shift-reminder",
      {
        ...ids,
        eventTitle: "Night Market",
        roleName: "Security",
        kind: "REMINDER_24H",
        ...window,
        timezone: "America/Chicago",
      },
      ctx,
    );
    expect(result.email?.template?.variables).toMatchObject({
      shiftStartsAtISO: window.shiftStartsAtIso,
      timezone: "America/Chicago",
    });
  });

  it("an absent zone sends the platform default, never the server's zone", () => {
    const result = renderNotification(
      "volunteer.signup-approved",
      { ...ids, eventTitle: "Night Market", roleName: "Security", ...window },
      ctx,
    );
    expect(result.email?.template?.variables).toMatchObject({
      timezone: "America/Chicago",
    });
  });
});

describe("order.confirmed renderer", () => {
  const basePayload = {
    orderId: "11111111-0000-4000-8000-000000000001",
    eventId: "22222222-0000-4000-8000-000000000002",
    eventTitle: "Sunset Sessions",
    ticketCount: 2,
    amountCents: 5_000,
    currency: "usd",
  } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain("order.confirmed");
  });

  it("renders a transactional SUCCESS in-app payload with a my-tickets route", () => {
    const result = renderNotification("order.confirmed", basePayload, {
      now: new Date("2026-06-30T00:00:00.000Z"),
    });

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "You're going to Sunset Sessions!",
      body: "Your 2 tickets for Sunset Sessions ($50.00) are confirmed and ready in your account.",
      kind: "SUCCESS",
      action: { label: "View tickets", route: "/my-tickets" },
      expiresAt: null,
      tags: ["order", "confirmed"],
      metadata: {
        orderId: basePayload.orderId,
        eventId: basePayload.eventId,
        ticketCount: "2",
        currency: "usd",
      },
      template: null,
    });

    expect(result.fingerprint).toEqual({
      variant: "order.confirmed",
      orderId: basePayload.orderId,
      eventId: basePayload.eventId,
      ticketCount: basePayload.ticketCount,
      amountCents: basePayload.amountCents,
      currency: basePayload.currency,
    });
  });

  it("emits a push payload but never an email payload (no double-send)", () => {
    const result = renderNotification("order.confirmed", basePayload, {
      now: new Date("2026-06-30T00:00:00.000Z"),
    });

    expect(result.push).toBeDefined();
    expect(result.push?.collapseKey).toBe(`order-${basePayload.orderId}`);
    expect(result.email).toBeUndefined();
  });

  it("uses singular ticket copy and verb for a single-ticket order", () => {
    const result = renderNotification(
      "order.confirmed",
      { ...basePayload, ticketCount: 1, amountCents: 2_500 },
      { now: new Date("2026-06-30T00:00:00.000Z") },
    );

    expect(result.inApp?.body).toBe(
      "Your 1 ticket for Sunset Sessions ($25.00) is confirmed and ready in your account.",
    );
    expect(result.push?.body).toBe(
      "Your 1 ticket for Sunset Sessions is confirmed.",
    );
  });

  it("uses plural copy and verb for a multi-ticket order", () => {
    const result = renderNotification(
      "order.confirmed",
      { ...basePayload, ticketCount: 3, amountCents: 7_500 },
      { now: new Date("2026-06-30T00:00:00.000Z") },
    );

    expect(result.inApp?.body).toBe(
      "Your 3 tickets for Sunset Sessions ($75.00) are confirmed and ready in your account.",
    );
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "order.confirmed",
        { ...basePayload, ticketCount: 0 },
        { now: new Date("2026-06-30T00:00:00.000Z") },
      ),
    ).toThrow();

    expect(() =>
      renderNotification(
        "order.confirmed",
        { ...basePayload, unexpected: "field" },
        { now: new Date("2026-06-30T00:00:00.000Z") },
      ),
    ).toThrow();
  });
});

describe("order.refund-processed renderer", () => {
  const basePayload = {
    orderId: "11111111-0000-4000-8000-000000000001",
    refundId: "re_abc123",
    eventId: "22222222-0000-4000-8000-000000000002",
    eventTitle: "Sunset Sessions",
    amountCents: 5_000,
    currency: "usd",
    status: "REFUNDED",
  } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain(
      "order.refund-processed",
    );
  });

  it("renders a full-refund SUCCESS in-app payload, no email", () => {
    const result = renderNotification("order.refund-processed", basePayload, {
      now: new Date("2026-06-30T00:00:00.000Z"),
    });

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "Refund processed",
      body: "Your refund of $50.00 for Sunset Sessions is on its way back to your original payment method.",
      kind: "SUCCESS",
      action: { label: "View orders", route: "/my-tickets" },
      expiresAt: null,
      tags: ["order", "refund", "processed"],
      metadata: {
        orderId: basePayload.orderId,
        refundId: basePayload.refundId,
        currency: "usd",
        status: "REFUNDED",
        eventId: basePayload.eventId,
      },
      template: null,
    });
    expect(result.email).toBeUndefined();

    expect(result.fingerprint).toEqual({
      variant: "order.refund-processed",
      orderId: basePayload.orderId,
      refundId: basePayload.refundId,
      amountCents: basePayload.amountCents,
      currency: basePayload.currency,
      status: "REFUNDED",
    });
  });

  it("uses partial-refund copy and title for PART_REFUNDED", () => {
    const result = renderNotification(
      "order.refund-processed",
      { ...basePayload, status: "PART_REFUNDED" },
      { now: new Date("2026-06-30T00:00:00.000Z") },
    );

    expect(result.inApp?.title).toBe("Partial refund processed");
    expect(result.inApp?.body).toBe(
      "A partial refund of $50.00 for Sunset Sessions is on its way back to your original payment method.",
    );
  });

  it("omits the event fragment and eventId metadata when no event is provided", () => {
    const result = renderNotification(
      "order.refund-processed",
      {
        orderId: basePayload.orderId,
        refundId: basePayload.refundId,
        amountCents: basePayload.amountCents,
        currency: basePayload.currency,
        status: "REFUNDED",
      },
      { now: new Date("2026-06-30T00:00:00.000Z") },
    );

    expect(result.inApp?.body).toBe(
      "Your refund of $50.00 is on its way back to your original payment method.",
    );
    expect(result.inApp?.metadata).not.toHaveProperty("eventId");
  });

  // Owner ruling 2026-10-11: a ticket that cost $0 refunds $0. The refund
  // still runs and the buyer is still told, but nothing "is on its way back
  // to your payment method".
  it("a $0 refund renders the ticket-returned notice on in-app and push, never the money copy", () => {
    const result = renderNotification(
      "order.refund-processed",
      {
        ...basePayload,
        refundId: "nocharge_0123456789abcdef01234567",
        amountCents: 0,
        status: "PART_REFUNDED",
        ticketCount: 1,
      },
      { now: new Date("2026-06-30T00:00:00.000Z") },
    );

    const body =
      "Your ticket for Sunset Sessions was returned. There is no money to refund for it.";
    expect(result.inApp).toMatchObject({
      title: "Ticket returned",
      body,
      kind: "INFO",
      action: { label: "View orders", route: "/my-tickets" },
    });
    expect(result.push).toMatchObject({ title: "Ticket returned", body });
    expect(result.email).toBeUndefined();
    for (const text of [
      result.inApp?.title,
      result.inApp?.body,
      result.push?.title,
      result.push?.body,
    ]) {
      expect(text).not.toMatch(/on its way|refund processed/i);
    }
  });

  it("a $0 refund of several tickets uses the plural; a payload without ticketCount reads as one", () => {
    const zero = {
      ...basePayload,
      amountCents: 0,
      status: "REFUNDED",
    } as const;
    const many = renderNotification(
      "order.refund-processed",
      { ...zero, ticketCount: 3 },
      { now: new Date("2026-06-30T00:00:00.000Z") },
    );
    expect(many.inApp?.title).toBe("Tickets returned");
    expect(many.inApp?.body).toBe(
      "Your tickets for Sunset Sessions were returned. There is no money to refund for them.",
    );

    const bare = renderNotification(
      "order.refund-processed",
      { ...zero, eventTitle: null },
      { now: new Date("2026-06-30T00:00:00.000Z") },
    );
    expect(bare.inApp?.title).toBe("Ticket returned");
    expect(bare.inApp?.body).toBe(
      "Your ticket was returned. There is no money to refund for it.",
    );
  });

  it("a refund that moved money is unchanged by ticketCount", () => {
    const result = renderNotification(
      "order.refund-processed",
      { ...basePayload, ticketCount: 2 },
      { now: new Date("2026-06-30T00:00:00.000Z") },
    );
    expect(result.inApp?.title).toBe("Refund processed");
    expect(result.inApp?.kind).toBe("SUCCESS");
    expect(result.push?.body).toBe(
      "$50.00 for Sunset Sessions is on its way back to your payment method.",
    );
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "order.refund-processed",
        { ...basePayload, status: "BOGUS" },
        { now: new Date("2026-06-30T00:00:00.000Z") },
      ),
    ).toThrow();
  });
});

describe("resale.purchase-confirmed renderer", () => {
  const basePayload = {
    orderId: "11111111-0000-4000-8000-000000000001",
    eventId: "22222222-0000-4000-8000-000000000002",
    eventTitle: "Sunset Sessions",
    amountCents: 7_500,
    currency: "usd",
  } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain(
      "resale.purchase-confirmed",
    );
  });

  it("renders a transactional SUCCESS in-app payload with a my-tickets route, no email", () => {
    const result = renderNotification(
      "resale.purchase-confirmed",
      basePayload,
      { now: new Date("2026-06-30T00:00:00.000Z") },
    );

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "You're going to Sunset Sessions!",
      body: "Your resale ticket for Sunset Sessions ($75.00) is confirmed. We've issued a fresh QR code — find it in your account.",
      kind: "SUCCESS",
      action: { label: "View ticket", route: "/my-tickets" },
      expiresAt: null,
      tags: ["resale", "purchase", "confirmed"],
      metadata: {
        orderId: basePayload.orderId,
        eventId: basePayload.eventId,
        currency: "usd",
      },
      template: null,
    });
    expect(result.email).toBeUndefined();
    expect(result.push).toBeDefined();

    expect(result.fingerprint).toEqual({
      variant: "resale.purchase-confirmed",
      orderId: basePayload.orderId,
      eventId: basePayload.eventId,
      amountCents: basePayload.amountCents,
      currency: basePayload.currency,
    });
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "resale.purchase-confirmed",
        { ...basePayload, orderId: "not-a-uuid" },
        { now: new Date("2026-06-30T00:00:00.000Z") },
      ),
    ).toThrow();
  });
});

describe("volunteer.group-coordinator-assigned renderer", () => {
  const basePayload = {
    askId: "90000000-0000-4000-8000-000000000009",
    askTitle: "Street team",
    groupId: "a0000000-0000-4000-8000-00000000000a",
    groupName: "Flyer crew",
    coordinateUrl:
      "https://example.com/volunteers/coordinate/90000000-0000-4000-8000-000000000009",
  } as const;

  it("renders the assignment with an Open your group action", () => {
    const result = renderNotification(
      "volunteer.group-coordinator-assigned",
      basePayload,
      { now: new Date("2026-07-01T00:00:00.000Z") },
    );

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "You're now coordinating Flyer crew for Street team",
      body: "As coordinator of Flyer crew, you can review, approve and check in the volunteers in your group.",
      kind: "INFO",
      action: { label: "Open your group", href: basePayload.coordinateUrl },
      expiresAt: null,
      tags: ["volunteer", "group", "coordinator-assigned"],
      metadata: {
        askId: basePayload.askId,
        groupId: basePayload.groupId,
      },
      template: null,
    });
    expect(result.email).toEqual({
      subject: "You're now coordinating Flyer crew for Street team",
      text: expect.stringContaining(basePayload.coordinateUrl),
      template: {
        key: "volunteer.group_coordinator_assigned",
        variables: {
          assignerName: null,
          groupName: "Flyer crew",
          askTitle: "Street team",
          coordinateUrl: basePayload.coordinateUrl,
          accountCompletionUrl: null,
        },
      },
      tags: ["volunteer", "group", "coordinator-assigned"],
      metadata: {
        askId: basePayload.askId,
        groupId: basePayload.groupId,
      },
    });
    expect(result.fingerprint).toEqual({
      variant: "volunteer.group-coordinator-assigned",
      groupId: basePayload.groupId,
      askId: basePayload.askId,
      accountCompletionUrl: null,
    });
  });

  it("names the assigner in the title and email, but keeps them out of the fingerprint", () => {
    const withAssigner = renderNotification(
      "volunteer.group-coordinator-assigned",
      { ...basePayload, assignerName: "Sam Rivera" },
      { now: new Date("2026-07-01T00:00:00.000Z") },
    );
    const without = renderNotification(
      "volunteer.group-coordinator-assigned",
      basePayload,
      { now: new Date("2026-07-01T00:00:00.000Z") },
    );

    expect(withAssigner.inApp?.title).toBe(
      "Sam Rivera made you coordinator of Flyer crew for Street team",
    );
    expect(withAssigner.email?.subject).toBe(
      "Sam Rivera made you coordinator of Flyer crew for Street team",
    );
    expect(withAssigner.email?.text).toContain("Sam Rivera");
    expect(withAssigner.email?.template?.variables).toMatchObject({
      assignerName: "Sam Rivera",
    });
    // A different owner re-sending inside notify's idempotency window must
    // replay, not throw IDEMPOTENCY_KEY_CONFLICT.
    expect(withAssigner.fingerprint).toEqual(without.fingerprint);
  });

  it("renders the invite flavor when accountCompletionUrl is present", () => {
    const accountCompletionUrl =
      "https://example.com/auth/complete?email=new%40example.com&src=volunteer-coordinator";
    const result = renderNotification(
      "volunteer.group-coordinator-assigned",
      { ...basePayload, accountCompletionUrl },
      { now: new Date("2026-07-01T00:00:00.000Z") },
    );

    expect(result.email?.text).toContain(accountCompletionUrl);
    expect(result.inApp?.metadata).toMatchObject({ accountCompletionUrl });
    expect(result.fingerprint).toMatchObject({ accountCompletionUrl });
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "volunteer.group-coordinator-assigned",
        { ...basePayload, groupId: "not-a-uuid" },
        { now: new Date("2026-07-01T00:00:00.000Z") },
      ),
    ).toThrow();
  });
});

describe("volunteer.broadcast renderer", () => {
  const basePayload = {
    askId: "90000000-0000-4000-8000-000000000009",
    broadcastId: "b0000000-0000-4000-8000-00000000000b",
    askTitle: "Street team",
    subject: "Schedule change",
    body: "Doors now open at 7pm.",
  } as const;

  it("renders an in-app-only announcement (email goes out via MailerPort, never doubled here)", () => {
    const result = renderNotification("volunteer.broadcast", basePayload, {
      now: new Date("2026-07-02T00:00:00.000Z"),
    });

    // organizerMessages, not transactional — a roster broadcast is
    // organizer-authored messaging, and broadcast-to-roster's direct
    // email leg gates on the same category (FR-009).
    expect(result.category).toBe("organizerMessages");
    expect(result.inApp).toEqual({
      title: "Street team: Schedule change",
      body: "Doors now open at 7pm.",
      kind: "INFO",
      action: null,
      expiresAt: null,
      tags: ["volunteer", "broadcast"],
      metadata: {
        askId: basePayload.askId,
        broadcastId: basePayload.broadcastId,
      },
      template: null,
    });
    // No email/push/sms channel payloads — in-app only by design.
    expect(result.email).toBeUndefined();
    expect(result.push).toBeUndefined();
    expect(result.sms).toBeUndefined();
    expect(result.fingerprint).toEqual({
      variant: "volunteer.broadcast",
      broadcastId: basePayload.broadcastId,
      askId: basePayload.askId,
    });
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "volunteer.broadcast",
        { ...basePayload, broadcastId: "not-a-uuid" },
        { now: new Date("2026-07-02T00:00:00.000Z") },
      ),
    ).toThrow();
  });
});

describe("event.cancelled renderer", () => {
  const eventId = "40000000-0000-4000-8000-000000000004";
  const eventUrl = "https://ithasfire.com/events/org/us/sunset-sessions--a1b2";
  const eventRoute = "/events/org/us/sunset-sessions--a1b2";
  const ctx = { now: new Date("2026-07-04T00:00:00.000Z") } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain("event.cancelled");
  });

  it("renders a refund-aware WARNING in-app + email payload for refunded buyers", () => {
    const payload = {
      eventId,
      eventTitle: "Sunset Sessions",
      startsAt: "2026-08-15T20:00:00.000Z",
      eventUrl,
      refund: { status: "refunded", amountCents: 5_000, currency: "usd" },
    } as const;

    const result = renderNotification("event.cancelled", payload, ctx);

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "Event cancelled — refund on the way",
      body: "Sunset Sessions has been cancelled. You've been refunded $50.00.",
      kind: "WARNING",
      // Slug route derived from eventUrl — `/events/<uuid>` 404s.
      action: { label: "View event", route: eventRoute },
      expiresAt: null,
      tags: ["event", "cancelled"],
      metadata: { eventId },
      template: null,
    });

    expect(result.email).toEqual({
      subject: "Sunset Sessions was cancelled — you've been refunded",
      text: "Sunset Sessions has been cancelled. You've been refunded $50.00.",
      tags: ["event", "cancelled"],
      metadata: { eventId },
    });

    expect(result.fingerprint).toEqual({
      variant: "event.cancelled",
      eventId,
      refund: "refunded",
    });
  });

  it("renders a refund-in-progress WARNING for buyers whose refund failed", () => {
    const payload = {
      eventId,
      eventTitle: "Sunset Sessions",
      startsAt: "2026-08-15T20:00:00.000Z",
      eventUrl,
      refund: { status: "pending" },
    } as const;

    const result = renderNotification("event.cancelled", payload, ctx);

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "Event cancelled — refund in progress",
      body: "Sunset Sessions has been cancelled. Your refund is being processed and we'll follow up.",
      kind: "WARNING",
      // Slug route derived from eventUrl — `/events/<uuid>` 404s.
      action: { label: "View event", route: eventRoute },
      expiresAt: null,
      tags: ["event", "cancelled"],
      metadata: { eventId },
      template: null,
    });

    expect(result.email).toEqual({
      subject: "Sunset Sessions was cancelled — refund in progress",
      text: "Sunset Sessions has been cancelled. Your refund is being processed and we'll follow up.",
      tags: ["event", "cancelled"],
      metadata: { eventId },
    });

    expect(result.fingerprint).toEqual({
      variant: "event.cancelled",
      eventId,
      refund: "pending",
    });
  });

  it("renders a plain cancellation for RSVPers with no refund", () => {
    const payload = {
      eventId,
      eventTitle: "Open Mic Night",
      startsAt: null,
      eventUrl,
      refund: null,
    } as const;

    const result = renderNotification("event.cancelled", payload, ctx);

    expect(result.inApp?.action).toEqual({
      label: "View event",
      route: eventRoute,
    });
    expect(result.inApp?.title).toBe("Event cancelled");
    expect(result.inApp?.body).toBe("Open Mic Night has been cancelled.");
    expect(result.email?.subject).toBe("Open Mic Night was cancelled");
    expect(result.email?.text).toBe("Open Mic Night has been cancelled.");
    expect(result.fingerprint).toEqual({
      variant: "event.cancelled",
      eventId,
      refund: "none",
    });
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "event.cancelled",
        {
          eventId: "not-a-uuid",
          eventTitle: "Bad",
          startsAt: null,
          refund: null,
        },
        ctx,
      ),
    ).toThrow();

    expect(() =>
      renderNotification(
        "event.cancelled",
        {
          eventId,
          eventTitle: "Bad",
          startsAt: null,
          refund: null,
          unexpected: "field",
        },
        ctx,
      ),
    ).toThrow();
  });
});

describe("event.changed renderer", () => {
  const eventId = "40000000-0000-4000-8000-000000000004";
  const eventUrl = "https://ithasfire.com/events/org/us/sunset-sessions--a1b2";
  const eventRoute = "/events/org/us/sunset-sessions--a1b2";
  const ctx = { now: new Date("2026-07-04T00:00:00.000Z") } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain("event.changed");
  });

  it("renders an INFO in-app + email payload for reschedules with the new date", () => {
    const payload = {
      eventId,
      eventTitle: "Sunset Sessions",
      changeType: "RESCHEDULED",
      newStartsAt: "2026-08-15T20:00:00.000Z",
      newEndsAt: "2026-08-15T23:00:00.000Z",
      eventUrl,
    } as const;

    const result = renderNotification("event.changed", payload, ctx);

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "Event rescheduled",
      body: "Sunset Sessions has a new date. It now starts Sat, Aug 15, 2026, 3:00 PM CDT.",
      kind: "INFO",
      // Slug route derived from eventUrl — `/events/<uuid>` 404s.
      action: { label: "View event", route: eventRoute },
      expiresAt: null,
      tags: ["event", "changed"],
      metadata: { eventId, changeType: "RESCHEDULED" },
      template: null,
    });

    expect(result.email).toEqual({
      subject: "Sunset Sessions was rescheduled",
      text: "Sunset Sessions has a new date. It now starts Sat, Aug 15, 2026, 3:00 PM CDT.",
      tags: ["event", "changed"],
      metadata: { eventId, changeType: "RESCHEDULED" },
    });

    expect(result.fingerprint).toEqual({
      variant: "event.changed",
      eventId,
      changeType: "RESCHEDULED",
      newStartsAt: "2026-08-15T20:00:00.000Z",
    });
  });

  it("omits the formatted date when a reschedule has no new start", () => {
    const result = renderNotification(
      "event.changed",
      {
        eventId,
        eventTitle: "Sunset Sessions",
        changeType: "RESCHEDULED",
        newStartsAt: null,
        newEndsAt: null,
      },
      ctx,
    );

    expect(result.inApp?.body).toBe("Sunset Sessions has a new date.");
    expect(result.fingerprint).toMatchObject({ newStartsAt: null });
  });

  it("renders venue-change copy for VENUE_CHANGED", () => {
    const result = renderNotification(
      "event.changed",
      {
        eventId,
        eventTitle: "Sunset Sessions",
        changeType: "VENUE_CHANGED",
        newStartsAt: null,
        newEndsAt: null,
      },
      ctx,
    );

    expect(result.inApp?.title).toBe("Event moved to a new location");
    expect(result.inApp?.body).toBe(
      "Sunset Sessions has moved to a new location.",
    );
    expect(result.email?.subject).toBe("Sunset Sessions moved to a new location");
    expect(result.inApp?.metadata).toEqual({
      eventId,
      changeType: "VENUE_CHANGED",
    });
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "event.changed",
        {
          eventId,
          eventTitle: "Bad",
          changeType: "MOVED",
          newStartsAt: null,
          newEndsAt: null,
        },
        ctx,
      ),
    ).toThrow();

    expect(() =>
      renderNotification(
        "event.changed",
        {
          eventId,
          eventTitle: "Bad",
          changeType: "RESCHEDULED",
          newStartsAt: null,
          newEndsAt: null,
          unexpected: "field",
        },
        ctx,
      ),
    ).toThrow();
  });
});

describe("event.unlisted renderer", () => {
  const eventId = "40000000-0000-4000-8000-000000000004";
  const ctx = { now: new Date("2026-07-04T00:00:00.000Z") } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain("event.unlisted");
  });

  it("renders a WARNING in-app + email payload with NO action link", () => {
    const payload = {
      eventId,
      eventTitle: "Sunset Sessions",
    } as const;

    const result = renderNotification("event.unlisted", payload, ctx);

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "Event no longer available",
      body: "Sunset Sessions is no longer listed.",
      kind: "WARNING",
      // Deliberately null — the event is no longer public, a link would 404.
      action: null,
      expiresAt: null,
      tags: ["event", "unlisted"],
      metadata: { eventId },
      template: null,
    });

    expect(result.email).toEqual({
      subject: "Sunset Sessions is no longer available",
      text: "Sunset Sessions is no longer listed.",
      tags: ["event", "unlisted"],
      metadata: { eventId },
    });

    expect(result.fingerprint).toEqual({
      variant: "event.unlisted",
      eventId,
    });
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "event.unlisted",
        {
          eventId: "not-a-uuid",
          eventTitle: "Bad",
        },
        ctx,
      ),
    ).toThrow();

    expect(() =>
      renderNotification(
        "event.unlisted",
        {
          eventId,
          eventTitle: "Bad",
          unexpected: "field",
        },
        ctx,
      ),
    ).toThrow();
  });
});

describe("rsvp.confirmed renderer", () => {
  const EVENT_SLUG = "corner-stage/us/austin/weekly-open-mic--a1b2c3";
  const eventId = "55555555-5555-4555-8555-555555555555";
  const ctx = { now: new Date("2026-07-06T00:00:00.000Z") } as const;

  const fullPayload = {
    eventId,
    eventTitle: "Weekly Open Mic",
    startsAtIso: "2026-08-01T20:00:00.000Z",
    endsAtIso: "2026-08-01T23:00:00.000Z",
    timezone: "America/Chicago",
    venueName: "The Corner Stage",
    addressText: "123 Main St, Austin, TX",
    heroImageUrl: "https://img.example.com/hero.jpg",
    // SLUG url, matching what dispatch-rsvp-notifications now builds. It used
    // to be `/events/${eventId}` here AND in the dispatcher — a link that 404s.
    eventUrl: `https://ithasfire.com/events/${EVENT_SLUG}`,
    manageRsvpsUrl: "https://ithasfire.com/my-rsvps",
  } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain("rsvp.confirmed");
  });

  it("routes the action to the event SLUG, never the id", () => {
    const result = renderNotification("rsvp.confirmed", fullPayload, ctx);

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "You're going to Weekly Open Mic",
      // Start formatted in the EVENT's timezone (America/Chicago = CDT).
      body: "Your RSVP for Weekly Open Mic is confirmed. It starts Sat, Aug 1, 2026, 3:00 PM CDT.",
      kind: "SUCCESS",
      // The event page hosts the RSVP toggle — this is also how you cancel.
      action: { label: "View event", route: `/events/${EVENT_SLUG}` },
      expiresAt: null,
      tags: ["rsvp", "confirmed"],
      metadata: { eventId },
      template: null,
    });
  });

  it("renders the templated email with cancel/manage links", () => {
    const result = renderNotification("rsvp.confirmed", fullPayload, ctx);

    expect(result.email?.subject).toBe("You're going to Weekly Open Mic");
    expect(result.email?.template).toEqual({
      key: "rsvp.confirmed",
      variables: {
        eventTitle: "Weekly Open Mic",
        startsAtISO: "2026-08-01T20:00:00.000Z",
        endsAtISO: "2026-08-01T23:00:00.000Z",
        timezone: "America/Chicago",
        venueName: "The Corner Stage",
        addressText: "123 Main St, Austin, TX",
        heroImageUrl: "https://img.example.com/hero.jpg",
        eventUrl: `https://ithasfire.com/events/${EVENT_SLUG}`,
        manageRsvpsUrl: "https://ithasfire.com/my-rsvps",
      },
    });
    // Plain-text fallback carries both links (event page = cancel surface).
    expect(result.email?.text).toContain(
      `View the event: https://ithasfire.com/events/${EVENT_SLUG}`,
    );
    expect(result.email?.text).toContain(
      "Changed your plans? Manage your RSVPs: https://ithasfire.com/my-rsvps",
    );

    expect(result.fingerprint).toEqual({
      variant: "rsvp.confirmed",
      eventId,
      startsAtIso: "2026-08-01T20:00:00.000Z",
    });
  });

  it("tolerates minimal payloads (no venue/address/hero, null timezone → platform default)", () => {
    const result = renderNotification(
      "rsvp.confirmed",
      {
        eventId,
        eventTitle: "Weekly Open Mic",
        startsAtIso: "2026-08-01T20:00:00.000Z",
        timezone: null,
        eventUrl: `https://ithasfire.com/events/${eventId}`,
        manageRsvpsUrl: "https://ithasfire.com/my-rsvps",
      },
      ctx,
    );

    expect(result.inApp?.body).toBe(
      "Your RSVP for Weekly Open Mic is confirmed. It starts Sat, Aug 1, 2026, 3:00 PM CDT.",
    );
    expect(result.email?.text).not.toContain("Where:");
    expect(result.email?.text).not.toContain("Address:");
    expect(result.email?.template).toMatchObject({
      key: "rsvp.confirmed",
      variables: expect.objectContaining({
        venueName: null,
        addressText: null,
        heroImageUrl: null,
        // The same zone as the in-app text, so the HTML WHEN line agrees.
        timezone: "America/Chicago",
        endsAtISO: null,
      }),
    });
  });

  it("falls back to the platform default when the timezone is not a valid IANA id", () => {
    const result = renderNotification(
      "rsvp.confirmed",
      {
        ...fullPayload,
        timezone: "Not/AZone",
      },
      ctx,
    );

    expect(result.inApp?.body).toContain("3:00 PM CDT");
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "rsvp.confirmed",
        { ...fullPayload, unexpected: "field" },
        ctx,
      ),
    ).toThrow();

    expect(() =>
      renderNotification(
        "rsvp.confirmed",
        { ...fullPayload, eventUrl: "not-a-url" },
        ctx,
      ),
    ).toThrow();
  });
});

describe("image.moderation.held renderer", () => {
  const recordId = "66666666-6666-4666-8666-666666666666";
  const subjectId = "77777777-7777-4777-8777-777777777777";
  const ctx = { now: new Date("2026-07-08T00:00:00.000Z") } as const;

  const basePayload = {
    recordId,
    kind: "EVENT_HERO",
    subjectType: "EVENT",
    subjectId,
    subjectTitle: null,
    subjectUrl: null,
    imageUrl: "https://cdn.ithasfire.com/moderation/held.jpg",
    helpUrl: "https://ithasfire.com/help",
  } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain(
      "image.moderation.held",
    );
  });

  it("falls back to the generic copy with no action when the subject is unknown", () => {
    const result = renderNotification("image.moderation.held", basePayload, ctx);

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "Your image is being reviewed",
      body: "The image you uploaded is being reviewed and will appear once it's approved. No action is needed.",
      kind: "INFO",
      // Nothing to link to — the event couldn't be resolved.
      action: null,
      expiresAt: null,
      tags: ["image", "moderation", "held"],
      metadata: {
        recordId,
        kind: "EVENT_HERO",
        subjectType: "EVENT",
        subjectId,
      },
      template: null,
    });

    expect(result.email).toEqual({
      subject: "Your image is being reviewed",
      text: expect.stringContaining("https://ithasfire.com/help"),
      template: {
        key: "image.moderation.held",
        variables: {
          helpUrl: "https://ithasfire.com/help",
          eventTitle: null,
          eventUrl: null,
        },
      },
      tags: ["image", "moderation", "held"],
      metadata: {
        recordId,
        kind: "EVENT_HERO",
        subjectType: "EVENT",
        subjectId,
      },
    });

    expect(result.fingerprint).toEqual({
      variant: "image.moderation.held",
      recordId,
    });
  });

  it("names the event and links it by SLUG when the subject resolves", () => {
    const result = renderNotification(
      "image.moderation.held",
      {
        ...basePayload,
        subjectTitle: "Night Market Sessions",
        subjectUrl: "https://ithasfire.com/events/night-market-sessions",
      },
      ctx,
    );

    expect(result.inApp?.body).toBe(
      'The image you uploaded for "Night Market Sessions" is being reviewed and will appear once it\'s approved. No action is needed.',
    );
    // Informational link, neutral label — no call to action.
    expect(result.inApp?.action).toEqual({
      label: "View event",
      route: "/events/night-market-sessions",
    });
    expect(result.email?.text).toContain(
      "View the event: https://ithasfire.com/events/night-market-sessions",
    );
    expect(result.email?.template).toEqual({
      key: "image.moderation.held",
      variables: {
        helpUrl: "https://ithasfire.com/help",
        eventTitle: "Night Market Sessions",
        eventUrl: "https://ithasfire.com/events/night-market-sessions",
      },
    });
  });

  it("omits subject metadata and the help line when they are null", () => {
    const result = renderNotification(
      "image.moderation.held",
      {
        ...basePayload,
        subjectType: null,
        subjectId: null,
        imageUrl: null,
        helpUrl: null,
      },
      ctx,
    );

    expect(result.inApp?.metadata).toEqual({
      recordId,
      kind: "EVENT_HERO",
    });
    expect(result.email?.text).not.toContain("Help Center");
    expect(result.email?.template).toEqual({
      key: "image.moderation.held",
      variables: { helpUrl: null, eventTitle: null, eventUrl: null },
    });
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "image.moderation.held",
        { ...basePayload, recordId: "not-a-uuid" },
        ctx,
      ),
    ).toThrow();

    expect(() =>
      renderNotification(
        "image.moderation.held",
        { ...basePayload, unexpected: "field" },
        ctx,
      ),
    ).toThrow();
  });
});

describe("image.moderation.approved renderer", () => {
  const recordId = "66666666-6666-4666-8666-666666666666";
  const subjectId = "77777777-7777-4777-8777-777777777777";
  const ctx = { now: new Date("2026-07-08T00:00:00.000Z") } as const;

  const basePayload = {
    recordId,
    kind: "EVENT_HERO",
    subjectType: "EVENT",
    subjectId,
    subjectTitle: "Night Market Sessions",
    subjectUrl: "https://ithasfire.com/events/night-market-sessions",
    imageUrl: "https://cdn.ithasfire.com/moderation/live.jpg",
    note: null,
    helpUrl: null,
  } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain(
      "image.moderation.approved",
    );
  });

  it("names the event and routes the action by SLUG (never the id)", () => {
    const result = renderNotification(
      "image.moderation.approved",
      basePayload,
      ctx,
    );

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "Your image is now live",
      body: 'The image you uploaded for "Night Market Sessions" has been approved and is now visible.',
      kind: "SUCCESS",
      // The route MUST be the slug path — `/events/<uuid>` 404s on the public
      // route (events.resolveBySlug matches slug / slug-history only).
      action: { label: "View event", route: "/events/night-market-sessions" },
      expiresAt: null,
      tags: ["image", "moderation", "approved"],
      metadata: {
        recordId,
        kind: "EVENT_HERO",
        subjectType: "EVENT",
        subjectId,
      },
      template: null,
    });
    expect(result.inApp?.action?.route).not.toContain(subjectId);

    expect(result.email).toEqual({
      subject: "Your image is now live",
      text:
        'The image you uploaded for "Night Market Sessions" has been approved and is now visible.' +
        "\n\nView the event: https://ithasfire.com/events/night-market-sessions",
      template: {
        key: "image.moderation.approved",
        variables: {
          eventTitle: "Night Market Sessions",
          eventUrl: "https://ithasfire.com/events/night-market-sessions",
          helpUrl: null,
        },
      },
      tags: ["image", "moderation", "approved"],
      metadata: {
        recordId,
        kind: "EVENT_HERO",
        subjectType: "EVENT",
        subjectId,
      },
    });

    expect(result.fingerprint).toEqual({
      variant: "image.moderation.approved",
      recordId,
    });
  });

  it("falls back to the generic copy with no action when the subject is unknown", () => {
    const result = renderNotification(
      "image.moderation.approved",
      { ...basePayload, subjectTitle: null, subjectUrl: null },
      ctx,
    );

    expect(result.inApp?.body).toBe(
      "The image you uploaded has been approved and is now visible.",
    );
    expect(result.inApp?.action).toBeNull();
    expect(result.email?.text).toBe(
      "The image you uploaded has been approved and is now visible.",
    );
    expect(result.email?.template).toEqual({
      key: "image.moderation.approved",
      variables: { eventTitle: null, eventUrl: null, helpUrl: null },
    });
  });

  it("omits the action for non-EVENT subjects", () => {
    const result = renderNotification(
      "image.moderation.approved",
      { ...basePayload, kind: "AVATAR", subjectType: "HUMAN" },
      ctx,
    );

    expect(result.inApp?.action).toBeNull();
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "image.moderation.approved",
        { ...basePayload, kind: "BOGUS" },
        ctx,
      ),
    ).toThrow();
  });
});

describe("image.moderation.rejected renderer", () => {
  const recordId = "66666666-6666-4666-8666-666666666666";
  const subjectId = "77777777-7777-4777-8777-777777777777";
  const ctx = { now: new Date("2026-07-08T00:00:00.000Z") } as const;

  const basePayload = {
    recordId,
    kind: "EVENT_HERO",
    subjectType: "EVENT",
    subjectId,
    subjectTitle: "Night Market Sessions",
    subjectUrl: "https://ithasfire.com/events/night-market-sessions",
    imageUrl: "https://cdn.ithasfire.com/moderation/rejected.jpg",
    note: "This image didn't meet our content guidelines.",
    helpUrl: null,
  } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain(
      "image.moderation.rejected",
    );
  });

  it("renders a non-judgmental INFO notice that surfaces the reviewer note", () => {
    const result = renderNotification(
      "image.moderation.rejected",
      basePayload,
      ctx,
    );

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "Your image wasn't approved",
      body: "The image you uploaded for \"Night Market Sessions\" wasn't approved and won't be shown. You can upload a different one anytime.",
      kind: "INFO",
      // Links the EVENT (by slug), so the uploader knows which image to replace.
      action: { label: "View event", route: "/events/night-market-sessions" },
      expiresAt: null,
      tags: ["image", "moderation", "rejected"],
      metadata: {
        recordId,
        kind: "EVENT_HERO",
        subjectType: "EVENT",
        subjectId,
      },
      template: null,
    });
    expect(result.inApp?.action?.route).not.toContain(subjectId);

    expect(result.email?.text).toContain(
      "Note from our moderators: This image didn't meet our content guidelines.",
    );
    expect(result.email?.text).toContain(
      "View the event: https://ithasfire.com/events/night-market-sessions",
    );
    expect(result.email?.template).toEqual({
      key: "image.moderation.rejected",
      variables: {
        note: "This image didn't meet our content guidelines.",
        eventTitle: "Night Market Sessions",
        eventUrl: "https://ithasfire.com/events/night-market-sessions",
        helpUrl: null,
      },
    });

    expect(result.fingerprint).toEqual({
      variant: "image.moderation.rejected",
      recordId,
      note: "This image didn't meet our content guidelines.",
    });
  });

  it("omits the note line and nulls the fingerprint note when absent", () => {
    const result = renderNotification(
      "image.moderation.rejected",
      { ...basePayload, note: null },
      ctx,
    );

    expect(result.email?.text).not.toContain("Note from our moderators");
    expect(result.email?.template).toEqual({
      key: "image.moderation.rejected",
      variables: {
        note: null,
        eventTitle: "Night Market Sessions",
        eventUrl: "https://ithasfire.com/events/night-market-sessions",
        helpUrl: null,
      },
    });
    expect(result.fingerprint).toMatchObject({ note: null });
  });

  it("falls back to the generic copy with no action when the subject is unknown", () => {
    const result = renderNotification(
      "image.moderation.rejected",
      { ...basePayload, subjectTitle: null, subjectUrl: null },
      ctx,
    );

    expect(result.inApp?.body).toBe(
      "The image you uploaded wasn't approved and won't be shown. You can upload a different one anytime.",
    );
    expect(result.inApp?.action).toBeNull();
    expect(result.email?.text).not.toContain("View the event");
    expect(result.email?.template).toEqual({
      key: "image.moderation.rejected",
      variables: {
        note: "This image didn't meet our content guidelines.",
        eventTitle: null,
        eventUrl: null,
        helpUrl: null,
      },
    });
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "image.moderation.rejected",
        { ...basePayload, unexpected: "field" },
        ctx,
      ),
    ).toThrow();
  });
});

/**
 * REGRESSION GUARD for the whole id-route bug class.
 *
 * SEVEN renderers built their action as `/events/{eventId}` — the three image
 * moderation notices plus `event.cancelled`, `event.changed`,
 * `event.location-revealed` and `rsvp.confirmed`. The public
 * `/events/[...slug]` route resolves through `events.resolveBySlug`, which
 * matches the current slug or slug history ONLY, so every one of those links
 * 404'd. (They were invisible for a while because the inbox dropped route-only
 * actions entirely; the moment that was fixed they'd have become visible 404
 * buttons.)
 *
 * Every event action now derives its route from an absolute, slug-based URL via
 * `eventRouteAction`, which makes an id route unrepresentable. These tests hold
 * that line for each variant AND scan the source so a hand-rolled
 * `/events/${...Id}` can't creep back in.
 */
describe("no renderer routes by event id", () => {
  const UUID =
    /\/events\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const eventId = "40000000-0000-4000-8000-000000000004";
  const SLUG = "org-slug/us/general/my-event--ab12cd";
  const EVENT_URL = `https://ithasfire.com/events/${SLUG}`;
  const ROUTE = `/events/${SLUG}`;
  const ctx = { now: new Date("2026-07-04T00:00:00.000Z") } as const;

  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "event.cancelled",
      {
        eventId,
        eventTitle: "Sunset Sessions",
        startsAt: null,
        refund: null,
        eventUrl: EVENT_URL,
      },
    ],
    [
      "event.changed",
      {
        eventId,
        eventTitle: "Sunset Sessions",
        changeType: "RESCHEDULED",
        newStartsAt: null,
        newEndsAt: null,
        eventUrl: EVENT_URL,
      },
    ],
    [
      "event.location-revealed",
      {
        eventId,
        eventTitle: "Sunset Sessions",
        address: "123 Main St",
        startsAtIso: "2026-08-15T20:00:00.000Z",
        eventUrl: EVENT_URL,
      },
    ],
    [
      "rsvp.confirmed",
      {
        eventId,
        eventTitle: "Sunset Sessions",
        startsAtIso: "2026-08-15T20:00:00.000Z",
        eventUrl: EVENT_URL,
        manageRsvpsUrl: "https://ithasfire.com/my-rsvps",
      },
    ],
  ];

  for (const [variant, payload] of cases) {
    it(`${variant} routes by slug, never by id`, () => {
      const result = renderNotification(variant, payload, ctx);
      expect(result.inApp?.action?.route).toBe(ROUTE);
      expect(result.inApp?.action?.route).not.toMatch(UUID);
      expect(result.inApp?.action?.route).not.toContain(eventId);
    });
  }

  for (const variant of ["event.cancelled", "event.changed"] as const) {
    it(`${variant} emits NO action when it has no event URL`, () => {
      const payload = {
        ...(cases.find(([v]) => v === variant)?.[1] as Record<string, unknown>),
        eventUrl: null,
      };
      const result = renderNotification(variant, payload, ctx);
      // No labelled button to nowhere.
      expect(result.inApp?.action).toBeNull();
    });

    it(`${variant} still renders when eventUrl is absent entirely`, () => {
      const payload = {
        ...(cases.find(([v]) => v === variant)?.[1] as Record<string, unknown>),
      };
      delete payload.eventUrl;
      // Optional on purpose: an emitter that predates the field must not have
      // its (money-adjacent) notice rejected by the strict schema.
      expect(() => renderNotification(variant, payload, ctx)).not.toThrow();
      expect(renderNotification(variant, payload, ctx).inApp?.action).toBeNull();
    });
  }

  /**
   * TRIPWIRE, not a proof.
   *
   * This is a source scan, so it is heuristic by construction: it cannot know
   * whether an interpolated variable holds a slug or an id, and a determined
   * author can always route around it. Its job is to make the ACCIDENTAL
   * reintroduction of this bug loud — five separate emitters grew the same
   * `/events/${someId}` line independently, which is exactly the pattern a
   * cheap tripwire catches and code review kept missing.
   *
   * If this fires on a legitimate slug-based line, route that line through
   * `eventPublicUrl` / `eventPublicPath` instead of widening the allowlist.
   */
  it("TRIPWIRE: nothing hand-builds an /events/ link from a variable", () => {
    const roots = [
      new URL("../../", import.meta.url), // packages/core/src/use-cases
      new URL("../../../../../../apps/jobs/src/jobs/", import.meta.url),
    ];

    // `/events/` immediately followed by an interpolation or a concatenation,
    // i.e. a link built from a variable rather than from the shared builders.
    const INTERPOLATED = /["'`]\/events\/["'`]?\s*(?:\$\{|\+)/;

    /**
     * Lines that legitimately interpolate into an `/events/` path. Each needs a
     * REASON, and "it's fine" is not one — the whole point of the tripwire is
     * that this bug looked fine five times.
     */
    const VETTED: Array<{ file: string; reason: string }> = [
      {
        file: "events/notify-venue-confirmation-intents.ts",
        // Verified: `apps/web/src/app/admin/[slug]/events/[id]` — the ADMIN
        // event route is keyed by id by design. This builds
        // `/admin/{slug}/events/{id}`, not the public page.
        reason: "admin route (/admin/{slug}/events/[id]) is id-keyed",
      },
    ];

    const offenders: string[] = [];

    for (const root of roots) {
      for (const file of walk(fileURLToPath(root))) {
        if (!/\.tsx?$/.test(file) || /__tests__|\.test\.tsx?$/.test(file)) {
          continue;
        }
        const source = readFileSync(file, "utf8");
        for (const [i, line] of source.split("\n").entries()) {
          // Comments explain the bug; they are not the bug.
          const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, "");
          if (!INTERPOLATED.test(code)) continue;
          if (VETTED.some((v) => file.endsWith(v.file))) continue;
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe("image moderation notices never route by event id", () => {
  const ctx = { now: new Date("2026-07-08T00:00:00.000Z") } as const;
  const recordId = "66666666-6666-4666-8666-666666666666";
  const subjectId = "77777777-7777-4777-8777-777777777777";
  const UUID_ROUTE = /^\/events\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const variants = [
    ["image.moderation.held", { helpUrl: null }],
    ["image.moderation.approved", { note: null, helpUrl: null }],
    ["image.moderation.rejected", { note: null, helpUrl: null }],
  ] as const;

  for (const [variant, extra] of variants) {
    it(`${variant} routes by slug, never by id`, () => {
      const withSubject = renderNotification(
        variant,
        {
          recordId,
          kind: "EVENT_HERO",
          subjectType: "EVENT",
          subjectId,
          subjectTitle: "Night Market Sessions",
          subjectUrl: "https://ithasfire.com/events/night-market-sessions",
          imageUrl: null,
          ...extra,
        },
        ctx,
      );
      expect(withSubject.inApp?.action?.route).toBe(
        "/events/night-market-sessions",
      );
      expect(withSubject.inApp?.action?.route).not.toMatch(UUID_ROUTE);
      expect(withSubject.inApp?.action?.route).not.toContain(subjectId);

      // Multi-segment slugs (the real shape) keep their separators, so the
      // route still matches the `/events/[...slug]` catch-all.
      const multiSegment = renderNotification(
        variant,
        {
          recordId,
          kind: "EVENT_HERO",
          subjectType: "EVENT",
          subjectId,
          subjectTitle: "VIP Members Only Night",
          subjectUrl:
            "https://ithasfire.com/events/bay-area-festivals/us/general/vip-members-only-night--00vfkyl834",
          imageUrl: null,
          ...extra,
        },
        ctx,
      );
      expect(multiSegment.inApp?.action?.route).toBe(
        "/events/bay-area-festivals/us/general/vip-members-only-night--00vfkyl834",
      );

      // No resolved subject → no action at all (never a guessed id route).
      const withoutSubject = renderNotification(
        variant,
        {
          recordId,
          kind: "EVENT_HERO",
          subjectType: "EVENT",
          subjectId,
          subjectTitle: null,
          subjectUrl: null,
          imageUrl: null,
          ...extra,
        },
        ctx,
      );
      expect(withoutSubject.inApp?.action).toBeNull();
    });
  }
});

describe("booking.request-received renderer", () => {
  const NOW = new Date("2026-07-13T12:00:00.000Z");
  const basePayload = {
    bookingRequestId: "40000000-0000-4000-8000-000000000004",
    placeId: "50000000-0000-4000-8000-000000000005",
    placeName: "The Corner Stage",
    actName: "The Midnight Ramblers",
    contactName: "Sam Torres",
    contactEmail: "sam@example.com",
    message: "We'd love to play a Friday night slot.",
    preferredDates: ["2026-08-14", "2026-08-21"],
    source: "EMBED",
    inboxUrl: "https://ithasfire.test/admin/corner-stage/places/plc/bookings",
  } as const;

  it("renders transactional in-app + push + templated email, and NO sms payload", () => {
    const result = renderNotification("booking.request-received", basePayload, {
      now: NOW,
    });

    expect(result.category).toBe("transactional");
    expect(result.sms).toBeUndefined();

    expect(result.inApp).toEqual({
      title: "New booking request for The Corner Stage",
      body: "The Midnight Ramblers wants to play The Corner Stage.",
      kind: "INFO",
      action: {
        label: "Open booking inbox",
        href: basePayload.inboxUrl,
      },
      expiresAt: null,
      tags: ["booking", "request-received"],
      metadata: {
        bookingRequestId: basePayload.bookingRequestId,
        placeId: basePayload.placeId,
        source: "EMBED",
      },
      template: null,
    });

    expect(result.push).toEqual(
      expect.objectContaining({
        title: "New booking request for The Corner Stage",
        collapseKey: `booking-request-${basePayload.bookingRequestId}`,
        data: {
          bookingRequestId: basePayload.bookingRequestId,
          placeId: basePayload.placeId,
          url: basePayload.inboxUrl,
        },
      }),
    );

    // Email template contract — must match @th/ui-email's
    // booking.request_received props schema exactly (a mismatch fails
    // render_failed AFTER the derived idempotency key is claimed).
    expect(result.email?.subject).toBe(
      "New booking request for The Corner Stage",
    );
    expect(result.email?.template).toEqual({
      key: "booking.request_received",
      variables: {
        placeName: "The Corner Stage",
        actName: "The Midnight Ramblers",
        contactName: "Sam Torres",
        contactEmail: "sam@example.com",
        message: basePayload.message,
        preferredDates: ["2026-08-14", "2026-08-21"],
        source: "EMBED",
        inboxUrl: basePayload.inboxUrl,
      },
    });
    expect(result.email?.text).toContain(basePayload.inboxUrl);
    expect(result.email?.text).toContain("sam@example.com");

    expect(result.fingerprint).toEqual({
      variant: "booking.request-received",
      bookingRequestId: basePayload.bookingRequestId,
    });
  });

  it("renders owned/PLATFORM payloads (null contact fields, no preferredDates) without a reply-directly line", () => {
    const result = renderNotification(
      "booking.request-received",
      {
        ...basePayload,
        contactName: null,
        contactEmail: null,
        preferredDates: undefined,
        source: "PLATFORM",
      },
      { now: NOW },
    );

    expect(result.email?.template).toEqual(
      expect.objectContaining({
        key: "booking.request_received",
        variables: expect.objectContaining({
          contactName: null,
          contactEmail: null,
          source: "PLATFORM",
        }),
      }),
    );
    const variables = result.email?.template?.variables as Record<
      string,
      unknown
    >;
    expect("preferredDates" in variables).toBe(false);
    expect(result.email?.text).not.toContain("Reply directly");
  });

  it("rejects empty actName and unexpected fields (strict schema)", () => {
    expect(() =>
      renderNotification(
        "booking.request-received",
        { ...basePayload, actName: "" },
        { now: NOW },
      ),
    ).toThrow();

    expect(() =>
      renderNotification(
        "booking.request-received",
        { ...basePayload, unexpected: "field" },
        { now: NOW },
      ),
    ).toThrow();
  });
});

describe("post-event.attendee-review-prompt renderer", () => {
  const basePayload = {
    eventId: "60000000-0000-4000-8000-000000000006",
    eventTitle: "Loud Night",
    placeName: "The End",
    reviewUrl:
      "https://ithasfire.com/review-event/60000000-0000-4000-8000-000000000006?campaign=post-event-prompt",
  } as const;

  it("is registered in the renderer registry", () => {
    expect(listNotificationRendererVariants()).toContain(
      "post-event.attendee-review-prompt",
    );
  });

  it("renders a marketing in-app + email prompt with the review deep link", () => {
    const result = renderNotification(
      "post-event.attendee-review-prompt",
      basePayload,
      { now: new Date("2026-07-15T00:00:00.000Z") },
    );

    // Solicitation → marketing so a marketing opt-out suppresses it.
    expect(result.category).toBe("marketing");
    expect(result.inApp?.action).toEqual({
      label: "Rate this show",
      href: basePayload.reviewUrl,
    });
    expect(result.inApp?.title).toBe("How was Loud Night?");
    expect(result.inApp?.body).toContain("at The End");
    expect(result.email?.subject).toBe("How was Loud Night?");

    const text = result.email?.text ?? "";
    // FR-008 plain-language promises.
    expect(text).toContain(basePayload.reviewUrl);
    expect(text.toLowerCase()).toContain("aggregate");
    expect(text.toLowerCase()).toContain("without your name");
    // One-time, no reminders.
    expect(text.toLowerCase()).toContain("no reminders");
  });

  it("omits the venue name when no placeName is provided", () => {
    const { placeName: _omit, ...noPlace } = basePayload;
    const result = renderNotification(
      "post-event.attendee-review-prompt",
      noPlace,
      { now: new Date("2026-07-15T00:00:00.000Z") },
    );

    expect(result.inApp?.body).not.toContain("The End");
    expect(result.inApp?.body).toContain("Loud Night");
    // No placeId metadata for attendee prompts (event-keyed only).
    expect(result.inApp?.metadata).toEqual({ eventId: basePayload.eventId });
  });

  it("rejects payloads that fail the strict schema", () => {
    expect(() =>
      renderNotification(
        "post-event.attendee-review-prompt",
        { ...basePayload, reviewUrl: "not-a-url" },
        { now: new Date("2026-07-15T00:00:00.000Z") },
      ),
    ).toThrow();

    expect(() =>
      renderNotification(
        "post-event.attendee-review-prompt",
        { ...basePayload, unexpected: "field" },
        { now: new Date("2026-07-15T00:00:00.000Z") },
      ),
    ).toThrow();
  });
});

describe("event.application-submission-received renderer", () => {
  const payload = {
    eventId: "40000000-0000-4000-8000-000000000004",
    eventTitle: "Secret show",
    submissionId: "50000000-0000-4000-8000-000000000005",
    applicantName: "Jordan Alvarez",
    queueUrl:
      "https://example.com/admin/org/events/40000000-0000-4000-8000-000000000004/applications",
  } as const;

  it("renders the organizer notification with queue action + template", () => {
    const result = renderNotification(
      "event.application-submission-received",
      payload,
      { now: new Date("2026-08-10T00:00:00.000Z") },
    );

    expect(result.category).toBe("transactional");
    expect(result.inApp?.title).toBe("New application for Secret show");
    expect(result.inApp?.body).toBe("Jordan Alvarez applied to Secret show.");
    expect(result.inApp?.action).toEqual({
      label: "Review applications",
      href: payload.queueUrl,
    });
    expect(result.push?.collapseKey).toBe(
      `event-application-${payload.submissionId}`,
    );
    expect(result.email).toMatchObject({
      subject: "New application for Secret show",
      template: {
        key: "event.application_submission_received",
        variables: {
          eventTitle: "Secret show",
          applicantName: "Jordan Alvarez",
          queueUrl: payload.queueUrl,
        },
      },
    });
    expect(result.email?.text).toContain(payload.queueUrl);
  });

  it("rejects an empty applicantName (fails BEFORE the idempotency claim)", () => {
    expect(() =>
      renderNotification(
        "event.application-submission-received",
        { ...payload, applicantName: "" },
        { now: new Date("2026-08-10T00:00:00.000Z") },
      ),
    ).toThrow();
  });
});

describe("place.availability-setup-needed renderer", () => {
  const payload = {
    placeId: "30000000-0000-4000-8000-000000000003",
    placeName: "Drk Basement",
    calendarsUrl:
      "https://ithasfire.test/admin/@owner/places/30000000-0000-4000-8000-000000000003/calendars",
  } as const;

  it("renders an IN-APP ONLY nudge — no email, no push, no sms", () => {
    const result = renderNotification("place.availability-setup-needed", payload, {
      now: new Date("2026-08-31T00:00:00.000Z"),
    });

    expect(result.category).toBe("transactional");
    expect(result.inApp).toEqual({
      title: "Set your hours so acts can reach you",
      body: "Until Drk Basement has hours, every date shows as unavailable and acts can't send you a booking request.",
      kind: "WARNING",
      action: { label: "Set your hours", href: payload.calendarsUrl },
      expiresAt: null,
      tags: ["booking", "availability-setup"],
      metadata: { placeId: payload.placeId },
      template: null,
    });
    // Channel-lock (spec FR-003): the OMITTED payloads are what make the
    // channels skip with `renderer_omitted` regardless of preferences.
    expect(result.email).toBeUndefined();
    expect(result.push).toBeUndefined();
    expect(result.sms).toBeUndefined();
  });

  it("fingerprints per place", () => {
    const result = renderNotification("place.availability-setup-needed", payload, {
      now: new Date("2026-08-31T00:00:00.000Z"),
    });
    expect(result.fingerprint).toEqual({
      variant: "place.availability-setup-needed",
      placeId: payload.placeId,
    });
  });

  it("rejects a payload without a valid absolute calendarsUrl", () => {
    expect(() =>
      renderNotification(
        "place.availability-setup-needed",
        { ...payload, calendarsUrl: "/admin/relative" },
        { now: new Date("2026-08-31T00:00:00.000Z") },
      ),
    ).toThrowError();
  });
});

/** Recursively lists files under a directory (skips node_modules / dist). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

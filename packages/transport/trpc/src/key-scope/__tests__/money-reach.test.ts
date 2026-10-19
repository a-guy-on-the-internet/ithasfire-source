import { describe, expect, it } from "vitest";
import path from "node:path";

import { appRouter } from "../../router";
import { isKeyDenylisted } from "../denylist";
import { CORE_SRC, MoneyGraph, TRPC_SRC, isMoneySeed } from "./money-reach";

// FR-008 structural guard: every procedure whose resolver calls a function
// that (transitively) refunds, reverses a transfer, makes a transfer, or
// creates, confirms on a reader or cancels a payment intent (checkout,
// Terminal: R32), opens a Connect account, answers a dispute, or writes
// payout-terms lines or payees (where later transfers go: R32) must be
// denylisted, or carry a reviewed exemption below. A new refund path fails
// here before anyone can tag it for keys. Read the LIMITS in money-reach.ts:
// the scan is a tripwire, not a proof.

/**
 * Procedures that reach a money file but were READ and found to move no
 * money (2026-10-13). Each needs a reason.
 */
const REVIEWED_MONEY_REACH: Record<string, string> = {
  // Reads that share pricing / settlement helpers with a money file (the
  // scan counts every function a money file exports); none calls the port.
  "events.getEventFeePreview":
    "a fee preview: pricing helpers shared with checkout, no payment intent",
  "orders.getOrgOrder":
    "an order read: charge-breakdown helpers shared with checkout",
  "deals.getEventSettlement":
    "a settlement-sheet read: shares settlement-sheet.ts with the writes",
  "deals.exportEventSettlementCsv":
    "a settlement-sheet CSV read: built on getEventSettlement",
  "orders.quoteFullRefund":
    "a quote: imports assertOrderNotDisputeBlocked, and from refund-full-order.ts only its state/claim asserts, item reads and share math",
  // a91048b2e: the read reports CLAIM_REFUND_PENDING through
  // hasPendingClaimRefund (refund-full-order.ts, one claims.getByOrderItemId
  // per ticket item). Read 2026-10-14: the use case writes nothing and calls
  // only payments.getProcessingFeeForPaymentIntent; actorHumanId comes from
  // ctx and a non-buyer gets order_not_found.
  "orders.getRefundEligibility":
    "a buyer's eligibility read: hasPendingClaimRefund from refund-full-order.ts is a claims read",
  // Booking exits cancel the request's DRAFT event through
  // runExitWithDraftCancel -> cancelEventForBooking(auditVia "booking_exit").
  // SPOT-CHECKED 2026-10-13 for withdraw and close
  // (withdraw-booking-request.ts:325, close-booking-request.ts:230):
  // cancel-event.ts refuses a non-DRAFT at load (loadEventForBookingCancel, :1334),
  // refuses with EVENT_NOT_CANCELLABLE BEFORE the refund stage when any
  // refundable order exists (:415-418), and re-pins DRAFT under the row lock
  // (:507-509). A DRAFT has sold nothing, so nothing is refunded.
  "bookingRequests.withdraw": "booking exit: DRAFT-only cancel (spot-checked)",
  "bookingRequests.close": "booking exit: DRAFT-only cancel (spot-checked)",
  // Accepting a booking request mints a PENDING agreement
  // (accept-agreement.ts createAcceptAgreement): a clone of the PLACE's own
  // default terms with confirmations reset, an empty draft, or one 100% line
  // to the request's own proposer. No payee comes from the caller, and the
  // terms are agreed later in bookingAgreements.respond / finalize
  // (denylisted, R32). respond also imports read-only booked-night asserts
  // from accepted-request-exit.ts.
  "bookingRequests.respond":
    "accept: mints PENDING terms from the place default or the proposer, nothing agreed",
  "bookingRequests.claim":
    "invite-to-claim: the same createAcceptAgreement as an accept, nothing agreed",
  "bookingHolds.bookNightWithoutTerms":
    "accept in tx + hold mint (mode hold: finalize never attempted), no terms agreed",
  // Publishing activates the event's PENDING primary terms and, when they have
  // no lines, seeds one 100% line to the event's OWN payee
  // (publish-event.ts seedDefaultOwnerLineForLinelessDraft). The PENDING
  // terms a key can author come from the booking accepts above (a clone of
  // the place's session-authored default, or one 100% line to the
  // requester's own payee); every path that takes a caller-chosen payee
  // (updateEventSplits, agreement lines, deals) is denylisted. Orchestrator
  // reading, 10-13: the owner may overrule.
  "events.publishEvent":
    "PENDING terms a key can author are clones of the place default (session-authored) or a 100% line to the requester's own payee; caller-chosen payees come only from denylisted paths",
  "bookingRequests.list":
    "a list: imports the pure mintEventOwnerSide from agreement-mint-plan.ts",
  // FALSE POSITIVES: these resolvers call `answerActNotices`, a notifier
  // helper exported from routers/booking-requests.ts, which the scan counts
  // as a money file because it imports withdraw / close. The act-answer use
  // case itself (answer-booking-request-act.ts) and leave-event-lineup.ts
  // reach no money file (checked 2026-10-13).
  "bookingRequests.joinAct": "false positive: answerActNotices notifier helper",
  "bookingRequests.passAct": "false positive: answerActNotices notifier helper",
  "bookingRequests.confirmAct": "false positive: answerActNotices notifier helper",
  "bookingRequests.declineAct": "false positive: answerActNotices notifier helper",
  "eventHumans.leave": "false positive: answerActNotices notifier helper",
};

describe("FR-008: money-moving procedures are denylisted", () => {
  const graph = new MoneyGraph();
  const money = graph.moneyFiles();
  const names = graph.transportMoneyImports(money);
  const procedures = Object.entries(
    appRouter._def.procedures as unknown as Record<
      string,
      { _def: { resolver?: unknown } }
    >,
  );
  const reach = procedures
    .map(([p, def]) => {
      const src = String(def._def.resolver ?? "");
      const hits = [...names.keys()].filter((n) =>
        new RegExp(`\\b${n}\\b`).test(src),
      );
      // A resolver calling the payments port, or writing payout terms or
      // payees, itself.
      if (isMoneySeed(src)) hits.push("<money seed call>");
      return { path: p, hits };
    })
    .filter((r) => r.hits.length > 0);

  it("finds the known refund primitives (the analysis is not blind)", () => {
    const rel = new Set(
      [...money].map((f) => path.relative(CORE_SRC, f)),
    );
    for (const f of [
      "use-cases/orders/refund-full-order.ts",
      "use-cases/orders/refund-order-items.ts",
      "use-cases/orders/reverse-transfers-for-items.ts",
      "use-cases/events/cancel-event.ts",
      "use-cases/resale/review-claim.ts",
      "use-cases/series/cancel-event-series.ts",
      "use-cases/booking-requests/cancel-booking.ts",
    ]) {
      expect(rel.has(f), f).toBe(true);
    }
    expect(reach.map((r) => r.path)).toEqual(
      expect.arrayContaining([
        "orders.refundFullOrder",
        "events.cancelEvent",
        "claims.review",
        "series.cancelEventSeries",
        "bookingRequests.cancelBooking",
      ]),
    );
  });

  it("denylists every procedure that reaches one, or records why not", () => {
    const open = reach
      .filter((r) => !isKeyDenylisted(r.path) && !(r.path in REVIEWED_MONEY_REACH))
      .map((r) => `${r.path} -> ${r.hits.join(", ")}`);
    expect(open).toEqual([]);
  });

  it("maps every money function imported into the transport to a procedure", () => {
    // A money function used only through a local helper would be invisible
    // to the resolver scan: fail, so the helper gets mapped by hand.
    const used = new Set(reach.flatMap((r) => r.hits));
    const unmapped = [...names.entries()]
      .filter(([n]) => !used.has(n))
      .map(([n, where]) => `${n} (${where.join(", ")})`);
    expect(unmapped).toEqual([]);
  });

  it("keeps the exemptions honest (each still reaches money, none denylisted)", () => {
    const reached = new Set(reach.map((r) => r.path));
    expect(
      Object.keys(REVIEWED_MONEY_REACH).filter(
        (p) => !reached.has(p) || isKeyDenylisted(p),
      ),
    ).toEqual([]);
  });

  it("denylists every procedure that wires the comp-reward hooks (R33 / R34a)", () => {
    // The reward hooks grant $0 comp tickets through a router-local factory
    // the import scan cannot see (LIMITS in money-reach.ts), so they get
    // their own tripwire: a resolver that builds them can grant (signup
    // review fires ON_APPROVAL, check-in fires ON_CHECK_IN). Withdrawal only
    // revokes, through `volunteerWithdrawDeps`, and is not matched.
    const wiring = procedures
      .filter(([, def]) => /\bmakeRewardHooks\s*\(/.test(String(def._def.resolver ?? "")))
      .map(([p]) => p);
    expect(wiring).toEqual(
      expect.arrayContaining([
        "volunteer.signups.review",
        "volunteer.signups.reviewBatch",
        "volunteer.signups.checkIn",
      ]),
    );
    expect(wiring.filter((p) => !isKeyDenylisted(p))).toEqual([]);
  });

  it("scans the transport too", () => {
    expect([...graph.mods.keys()].some((f) => f.startsWith(TRPC_SRC))).toBe(true);
  });
});

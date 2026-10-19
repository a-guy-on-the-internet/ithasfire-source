/**
 * FR-008 / R4 / R32 / R33 / R34: procedures no API key may call, whatever its
 * subject, access or the procedure's tag. Session-only: money movement,
 * credentials, members and roles, deleting an account or an org (R4); a
 * person's yes (R32): transfers, resale, money terms, checkout, org creation,
 * coordinator assignment, push devices; price writes (R33: promo codes
 * (create/update), comp tickets, seat price overrides, ticket type
 * create/update; "a leaked key must not be able to give tickets away"), with
 * the orchestrator's R33 extras the owner kept (R34b: promo revoke, ticket
 * type delete, ticket-type-to-section assignment, manual tax rate, membership
 * tier and benefit writes, volunteer reward settings and signup approval);
 * volunteer check-in, which fires the comp reward (R34a); and claiming a place
 * (R34c), like ownership transfer. Switching volunteer auto-approve on (R34a)
 * is refused per input field instead (input-guard.ts). The gate checks this
 * list BEFORE the procedure's tag, and NFR-002's test fails when a listed
 * procedure carries a key tag.
 *
 * The one exception is `apiKeys.renewSelf` (FR-009), reached only through the
 * `selfRenewal` tag, which the gate honours on that exact path alone.
 *
 * Bans (`platform.setHumanStatus`) are deliberately NOT here: R22 keeps them
 * on read-write STAFF keys in v1.
 *
 * Passkeys, passwords, sessions and 2FA enrolment are served by Better Auth's
 * own routes, not tRPC, so a key never reaches them through this transport.
 *
 * Adding a procedure here only narrows what keys can do. Removing one is a
 * security decision: it needs a reviewer and, for anything in R4's four
 * classes, the owner.
 */

/** Whole routers: every procedure under the prefix. */
export const KEY_DENYLISTED_PREFIXES: readonly string[] = [
  // Credentials: every apiKeys procedure, its list reads included (keys
  // cannot list or manage keys). renewSelf is the FR-009 exception.
  "apiKeys.",
  // Money: payout statements and overviews.
  "payouts.",
  // Money: Stripe Connect onboarding, status and dashboard login links.
  "stripeConnect.",
  // Members and roles: event delegates.
  "delegates.",
  // Money: chargeback evidence drafted and submitted to Stripe.
  "platform.disputes.",
  // Money: job DLQ reruns and deletes (reruns can replay payout and
  // settlement jobs).
  "platformJobs.",
  // TODO(holds-without-a-request step 9): add "placeBookingGrants." with the
  // router (FR-003: giving, answering, editing, revoking a grant are
  // session-only). Legacy keys skip the key-scope repo override (gate.ts),
  // so this prefix is their only refusal. Not added yet: no procedure
  // exists, and procedure-tags.test.ts fails a prefix that matches nothing.
];

/** Single procedures. */
export const KEY_DENYLISTED_PATHS: ReadonlySet<string> = new Set([
  // ── Money movement: refunds ──
  "orders.staffRefundOrder",
  "orders.refundFullOrder",
  "orders.refundOrderItems",
  "orders.orgRefundOrderItems",
  "orders.orgRefundFullOrder",
  "orders.orgRefundCashSale",
  "pos.refundRecentSale",
  "pos.refundCashSale",
  // Each of these can refund paid orders: a resale claim upheld (refund +
  // transfer reversal), an event or a whole series cancelled, a booked night
  // cancelled. Found by the structural money-reach test.
  "claims.review",
  "events.cancelEvent",
  "series.cancelEventSeries",
  "bookingRequests.cancelBooking",
  // ── Money movement: cash sales and their debts, Stripe Terminal ──
  "pos.recordCashSale",
  "pos.connectionToken",
  "pos.startSale",
  "pos.completeSale",
  "pos.cancelSale",
  "pos.processOnReader",
  "pos.cancelReaderAction",
  "pos.pairReader",
  "pos.updateReader",
  "pos.unpairReader",
  // ── Money movement: settlements, credit, fee waivers, payout terms ──
  "settlements.createFromOrder",
  "credits.grant",
  "platform.grantFeeWaiver",
  "platform.revokeFeeWaiver",
  "deals.markEventSettled",
  "deals.reopenEventSettlement",
  "payoutTerms.confirmPayoutLine",
  "agreements.updatePayoutSchedule",
  // ── Money movement: Stripe webhook replays ──
  "platform.replayWebhookDlqItem",
  "platform.removeWebhookDlqItem",
  // ── Money movement: paid memberships (subscriptions, billing portal) ──
  "memberships.start",
  "memberships.cancel",
  "memberships.portalSession",
  "platform.suspendMembershipStanding",
  "platform.overrideMembershipStanding",
  // ── Money: accepting chargeback liability is a person's consent ──
  "humans.acceptMyChargebackTerms",
  "orgs.acceptChargebackTerms",
  // ── Credentials ──
  "humans.hasPasswordCredential",
  "platform.listHumanAuthAccounts",
  "platform.unlinkAuthAccount",
  "platform.forceVerifyEmail",
  "volunteer.ics.myFeedToken",
  "volunteer.ics.rotateMyFeedToken",
  "volunteer.signups.mintScanToken",
  // ── Members and roles ──
  "orgs.inviteMember",
  "orgs.acceptInvitation",
  "orgs.revokeInvitation",
  "orgs.updateMemberRole",
  "orgs.removeMember",
  "orgs.transferOwnership",
  "platform.grantRole",
  "platform.revokeRole",
  // Granting the COMMUNITY_MODERATOR role.
  "moderatorApplications.review",
  // Place verification decides which org controls a place (ownership).
  "places.reviewPlaceVerification",
  "platform.reviewPlaceVerification",
  "platform.updatePlaceVerificationStatus",
  // ── Deleting an account or an org ──
  "humans.deleteMyAccount",
  "orgs.deleteOrg",
  "platform.deleteHuman",

  // ── R32 (owner, 2026-10-13): a person's yes, never a script's ──
  // R32: ticket transfers.
  "tickets.transferTicket",
  "tickets.initiateEmailTransfer",
  "tickets.claimPendingTransfer",
  "tickets.cancelPendingTransfer",
  // R32: resale listing and checkout, and the org's resale policy.
  "resale.createListing",
  "resale.cancelListing",
  "resale.createCheckout",
  "orgs.setOrganizationResalePolicy",
  // Its rename (the old path stays as a deprecated alias), and the resale
  // share clause on a RESALE payout-terms row: both write payout terms.
  "orgs.setDefaultAgreement",
  "deals.setResaleClause",
  // R32: agreeing to money terms. Deal terms, settlement-sheet writes,
  // booking agreement terms: the header (guaranteeCents), lines, proposing
  // (sendForReview, sendTerms), retracting (pullBack), reopening to adjust
  // economics, responding, finalizing, cancelling.
  "deals.setTermsDeal",
  // freeze-the-deal FR-003: freezing fixes the deal every payee is paid on;
  // after it, a change is a recorded, announced edit. Session only (R32).
  "deals.freezeEventDeal",
  // A payee's yes or no on a deal clause is consent: session only (R32).
  "deals.confirmDealClause",
  "deals.declineDealClause",
  "deals.upsertSheetOffPlatform",
  "deals.removeSheetOffPlatform",
  "deals.setSheetDeductionActual",
  "deals.clearSheetDeductionActual",
  "deals.addSheetDirectPayment",
  "deals.removeSheetDirectPayment",
  "bookingAgreements.updateHeader",
  "bookingAgreements.sendForReview",
  "bookingAgreements.pullBack",
  "bookingAgreements.reopen",
  "bookingAgreements.upsertLine",
  "bookingAgreements.removeLine",
  "bookingAgreements.sendTerms",
  "bookingAgreements.respond",
  "bookingAgreements.finalize",
  "bookingAgreements.cancel",
  // Minting the event from an agreement runs `finalizeBookingAgreement`
  // (activates the agreed payout terms) when the venue owns the event, the
  // same write as `bookingAgreements.finalize` (create-event-from-agreement.ts
  // tryFinalize). Found by the money-reach test's payout-terms seeds.
  "bookingAgreements.createEventFromAgreement",
  // Keeping a challenged hold is "Agree & book": it runs
  // `respondToBookingAgreement`, the same yes as `bookingAgreements.respond`
  // (answer-booking-hold-challenge.ts). Found the same way.
  "bookingHolds.answer",
  // R32 (orchestrator reading, spec R33 header): payout splits are money
  // terms. `updateEventSplits` writes the payout-terms lines and creates the
  // payees a sale is split between, so a key could route an event's payouts
  // to another org.
  "events.updateEventSplits",
  // R32 (same reading): moving paid orders onto another event moves them
  // under that event's splits.
  "orders.migrateEventOrders",
  // R32: checkout and payment confirmation, and the carts behind them
  // (editing a pending order, releasing its payment intent).
  "orders.createCheckout",
  "orders.updateOrderItems",
  "orders.confirmPayment",
  "orders.releaseCartHold",
  "embeds.createGuestCheckout",
  "embeds.confirmGuestPayment",
  "embeds.releaseGuestOrder",
  // R32: org creation, volunteer coordinator assignment, push devices.
  "orgs.createOrg",
  "volunteer.groups.assignCoordinator",
  "notifications.registerPushDevice",
  "notifications.unregisterPushDevice",

  // ── R33 (owner, 2026-10-13, "Block them for keys"): price writes ──
  // A leaked key must not be able to give tickets away.
  // R33: promo codes, including revoking one.
  "promos.create",
  "promos.update",
  "promos.revoke",
  // R33: comp tickets.
  "comp.issue",
  // R33: seat prices: per-seat overrides, and which ticket type (price) a
  // seating section sells at.
  "events.setSeatPriceOverrides",
  "events.assignTicketTypeSections",
  // R33: ticket types, one at a time or in bulk from a template.
  "ticketTypes.upsertTicketType",
  "ticketTypes.updateTicketType",
  "ticketTypes.deleteTicketType",
  "ticketTypeTemplates.applyTicketTypeTemplate",
  // R33: tax override. A manual rate of zero under-charges tax on every sale.
  "events.setManualTaxRate",
  // R33: membership tier prices and member discounts (a benefit is a
  // percent or amount off tickets, up to all of it).
  "memberships.tiers.create",
  "memberships.tiers.update",
  "memberships.tiers.publish",
  "memberships.tiers.archive",
  "memberships.benefits.attach",
  "memberships.benefits.update",
  "memberships.benefits.remove",
  // R33: volunteer rewards are $0 comp tickets. Setting or revoking a reward,
  // and approving signups, which grants it (`makeRewardHooks` in
  // routers/volunteer.ts).
  "volunteer.rewards.set",
  "volunteer.rewards.revoke",
  "volunteer.signups.review",
  "volunteer.signups.reviewBatch",

  // ── R34 (owner, 2026-10-13) ──
  // R34a (with R33): checking a volunteer in fires the ON_CHECK_IN comp
  // reward grant (`checkInVolunteer` -> maybeFireRewardGrant, through
  // `makeRewardHooks` in routers/volunteer.ts).
  "volunteer.signups.checkIn",
  // R34c: claiming a place is session-only, like ownership transfer. A claim
  // whose email domain matches the place's website is VERIFIED in one motion
  // (submit-place-claim.ts, FR-010 fast-track), handing the place to the
  // claimant. The other claim steps (doc upload, email challenge, reads)
  // grant nothing on their own.
  "places.submitPlaceClaim",
]);

export function isKeyDenylisted(path: string): boolean {
  if (KEY_DENYLISTED_PATHS.has(path)) return true;
  return KEY_DENYLISTED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

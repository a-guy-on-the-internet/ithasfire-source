/**
 * Load an agreement's deal and decide what the actor may see of it (M5) —
 * shared by the deal read and the projection.
 */
import type { Repos } from "@th/ports/repos";
import type { AgreementRecord } from "@th/ports/repos/agreements";
import type { BookingRequestRecord } from "@th/ports/repos/booking-requests";
import type { PayoutTermsDealRecord } from "@th/ports/repos/deals";
import { fail, isAppError } from "@th/errors";

import { ORG_EDIT_OR_FINANCE_ROLES, ORG_EDIT_ROLES } from "../../../lib/rbac";
import {
  partyOnSide,
  requireAgreementParty,
} from "../../booking-agreements/_shared/agreement-access";
import { termsSideForRequest } from "../../booking-agreements/_shared/agreement-editor-side";
import { requirePayoutTermsId } from "../../booking-agreements/_shared/agreement-lines";
import { resolveDealRemainder, type DealRemainder } from "./deal-from-storage";
import { resolveDealViewer, type DealViewer } from "./deal-visibility";

export type AgreementDealContextRepos = Pick<
  Repos,
  "agreements" | "deals" | "bookingRequests" | "events" | "payees" | "authz"
>;

export type AgreementDealContext = {
  agreement: AgreementRecord;
  payoutTermsId: string;
  deal: PayoutTermsDealRecord;
  bookingRequest: BookingRequestRecord | null;
  /** The event the booking produced (finalized, else the minted draft). */
  eventId: string | null;
  remainder: DealRemainder | null;
  viewer: DealViewer;
  /**
   * The actor may change the deal right now: an edit-level party on the
   * terms-editor side (never the act) and the agreement still a DRAFT that no
   * event has been finalized on. Mirrors `getBookingAgreement.mayEdit`.
   */
  mayEdit: boolean;
};

export async function loadAgreementDealContext(
  repos: AgreementDealContextRepos,
  input: { agreementId: string; actorHumanId: string },
): Promise<AgreementDealContext> {
  const agreement = await repos.agreements.getById(input.agreementId);
  if (!agreement) throw fail("AGREEMENT_NOT_FOUND");
  const payoutTermsId = requirePayoutTermsId(agreement);

  const deal = await repos.deals.getTermsDeal(payoutTermsId);
  if (!deal) throw fail("PAYOUT_TERMS_NOT_FOUND");

  const bookingRequest = await repos.bookingRequests.findByAgreementId(agreement.id);
  const eventId = agreement.eventId ?? agreement.draftEventId ?? null;
  const event = eventId ? await repos.events.getById(eventId) : null;

  const remainder = await resolveDealRemainder(repos, {
    deal,
    event,
    agreement,
    bookingRequest,
  });

  // M13 (owner, 2026-10-04): the whole deal is for edit or finance roles on a
  // party org (OWNER/ADMIN/EDITOR/FINANCE) or the human party. VIEWERs and
  // SCANNERs do not see it — the agreement page's own payout lines are a
  // separate, unchanged rule (`getBookingAgreement`).
  const viewer = await resolveDealViewer(repos, {
    actorHumanId: input.actorHumanId,
    parties: [partyOnSide(agreement, "proposer"), partyOnSide(agreement, "counterparty")],
    partyOrgRoles: ORG_EDIT_OR_FINANCE_ROLES,
    payeeIds: [
      ...deal.clauses.map((c) => c.payeeId),
      ...deal.deductions.map((d) => d.creditedPayeeId),
      ...(remainder ? [remainder.payeeId] : []),
    ],
  });
  if (!viewer) throw fail("NOT_AGREEMENT_PARTY");

  let mayEdit = false;
  if (
    viewer.visibility === "FULL" &&
    agreement.status === "DRAFT" &&
    agreement.eventId === null
  ) {
    try {
      const party = await requireAgreementParty(repos, {
        agreement,
        actorHumanId: input.actorHumanId,
        orgRoles: ORG_EDIT_ROLES,
      });
      mayEdit = termsSideForRequest(bookingRequest, agreement, party.side) !== "act";
    } catch (err) {
      // Not an edit-level party: a read-only viewer — an answer, not a
      // failure. Anything else (a repo error) is rethrown, never swallowed.
      if (!(isAppError(err) && err.code === "NOT_AGREEMENT_PARTY")) throw err;
      mayEdit = false;
    }
  }

  return {
    agreement,
    payoutTermsId,
    deal,
    bookingRequest,
    eventId,
    remainder,
    viewer,
    mayEdit,
  };
}

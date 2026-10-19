import type {
  CountOpenDisputesByOwnersInput,
  DisputeEvidenceAttentionRow,
  DisputeRecord,
  ListDisputesForDeskInput,
  ListDisputesForDeskResult,
  ListOpenDisputesNeedingEvidenceAttentionInput,
  MembershipDisputeExposureRow,
  OwnerLatestLostMembershipDisputeRow,
  OwnerOpenDisputeCountRow,
  UpdateDisputeEvidenceDetailsInput,
  UpsertDisputeFromStripeInput,
} from "@th/types/repos/disputes";

export interface DisputesRepo {
  findByStripeDisputeId(stripeDisputeId: string): Promise<DisputeRecord | null>;
  getById(disputeId: string): Promise<DisputeRecord | null>;
  upsertFromStripe(input: UpsertDisputeFromStripeInput): Promise<DisputeRecord>;

  /**
   * Writes the Stripe `evidence_details` mirror columns. Returns null (no
   * throw) when the dispute is unknown locally — a webhook can legitimately
   * arrive for a dispute whose intake has not run yet, and the mirror is
   * cosmetic next to the lifecycle write.
   */
  updateEvidenceDetails(
    input: UpdateDisputeEvidenceDetailsInput,
  ): Promise<DisputeRecord | null>;

  /**
   * Staff desk queue. `open` = every non-terminal status, sorted
   * `evidenceDueBy ASC NULLS LAST, id ASC` (soonest deadline first, never-due
   * rows at the end); `closed` = WON/LOST/WARNING_CLOSED sorted
   * `closedAt DESC NULLS LAST, id DESC`; `all` = every row, open ordering.
   * Keyset cursor = the last row's id; an unknown cursor restarts from the
   * top rather than leaking another queue's position.
   */
  listForDesk(input: ListDisputesForDeskInput): Promise<ListDisputesForDeskResult>;

  /**
   * Daily evidence-deadline sweep feed. Rows where
   * `status = OPEN` (Stripe only reaches UNDER_REVIEW after a submission)
   * AND `orderId IS NOT NULL`
   * AND no submission — desk `evidenceSubmittedAt IS NULL` AND Stripe mirror
   *   `(evidenceSubmissionCount IS NULL OR evidenceSubmissionCount = 0)`,
   *   so a package submitted by hand in the Stripe Dashboard is not chased —
   * AND (
   *   `evidenceDueBy <= now + dueWithinDays` OR `evidenceDueBy IS NULL` OR
   *   no DisputeEvidence row OR its status is SUBMIT_FAILED
   * ). Sorted `evidenceDueBy ASC NULLS LAST, id ASC`, capped at 200.
   */
  listOpenNeedingEvidenceAttention(
    input: ListOpenDisputesNeedingEvidenceAttentionInput,
  ): Promise<DisputeEvidenceAttentionRow[]>;

  /**
   * Dispute-fee exposure per owner, restricted to disputes whose linked order
   * is `kind = MEMBERSHIP`, grouped by (owner, status) in ONE query. Disputes
   * still awaiting order linkage (`orderId` null, NEEDS_TRIAGE) are excluded
   * by construction — exposure is defined over membership ORDERS.
   */
  listMembershipExposureByOwner(): Promise<MembershipDisputeExposureRow[]>;

  /**
   * Latest LOST-dispute timestamp per owner, restricted to disputes on
   * MEMBERSHIP orders — the seasoning curve's reset/freeze signal. One
   * grouped query platform-wide (LOST membership disputes are rare by
   * construction; grouping the whole table beats a per-batch owner filter
   * through two levels of denormalised owner columns). Owners who never lost
   * one are simply absent. See {@link OwnerLatestLostMembershipDisputeRow}
   * for the closedAt/createdAt timestamp approximation.
   */
  latestLostMembershipDisputeAtByOwner(): Promise<
    OwnerLatestLostMembershipDisputeRow[]
  >;

  /**
   * Open-dispute count (`OPEN` / `UNDER_REVIEW` — the statuses that block a
   * credit in the payable query) per owner, scoped to the given owner ids in
   * ONE grouped query. Both lists empty → `[]` without querying. Owners with
   * nothing open are absent.
   */
  countOpenByOwners(
    input: CountOpenDisputesByOwnersInput,
  ): Promise<OwnerOpenDisputeCountRow[]>;
}

export type {
  CountOpenDisputesByOwnersInput,
  DisputeDeskRow,
  DisputeDeskStatusFilter,
  DisputeEvidenceAttentionRow,
  DisputeEvidenceSources,
  DisputeEvidenceSourceState,
  DisputeEvidenceStatus,
  DisputeRecord,
  DisputeStatus,
  ListDisputesForDeskInput,
  ListDisputesForDeskResult,
  ListOpenDisputesNeedingEvidenceAttentionInput,
  MembershipDisputeExposureRow,
  OwnerLatestLostMembershipDisputeRow,
  OwnerOpenDisputeCountRow,
  UpdateDisputeEvidenceDetailsInput,
  UpsertDisputeFromStripeInput,
} from "@th/types/repos/disputes";

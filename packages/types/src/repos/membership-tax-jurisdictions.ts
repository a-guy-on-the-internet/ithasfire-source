/**
 * Cached destination-sourced tax rates for memberships.
 *
 * Membership tax sources to the MEMBER's billing address, unlike ticket tax
 * which sources to the venue. That makes the rate a property of the place, not
 * the person: every member in one postal code shares a single cached row and a
 * single Stripe TaxRate, rather than each holding a copy that can drift.
 */

/**
 * Identifies one taxable jurisdiction.
 *
 * Deliberately NOT keyed by product category. US taxability really does vary
 * by what is sold, but `TaxRateLookupPort.lookupByPostalCode` takes only
 * `{postalCode, countryCode}` and returns one rate — so a category could never
 * change the answer, and carrying it only split one ZIP's cache into N rows
 * and N provider calls while implying a determination nobody made.
 */
export interface MembershipTaxJurisdictionKey {
  countryCode: string;
  postalCode: string;
}

export interface MembershipTaxJurisdictionRecord
  extends MembershipTaxJurisdictionKey {
  id: string;
  rateBps: number;
  /**
   * "ziptax:general" | "static-ca" | "manual:general" | "exempt:*" —
   * provenance for audit. NOTHING branches on it; the `:general` suffix is
   * there because the only reader is a human, and these rows must not imply a
   * category determination that was never made.
   */
  rateSource: string;
  /**
   * Lazily minted. A jurisdiction row exists as soon as we know the rate; the
   * Stripe TaxRate is only needed once a subscription actually references it,
   * which keeps our cache and Stripe from needing a two-phase commit.
   */
  stripeTaxRateId: string | null;
  /** When the rate was last confirmed against the provider. */
  checkedAt: Date;
  effectiveFrom: Date | null;
  /** Set when superseded. Archived rows are retained for subscriptions still on them. */
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMembershipTaxJurisdictionInput
  extends MembershipTaxJurisdictionKey {
  rateBps: number;
  rateSource: string;
  checkedAt: Date;
  effectiveFrom?: Date | null;
}

export interface MembershipTaxJurisdictionsRepo {
  /** The single live (non-archived) row for a key, if we have one. */
  findLive(
    key: MembershipTaxJurisdictionKey,
  ): Promise<MembershipTaxJurisdictionRecord | null>;

  findById(id: string): Promise<MembershipTaxJurisdictionRecord | null>;

  create(
    input: CreateMembershipTaxJurisdictionInput,
  ): Promise<MembershipTaxJurisdictionRecord>;

  /**
   * Live rows whose `checkedAt` is at or before `staleBefore`, oldest first.
   *
   * This is the refresh job's work-list. It is time-based on purpose: a
   * jurisdiction changing its own rate produces NO member-side event, so no
   * address-change or tier-change trigger can ever detect it.
   */
  listStale(input: {
    staleBefore: Date;
    limit: number;
  }): Promise<MembershipTaxJurisdictionRecord[]>;

  /** Mark superseded. Does not delete — subscriptions may still reference it. */
  archive(input: {
    id: string;
    archivedAt: Date;
  }): Promise<MembershipTaxJurisdictionRecord>;

  /** Record a freshly-confirmed rate without creating a new row. */
  touchCheckedAt(input: {
    id: string;
    checkedAt: Date;
  }): Promise<MembershipTaxJurisdictionRecord>;

  attachStripeTaxRateId(input: {
    id: string;
    stripeTaxRateId: string;
  }): Promise<MembershipTaxJurisdictionRecord>;

  /**
   * Repoint every membership on `fromJurisdictionId` at `toJurisdictionId`.
   * Returns how many moved, so the refresh job can report real numbers rather
   * than assert success.
   */
  migrateMemberships(input: {
    fromJurisdictionId: string;
    toJurisdictionId: string;
  }): Promise<{ migratedCount: number }>;
}

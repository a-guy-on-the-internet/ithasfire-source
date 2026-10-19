export interface MembershipStandingRecord {
  id: string;
  ownerOrgId: string | null;
  ownerHumanId: string | null;
  suspended: boolean;
  suspendedAt: Date | null;
  suspendedReason: string | null;
  /** Rolling reserve on membership payouts, seasoning down with history. */
  reserveBps: number;
  reserveReleaseDays: number;
  /**
   * MANUAL-OVERRIDE MARKER. Non-null means a platform admin has explicitly
   * pinned this row's RESERVE via the reserve override, and the value is the
   * acting admin's human id.
   *
   * ONLY the reserve override stamps it. Suspend/unsuspend deliberately do
   * not: a fresh standing row defaults `reserveBps = 0`, so stamping the
   * marker on a suspend would pin the suspended — highest-risk — payee's
   * reserve at 0% (the exact opposite of intent).
   *
   * Automatic reserve seasoning MUST treat `overriddenBy != null` as "hands
   * off": never recompute `reserveBps` / `reserveReleaseDays` for a row a
   * human has pinned. There is no separate flag — this field IS the flag.
   */
  overriddenBy: string | null;
  overrideReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MembershipStandingsRepo {
  /**
   * Standing for an owner, or null when none has ever been written.
   *
   * Null means "nothing has gone wrong", NOT "suspended" — standing rows are
   * created lazily when a reserve or suspension is first applied.
   */
  findForOwner(input: {
    ownerOrgId?: string | null;
    ownerHumanId?: string | null;
  }): Promise<MembershipStandingRecord | null>;

  upsertForOwner(input: {
    ownerOrgId?: string | null;
    ownerHumanId?: string | null;
    suspended?: boolean;
    suspendedAt?: Date | null;
    suspendedReason?: string | null;
    reserveBps?: number;
    reserveReleaseDays?: number;
    overriddenBy?: string | null;
    overrideReason?: string | null;
  }): Promise<MembershipStandingRecord>;

  /**
   * Every standing row, for the platform standing overview. Unbounded on
   * purpose: rows exist only where someone (admin or the seasoning job) has
   * intervened, so the table is small by construction — and an owner-id-driven
   * batch read would structurally miss the most important rows, the suspended
   * owners who have since deleted every tier. Owners with no row are simply
   * absent (see `findForOwner` — absence means "nothing has gone wrong",
   * never "suspended").
   */
  listAll(): Promise<MembershipStandingRecord[]>;
}

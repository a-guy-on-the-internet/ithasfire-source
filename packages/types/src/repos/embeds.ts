export interface EmbedRecord {
  id: string;
  /**
   * "event" | "organization" | "place" | "human" | "memberships".
   *
   * Intentionally a bare `string` (matching the DB column, which is not an
   * enum) so new subject types need no migration. The authoritative list is
   * `ALLOWED_SUBJECT_TYPES` in
   * `packages/core/src/use-cases/embeds/upsert-embed.ts`, which is what the
   * write path validates against; read/revoke paths fork on the STORED value.
   *
   * `subjectId` is the id of the corresponding entity: an Event, Organization,
   * Place, or Human id respectively. For "memberships" it is the membership
   * tier OWNER's id — an Organization id or a Human id, resolved org-first.
   */
  subjectType: string;
  subjectId: string;
  domain: string;
  status: string; // "ACTIVE" | "REVOKED"
  requireAuth: boolean;
  linkOut: boolean;
  /**
   * "list" | "calendar" — the browse view a BARE `/embed/[id]` renders.
   *
   * Intentionally a bare `string` (matching the DB column, which is not an
   * enum) for the same reason as `subjectType`: the vocabulary can grow
   * without a migration. `EMBED_VIEWS` in
   * `packages/core/src/use-cases/embeds/upsert-embed.ts` is the authority the
   * write path validates against; read paths fork on the STORED value and
   * treat anything unrecognised as "list".
   *
   * Always "list" for rows written before the column existed (column default),
   * which is exactly today's behaviour. Meaningless for "place" subjects — the
   * booking-button embed has no views and the write path rejects the field.
   */
  defaultView: string;
  /**
   * When true the widget renders a viewer-facing List/Calendar switcher.
   * False for every pre-existing row (column default), and never set for
   * "place" subjects.
   */
  viewToggle: boolean;
  /** Null when the creating account has been deleted (creator detached). */
  createdBy: string | null;
  createdAt: Date;
}

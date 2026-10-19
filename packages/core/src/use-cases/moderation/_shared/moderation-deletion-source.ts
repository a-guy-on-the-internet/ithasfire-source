/**
 * The `source` stamp `review-flagged-image.ts` writes on every
 * `pending_object_deletions` row it enqueues when a moderator REJECTs an image.
 *
 * A CONSTANT, in a file of its own, because two unrelated places now depend on
 * the exact string: the REJECT path that writes it, and the ops read that
 * counts rows carrying it. A typo on either side produces a permanent ZERO on
 * the dashboard — the most dangerous wrong answer available, because a tile
 * reading 0 is indistinguishable from a healthy outbox and nobody investigates
 * "no problems".
 *
 * Lives in `_shared` rather than being exported from `review-flagged-image.ts`
 * so the read side can import it without dragging in that use case's notify /
 * search / reindex module graph.
 */
export const IMAGE_MODERATION_REJECT_DELETION_SOURCE =
  "image-moderation-reject" as const;

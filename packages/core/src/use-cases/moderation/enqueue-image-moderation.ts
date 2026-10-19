import type { TxRepos } from "@th/ports/repos";
import type {
  ImageModerationKind,
  ImageModerationSubjectType,
} from "@th/ports/repos/image-moderation-records";

// ─────────────────────────────────────────────────────────────────────────────
// Shared enqueue helper — the SINGLE choke point every public-image finalize
// path routes through to register an object for moderation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The descriptive fields needed to enqueue a moderation record for an uploaded
 * object. `contentType` / `createdByHumanId` accept `null` (the shape the
 * `images` repo returns) and are coerced to `undefined` for the repo's optional
 * inputs.
 */
export type EnqueueImageModerationInput = {
  /** The R2 storage key — the join key for read-time gating and the drain. */
  storageKey: string;
  /** Which public surface the object serves. */
  kind: ImageModerationKind;
  /** Owning entity type, for the queue's deep link + gating joins. */
  subjectType?: ImageModerationSubjectType;
  /** Owning entity id. */
  subjectId?: string;
  /** Public URL for the moderator-queue preview. */
  publicUrl?: string;
  /** MIME type, for the provider call. */
  contentType?: string | null;
  /** Uploader, for hold/reject notifications. */
  createdByHumanId?: string | null;
};

/**
 * Enqueue a single object for asynchronous image moderation.
 *
 * Creates an `ImageModerationRecord` in status PENDING (hidden until the drain
 * worker runs the provider). Idempotent on `storageKey`: `create` upsert-RESETS
 * an existing record for the key back to PENDING.
 *
 * KEY INVARIANT (relied on across this subsystem): every image upload key embeds
 * a fresh uuid (event heroes: `events/{eventId}/images/{imageId}.{ext}`; avatars
 * / banners / page-media likewise use a per-upload uuid). A given `storageKey`
 * is therefore NEVER reused for different bytes. Consequences:
 *   - the upsert-reset in `create` only fires on an exact-key RE-finalize (an
 *     idempotent retry of the SAME upload), never on a genuine image
 *     replacement — replacement lands on a brand-new key with its own record;
 *   - `markResult`-by-storageKey can never stamp a stale verdict onto different
 *     bytes.
 * So no extra lease / versioning machinery is needed here.
 *
 * This is the one place Phases 2-3 (avatars/banners, page-block media) reuse to
 * register their uploads, so a new public upload path can't silently bypass
 * moderation.
 *
 * Callers pass the request/tx-scoped repo so the enqueue commits in the SAME
 * transaction as the underlying image mutation (the record can't be lost).
 */
export async function enqueueImageModeration(
  repos: Pick<TxRepos, "imageModerationRecords">,
  input: EnqueueImageModerationInput,
): Promise<void> {
  await repos.imageModerationRecords.create({
    storageKey: input.storageKey,
    kind: input.kind,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    publicUrl: input.publicUrl,
    // The repo's optional inputs are `string | undefined`; the `images` repo
    // returns `string | null` — coerce null → undefined.
    contentType: input.contentType ?? undefined,
    createdByHumanId: input.createdByHumanId ?? undefined,
  });
}

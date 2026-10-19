import { z } from "zod";
import type { Repos } from "@th/ports/repos";
import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type { AuthZPort } from "@th/ports/authz";
import type { EventRecord } from "@th/ports/repos/events";
import {
  isFileStorageError,
  type FileStoragePort,
} from "@th/ports/file-storage";
import { fail } from "../../lib/errors";
import { COMMUNITY_MODERATION_ROLES } from "../community/_shared/suggestion-validation";
import { collectReferencedAudioUploadIds } from "./_shared/event-audio-references";

/**
 * How long a freshly-minted source-audio URL stays valid.
 *
 * Source audio is stored PRIVATE (`request-event-audio-upload` uploads it with
 * `public: false`; only the transcoded HLS output is public), so its URL is a
 * presigned, EXPIRING credential. It must therefore be minted per read and
 * never persisted — see the note on `sourceUrl` below.
 *
 * Six hours: comfortably outlives the event page's 60s ISR window and a
 * long-open tab, while keeping a leaked URL from being a durable credential.
 */
const SOURCE_URL_TTL_SECONDS = 6 * 60 * 60;

// ─────────────────────────────────────────────────────────────────────────────
// Input Schema
// ─────────────────────────────────────────────────────────────────────────────

export const resolveEventAudioInputSchema = z
  .object({
    eventId: z.string().min(1),
    /**
     * The signed-in caller, or null for anonymous. Only consulted for events
     * that are NOT publicly readable — see the access note on the use case.
     */
    viewerHumanId: z.uuid().nullable().default(null),
  })
  .strict();

export type ResolveEventAudioInput = z.infer<
  typeof resolveEventAudioInputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Output Schema
// ─────────────────────────────────────────────────────────────────────────────

const audioUploadItemSchema = z.object({
  id: z.string(),
  status: z.string(),
  sourceContentType: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  hlsPlaylistUrl: z.string().nullable(),
  // The original uploaded file URL — included so non-Safari browsers (which
  // can't natively play HLS in <audio>) have a working fallback while the
  // HLS playlist plays everywhere else. Without this the public event page
  // shows audio that loads in editor (Safari/HLS-capable contexts) but
  // fails silently in Chrome/Firefox.
  //
  // MINTED PER READ, never read from the DB. The source object is private, so
  // this is a presigned URL with an expiry; `finalize-event-audio-upload` used
  // to sign one for 7 days and persist it to `audio_uploads.sourceUrl`, which
  // meant every event's audio 404'd exactly one week after upload. Null when
  // the object has no key yet (upload not finalized) or signing failed — the
  // HLS playlist still plays in that case.
  sourceUrl: z.string().nullable(),
  waveformPeaks: z.array(z.number()).nullable(),
  attached: z.boolean(),
  createdAt: z.date(),
});

export const resolveEventAudioOutputSchema = z.object({
  items: z.array(audioUploadItemSchema),
});

export type ResolveEventAudioOutput = z.infer<
  typeof resolveEventAudioOutputSchema
>;

// ─────────────────────────────────────────────────────────────────────────────
// Dependencies
// ─────────────────────────────────────────────────────────────────────────────

export type ResolveEventAudioDeps = {
  repos: Pick<Repos, "audioUploads" | "events">;
  /**
   * `hasStaffRole` is as load-bearing as `canEditEvent`: it is the ONLY arm
   * that resolves audio on an unpublished COMMUNITY listing, because an
   * ownerless row has neither an org nor a human owner for `canEditEvent` to
   * find. A composition root that wired a partial authz object would silently
   * take community moderators back to an empty player.
   */
  authz: Pick<AuthZPort, "canEditEvent" | "hasStaffRole">;
  fileStorage: Pick<FileStoragePort, "getObjectUrl">;
  logger: LoggerPort;
  /**
   * Signing is best-effort per item — one failure degrades that item to
   * HLS-only rather than failing the whole page — so the swallow needs a
   * report or a broken storage config would silently drop audio fallbacks
   * with nothing in Sentry.
   */
  reportError?: ReporterPort;
};

// ─────────────────────────────────────────────────────────────────────────────
// Use Case
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lists an event's audio uploads.
 *
 * ## What the PUBLIC gets
 *
 * Only uploads the event body still references. There is no "remove audio" use
 * case — taking a track off an event means deleting its `audioBlock` from the
 * body — so without this filter every take an organizer ever uploaded and then
 * removed stayed publicly listed, with a freshly minted URL on every request,
 * forever. Editors still get the full list: the builder needs uploads that are
 * not in the body yet to show transcode progress before they are inserted.
 *
 * NOTE for anyone tempted to use `AudioUpload.attached` here instead: nothing
 * sets it true, so it selects nothing. See `_shared/event-audio-references.ts`.
 *
 * ## Access
 *
 * This check covers UNPUBLISHED events only. The password/application gate for
 * PUBLISHED events lives at the transport (`ensureFullEventReadAccessByEventId`
 * in the `resolveAudio` procedure), because only the transport can see the
 * anonymous unlock cookie — that is where every other public event read
 * enforces it too. Do not read `status === "PUBLISHED"` here as "safe to serve
 * to anyone"; it means "the transport already decided".
 *
 * Anything else (DRAFT, unpublished, cancelled) requires edit permission —
 * see {@link viewerMayEditEvent} for what that means on an ownerless
 * COMMUNITY listing. Without that check this was an open oracle: the
 * procedure is public, so anyone holding an event id could mint a working
 * presigned URL for the PRIVATE source object of an unpublished event, on
 * demand and indefinitely. Returns an EMPTY list rather than throwing for a
 * caller who lacks permission, so the endpoint does not double as an
 * existence probe.
 */
export const resolveEventAudio = async (
  deps: ResolveEventAudioDeps,
  rawInput: unknown,
): Promise<ResolveEventAudioOutput> => {
  const { repos, fileStorage, logger } = deps;

  const parsed = resolveEventAudioInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      "invalid_input",
      parsed.error.issues[0]?.message ?? "invalid_input",
    );
  }

  const event = await repos.events.getById(parsed.data.eventId);

  // Anonymous callers are never editors, so they skip the authz round trip
  // altogether — every arm below costs them exactly one event read.
  const viewerHumanId = parsed.data.viewerHumanId;

  if (!event) {
    // A signed-in caller pays for a probe here too, even though there is
    // nothing to authorize. Both empty-handed outcomes — "no such event" and
    // "a DRAFT community listing you are not a moderator of" — must cost the
    // same number of round trips, or the latency difference is the oracle
    // that the identical `{ items: [] }` response was there to avoid. Same
    // discipline as `requestEventAudioUpload` / `requestEventImageUpload`.
    if (viewerHumanId) await probeCommunityModerator(deps, viewerHumanId);
    return { items: [] };
  }

  const viewerCanEdit = viewerHumanId
    ? await viewerMayEditEvent(deps, event, viewerHumanId)
    : false;

  if (event.status !== "PUBLISHED" && !viewerCanEdit) {
    logger.info("events.audio.access_denied", {
      eventId: parsed.data.eventId,
      status: event.status,
      anonymous: viewerHumanId === null,
    });
    return { items: [] };
  }

  const uploads = await repos.audioUploads.listByEventId(parsed.data.eventId);

  // Filter out soft-deleted uploads
  const activeAll = uploads.filter((u) => !u.deletedAt);

  // Editors see everything (transcode progress for not-yet-inserted uploads).
  // Everyone else sees only what the page actually references.
  let active = activeAll;
  if (!viewerCanEdit) {
    const body = await repos.events.getContent({
      eventId: parsed.data.eventId,
    });
    const referenced = collectReferencedAudioUploadIds(body);
    active = activeAll.filter((u) => referenced.has(u.id));
    if (active.length !== activeAll.length) {
      logger.info("events.audio.unreferenced_withheld", {
        eventId: parsed.data.eventId,
        withheld: activeAll.length - active.length,
      });
    }
  }

  // Mint a fresh presigned URL per source object.
  //
  // COST: `getObjectUrl` HEADs the object before signing (it contracts to
  // throw `not_found` for a missing key), so this is a network round-trip per
  // item, not just an HMAC. That is acceptable here and arguably desirable:
  // the count is bounded by audio uploads on ONE event, they run in parallel,
  // the public event page is ISR-cached (`revalidate = 60`) so at most one
  // render per minute per event reaches this, and the HEAD means an object
  // that has gone missing degrades to `null` instead of handing the browser a
  // URL that 404s. Do not "optimise" this into a blind signature without
  // re-checking that trade.
  const sourceUrls = await Promise.all(
    active.map(async (u) => {
      if (!u.sourceKey) return null;
      try {
        const { url } = await fileStorage.getObjectUrl({
          key: u.sourceKey,
          options: { expiresSec: SOURCE_URL_TTL_SECONDS },
        });
        return url;
      } catch (err) {
        // Degrade this ONE item to HLS-only rather than failing the page.
        //
        // A MISSING object is a known, terminal state (the blob was swept or
        // never landed) — not an incident. Reporting it would re-fire on every
        // render for the life of the row, which is how a Sentry project stops
        // being read. Log it and move on; anything else is a real failure.
        if (isFileStorageError(err) && err.code === "not_found") {
          logger.warn("events.audio.source_object_missing", {
            audioUploadId: u.id,
            key: u.sourceKey,
          });
          return null;
        }

        logger.error("events.audio.source_url_sign_failed", {
          err,
          audioUploadId: u.id,
          key: u.sourceKey,
        });
        deps.reportError?.(err, {
          tags: { useCase: "resolveEventAudio" },
          extra: {
            audioUploadId: u.id,
            effect: "source audio fallback unavailable; HLS only",
          },
        });
        return null;
      }
    }),
  );

  logger.info("Resolved event audio uploads", {
    eventId: parsed.data.eventId,
    count: active.length,
  });

  return {
    items: active.map((u, i) => ({
      id: u.id,
      status: u.status,
      sourceContentType: u.sourceContentType,
      durationSeconds: u.durationSeconds,
      hlsPlaylistUrl: u.hlsPlaylistUrl,
      // Index-aligned with `active` by construction (same array, same order).
      sourceUrl: sourceUrls[i] ?? null,
      waveformPeaks: u.waveformPeaks ?? null,
      attached: u.attached,
      createdAt: u.createdAt,
    })),
  };
};

/**
 * "May this viewer see an unpublished event's audio, and the uploads the body
 * does not reference yet?" — i.e. is the viewer an EDITOR of this event.
 *
 * Two arms, selected by stewardship, and exactly ONE authz round trip either
 * way. That last part is deliberate: the number of probes a signed-in caller
 * costs must not depend on whether the id they hold is a COMMUNITY row or an
 * OWNED one.
 *
 * COMMUNITY listings are ownerless, so `canEditEvent` — which resolves an
 * event's org, then its human owner, then falls through to false — answers
 * false for every one of them at every status. That is the whole reason body
 * audio did not work on a community draft: `requestAudioUpload` and
 * `finalizeAudioUpload` both grew a COMMUNITY branch, so a moderator could
 * upload a track, but nothing could ever read it back and the builder had to
 * hide the button rather than ship one that swallowed files.
 *
 * The gate is the same one `getEventForEdit` (which hydrates this same
 * builder), `community.createListing` / `publishListing` / `updateListing`
 * and `requestEventAudioUpload` use — COMMUNITY_MODERATION_ROLES, imported
 * rather than re-listed so they can never drift apart.
 *
 * Do NOT push this branch down into `canEditEvent`: that adapter fronts a
 * dozen owned-event WRITE surfaces (settings, access gates, payout terms)
 * that an ownerless RSVP listing has no business carrying. Same call
 * `getEventForEdit` made, for the same reason.
 *
 * Non-moderators are unaffected: they get `false`, which means the caller
 * returns an empty list — the same response, and the same shape, as for an
 * event that does not exist. This is a probe, not a guard; it throws nothing
 * and so opens no existence oracle.
 */
async function viewerMayEditEvent(
  deps: ResolveEventAudioDeps,
  event: EventRecord,
  viewerHumanId: string,
): Promise<boolean> {
  if (event.stewardship === "COMMUNITY") {
    const staff = await probeCommunityModerator(deps, viewerHumanId);
    return staff.allowed;
  }

  const canEdit = await deps.authz.canEditEvent({
    actorHumanId: viewerHumanId,
    eventId: event.id,
  });
  return canEdit.allowed;
}

/**
 * The community-moderator probe, extracted so the "event does not exist" path
 * can spend the same round trip the "DRAFT community listing" path does. Its
 * RESULT is ignored on the miss path on purpose — it is there for its cost.
 */
function probeCommunityModerator(
  deps: ResolveEventAudioDeps,
  viewerHumanId: string,
) {
  return deps.authz.hasStaffRole({
    actorHumanId: viewerHumanId,
    requiredRoles: [...COMMUNITY_MODERATION_ROLES],
  });
}

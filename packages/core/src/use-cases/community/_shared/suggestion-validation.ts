import type { ContentFilterPort } from "@th/ports/content-filter";
import type { EventBody } from "@th/schema";
import type {
  CommunityEditableFieldValues,
  EventRecord,
} from "@th/ports/repos/events";
import type { ImageRecord, ImagesRepo } from "@th/ports/repos/images";
import { fail } from "@th/errors";

import { SUGGESTION_EDITABLE_FIELDS } from "../../events/_shared/suggestion-fields";
import { extractPlainText } from "../../events/_shared/event-body-sanitizer";
import { suggestionRejection } from "./suggestion-rejection";

/**
 * Shared validation helpers for the community edit-suggestion pipeline
 * (docs/specs/2026-07-01/completed/community-managed-event-listings.spec.yaml
 * FR-006..FR-009). Every helper here is used at BOTH submit and apply time —
 * the stored suggestion Json is never trusted (FR-006: "strictly validated at
 * submit time AND re-validated + re-sanitized at apply time").
 */

/**
 * Staff roles allowed to act on the COMMUNITY side of the suggestion flow:
 * verified community moderators, plus platform ADMIN (the platform-admin
 * override precedent — admins can always operate the moderation surface).
 */
export const COMMUNITY_MODERATION_ROLES = ["COMMUNITY_MODERATOR", "ADMIN"] as const;

/**
 * Events accept suggestions / RSVPs only while PUBLISHED and PUBLIC (FR-006).
 * Anything else is reported as EVENT_NOT_FOUND so the anonymous submit
 * endpoint cannot be used to probe for private or draft events (mirrors how
 * gated reads collapse to a 404 rather than leaking existence details).
 */
export function ensurePublicPublishedEvent(event: EventRecord | null): EventRecord {
  if (!event || event.status !== "PUBLISHED" || event.visibility !== "PUBLIC") {
    throw fail("EVENT_NOT_FOUND");
  }
  return event;
}

/**
 * Edit suggestions are COMMUNITY-only (product decision 2026-07-20, reversing
 * FR-006's original "any PUBLISHED PUBLIC event" scope: open suggestions on
 * OWNED events invite trolling). On top of {@link ensurePublicPublishedEvent},
 * an event only accepts suggestions while `stewardship === "COMMUNITY"`.
 * OWNED events collapse to the same EVENT_NOT_FOUND as drafts/private events —
 * the anonymous suggestion surface stays a non-oracle (no stewardship probing).
 *
 * Only the suggestion pipeline uses this; flows that must stay
 * stewardship-agnostic (e.g. RSVP-style public reads) keep calling
 * {@link ensurePublicPublishedEvent} directly.
 */
export function ensureCommunitySuggestibleEvent(
  event: EventRecord | null,
): EventRecord {
  const publicEvent = ensurePublicPublishedEvent(event);
  if (publicEvent.stewardship !== "COMMUNITY") {
    throw fail("EVENT_NOT_FOUND");
  }
  return publicEvent;
}

/**
 * Cross-field schedule check (FR-007): when a diff proposes only ONE of
 * {startsAt, endsAt}, the schema alone cannot enforce ordering — the proposed
 * value must be checked against the event's EFFECTIVE other bound
 * (proposed value if present, else the current event value). Both directions
 * are invalid: a lone endsAt before the effective start, and a lone startsAt
 * moved after the effective end.
 */
export function ensureProposedScheduleValid(params: {
  proposed: Pick<CommunityEditableFieldValues, "startsAt" | "endsAt">;
  event: Pick<EventRecord, "startsAt" | "endsAt">;
}): void {
  const { proposed, event } = params;
  if (proposed.startsAt === undefined && proposed.endsAt === undefined) {
    return;
  }

  const effectiveStart = proposed.startsAt ?? event.startsAt;
  const effectiveEnd = proposed.endsAt ?? event.endsAt;
  if (effectiveEnd != null && effectiveEnd.getTime() <= effectiveStart.getTime()) {
    throw suggestionRejection(
      "ends_before_starts",
      ["startsAt", "endsAt"].filter(
        (field) => proposed[field as "startsAt" | "endsAt"] !== undefined,
      ),
    );
  }
}

/**
 * heroImageId reference rules (FR-007 / FR-015):
 *  - must reference an Image row that belongs to THIS event (`eventId` FK)
 *    and is not soft-deleted;
 *  - must be FINALIZED (`uploadedAt` set): a requested-but-never-uploaded row
 *    has an empty `publicUrl` (request-event-image-upload creates it pending),
 *    so attaching it as hero would render broken AND exempt it from the
 *    detached-image sweep;
 *  - an ALREADY-ATTACHED image may be referenced by anyone (incl. anonymous);
 *  - an UNATTACHED image may only be referenced by the signed-in submitter
 *    who uploaded it (suggestion-borne upload awaiting approval). Anonymous
 *    submitters can therefore never reference unattached uploads.
 *
 * The rule is event-kind-agnostic: FR-015's upload authz means NEW uploads
 * only exist on COMMUNITY listings in practice, but enforcing
 * attached-or-own-upload here is sufficient (and correct) for OWNED events
 * too.
 */
export async function ensureHeroImageReferenceValid(params: {
  images: Pick<ImagesRepo, "getById">;
  eventId: string;
  heroImageId: string;
  submitterHumanId: string | null;
}): Promise<ImageRecord> {
  const image = await params.images.getById(params.heroImageId);
  if (!image || image.deletedAt || image.eventId !== params.eventId) {
    throw suggestionRejection("not_an_event_image", ["heroImageId"]);
  }

  // Runs at BOTH submit and apply, so this one check closes both paths.
  if (!image.uploadedAt) {
    throw suggestionRejection("upload_not_finalized", ["heroImageId"]);
  }

  if (image.attached) {
    return image;
  }

  if (
    params.submitterHumanId &&
    image.createdByHumanId === params.submitterHumanId
  ) {
    return image;
  }

  throw suggestionRejection("unattached_not_own_upload", ["heroImageId"]);
}

/**
 * Run the PROSE pieces of a suggestion through ContentFilterPort (NFR-001;
 * reuses the category-request content checks): the free-text note, the
 * proposed title, and the plain text extracted from the proposed body
 * (richText text nodes, embed titles, cta labels/hrefs, image alt).
 *
 * The GEOGRAPHIC fields — `addressText`, `region`, `locality` — are
 * deliberately NOT filtered. Place names are not authored prose: they are
 * given, and a profanity matcher has no way to tell a slur from a street. The
 * false-positive rate is real and measured (this rejected 3 of 18 genuine
 * Nashville open-mic listings — "1200 Dickerson Pike" among them), while the
 * abuse upside is near zero: an address is short, structured, shown next to a
 * map, and already gated by the moderation queue these suggestions land in.
 * Prose is where abuse actually goes, so prose is what we filter.
 *
 * Both the submit path and the apply path call THIS function, so the two stay
 * in agreement by construction (FR-006 requires submit-time and apply-time
 * validation to agree — do not inline a divergent field list at either call
 * site).
 *
 * Blocked content rejects with `blocked_content` AND attributes the offending
 * field: each named piece is checked in turn and the FIRST hit throws with that
 * field (`content` body text maps to the `content` field; the reviewers' `note`
 * — which has its own "Note to reviewers" input on the propose surface — maps to
 * `note`). This lets
 * the client anchor the message inline at the input the user must fix instead
 * of a misleading "some text was blocked" form-level banner. When the filter
 * can report the matched term (optional {@link ContentFilterPort.findBlocked}),
 * it is surfaced in `meta.term` for telemetry — the web deliberately does not
 * echo it back to the user.
 */
export async function ensureSuggestionTextAllowed(params: {
  contentFilter: ContentFilterPort;
  title?: string | undefined;
  note?: string | null | undefined;
  /** NORMALIZED body (the return value of sanitizeEventBody), or null. */
  content?: EventBody | null | undefined;
}): Promise<void> {
  const named: Array<{ field: string; text: string | null | undefined }> = [
    { field: "title", text: params.title },
    { field: "note", text: params.note },
  ];
  if (params.content) {
    const plainText = extractPlainText(params.content);
    if (plainText) named.push({ field: "content", text: plainText });
  }

  for (const { field, text } of named) {
    if (!text) continue;
    const result = await checkBlocked(params.contentFilter, text);
    if (result.blocked) {
      throw suggestionRejection(
        "blocked_content",
        [field],
        result.term ? { term: result.term } : undefined,
      );
    }
  }
}

/**
 * Prefer the richer {@link ContentFilterPort.findBlocked} (reports the matched
 * term) when the adapter implements it; fall back to the boolean
 * `hasBlockedContent` otherwise (older adapters / test fakes). Exported for
 * `createCommunityPlace`, which filters a place name the same way.
 */
export async function checkBlocked(
  contentFilter: ContentFilterPort,
  text: string,
): Promise<{ blocked: boolean; term?: string }> {
  if (contentFilter.findBlocked) {
    const result = await contentFilter.findBlocked({ text });
    return {
      blocked: result.blocked,
      ...(result.matches?.[0] ? { term: result.matches[0] } : {}),
    };
  }
  return { blocked: await contentFilter.hasBlockedContent({ text }) };
}

/**
 * Serialize a parsed whitelisted diff for Json persistence: Dates become ISO
 * strings so the stored `fields` / `appliedFields` round-trip
 * deterministically (matching `snapshotSuggestionBase`, which stores ISO
 * strings). Everything else is stored as-is.
 */
export function serializeSuggestionFields(
  fields: CommunityEditableFieldValues,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SUGGESTION_EDITABLE_FIELDS) {
    const value = fields[key];
    if (value === undefined) continue;
    out[key] = value instanceof Date ? value.toISOString() : value;
  }
  return out;
}

/**
 * Resolve the event's CURRENT hero image ID. `EventRecord` only exposes
 * `heroImageUrl` (mapped from the Prisma `heroImage` relation's publicUrl) —
 * there is no repo accessor for the raw `heroImageId` column — so we invert
 * the mapping through the event's image rows. `publicUrl` is derived from the
 * per-image storage key, so a URL match uniquely identifies the row.
 * Used by both the base-version snapshot (submit) and the current-state
 * snapshot (apply) — both sides resolve identically, so conflict detection
 * stays consistent even in the theoretical empty-URL edge.
 */
export async function resolveCurrentHeroImageId(
  images: Pick<ImagesRepo, "listByEventId">,
  event: Pick<EventRecord, "id" | "heroImageUrl">,
): Promise<string | null> {
  const heroUrl = event.heroImageUrl ?? null;
  if (!heroUrl) return null;

  const rows = await images.listByEventId(event.id);
  const match = rows.find(
    (image) => !image.deletedAt && image.publicUrl === heroUrl,
  );
  return match?.id ?? null;
}

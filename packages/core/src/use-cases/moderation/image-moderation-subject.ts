import type { LoggerPort } from "@th/ports/logger";
import type { Repos } from "@th/ports/repos";
import type { ImageModerationRecord } from "@th/ports/repos/image-moderation-records";
import type { ReporterPort } from "@th/ports/reporter";

import { linkablePageSlug } from "../../lib/entity-page-visibility";
import { describeError } from "../../lib/io";
import {
  eventPublicUrl,
  normalizeAppBaseUrl,
  eventSlugPath,
} from "../../lib/public-urls";

// Re-exported so existing importers keep working: there is exactly ONE
// implementation of these, in `lib/public-urls`.
export { eventPublicUrl, normalizeAppBaseUrl, eventSlugPath };

/**
 * Upper bound on the event title carried in a moderation notice payload.
 *
 * Same posture as the event titles in the comms renderers: input caps titles at
 * 140 chars and the renderer schemas allow 200 as deliberate slack, so a
 * hostile/legacy oversized value can't bloat the notification or the email.
 * Truncation happens HERE (at construction) rather than being left to the
 * schema, because these notices are best-effort: a schema rejection would sink
 * the whole notice over an enrichment field. Cutting is code-point aware, so an
 * astral char (emoji) straddling the boundary can never leave a lone surrogate
 * in the payload.
 */
export const IMAGE_MODERATION_SUBJECT_TITLE_MAX_LENGTH = 200;

/**
 * The "which image, on what?" enrichment carried by every uploader-facing image
 * moderation notice. Both fields are independently nullable:
 *   - no `appBaseUrl` (or no event slug) → title without a link;
 *   - lookup failure / deleted subject / a HUMAN or ORGANIZATION subject →
 *     both null, and the notice still goes out with today's generic copy.
 */
export type ImageModerationSubjectContext = {
  /** Event title or place name, bounded — or null when unknown. */
  subjectTitle: string | null;
  /**
   * Absolute public URL: `{appBaseUrl}/events/{slug}` for an EVENT, the
   * place's page `{appBaseUrl}/p/{slug}` for a PLACE — or null.
   */
  subjectUrl: string | null;
};

const NO_SUBJECT: ImageModerationSubjectContext = {
  subjectTitle: null,
  subjectUrl: null,
};

function boundTitle(title: string): string | null {
  const trimmed = title.trim();
  if (!trimmed) return null;
  if (trimmed.length <= IMAGE_MODERATION_SUBJECT_TITLE_MAX_LENGTH) {
    return trimmed;
  }
  const budget = IMAGE_MODERATION_SUBJECT_TITLE_MAX_LENGTH - 1; // reserve the ellipsis
  let truncated = "";
  for (const codePoint of trimmed) {
    if (truncated.length + codePoint.length > budget) break;
    truncated += codePoint;
  }
  return `${truncated.trimEnd()}…`;
}

/**
 * Resolves the event a moderated image belongs to, so the uploader notice can
 * say WHICH image it is about and link to it.
 *
 * BEST-EFFORT BY CONTRACT: any failure (repo throws, event deleted, event has
 * no slug yet) degrades to `{ subjectTitle: null, subjectUrl: null }` and the
 * caller still sends the notice. The swallow is Sentry-visible per the CLAUDE.md
 * error convention — `logger.error` plus a guarded `reportError`, so a throwing
 * reporter can never change behaviour.
 *
 * EVENT and PLACE subjects are looked up. PLACE subjects are a community
 * moderator's page images on an unowned place (finalize-page-image-upload,
 * moderator place page spec R5): the place's name, linked to its page when
 * the page is linkable. A PLACE lookup needs `places` + `entityPages`; a
 * caller without them gets nulls with no repo call. HUMAN / ORGANIZATION
 * subjects are not produced today; they get nulls rather than a guessed
 * route.
 *
 * The URL is built from the event's SLUG, never its id: the public
 * `/events/[...slug]` route resolves through `events.resolveBySlug`, which
 * matches the current slug or slug history only — an id-based link 404s.
 */
export async function resolveImageModerationSubject(args: {
  record: Pick<ImageModerationRecord, "id" | "subjectType" | "subjectId">;
  repos: Pick<Repos, "events"> &
    Partial<Pick<Repos, "places" | "entityPages">>;
  /** Public web origin. Absent → title only, no link. */
  appBaseUrl?: string | null;
  logger: LoggerPort;
  reportError?: ReporterPort;
}): Promise<ImageModerationSubjectContext> {
  const { record, repos, logger, reportError } = args;

  if (!record.subjectId) return NO_SUBJECT;
  const subjectId = record.subjectId;
  const places = repos.places;
  const entityPages = repos.entityPages;
  const placeLookup =
    record.subjectType === "PLACE" && places && entityPages
      ? { places, entityPages }
      : null;
  if (record.subjectType !== "EVENT" && !placeLookup) {
    return NO_SUBJECT;
  }

  try {
    if (placeLookup) {
      const place = await placeLookup.places.getById(subjectId);
      if (!place) return NO_SUBJECT;
      const page = await placeLookup.entityPages.getByOwner("PLACE", subjectId);
      const slug = linkablePageSlug(page);
      const base = normalizeAppBaseUrl(args.appBaseUrl);
      return {
        subjectTitle: boundTitle(place.name),
        subjectUrl:
          base && slug ? `${base}/p/${encodeURIComponent(slug)}` : null,
      };
    }

    const event = await repos.events.getById(subjectId);
    if (!event) return NO_SUBJECT;

    return {
      subjectTitle: boundTitle(event.title),
      // Slug-only, status-agnostic — see `eventPublicUrl`. (An earlier revision
      // also required PUBLISHED; that was over-strict: the event route has no
      // status gate and non-published events render with a status banner.)
      subjectUrl: eventPublicUrl({
        baseUrl: args.appBaseUrl,
        slug: event.slug,
      }),
    };
  } catch (error) {
    // Never let an enrichment lookup sink the notice — but never let the
    // swallow go dark either (CLAUDE.md: logger.warn is NOT Sentry-captured).
    logger.error("moderation.subjectLookupFailed", {
      recordId: record.id,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      error: describeError(error),
    });
    try {
      reportError?.(error, {
        tags: { area: "image-moderation", reason: "subject-lookup-failed" },
        extra: { recordId: record.id, subjectId: record.subjectId },
      });
    } catch {
      // best-effort only
    }
    return NO_SUBJECT;
  }
}

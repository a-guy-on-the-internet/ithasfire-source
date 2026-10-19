import {
  eventPublicPath,
  eventShortPath,
} from "@th/core/lib/event-public-paths";

/**
 * The builder's ONE answer to "does this event's link work for a stranger?"
 *
 * Every builder surface that hands out a link asks this: the Public link field
 * at the top of the page, the `⋯` menu's Copy link, and the Settings → Sharing
 * group's short link and collapsed summary. They used to decide separately, and
 * the Sharing group printed `/e/<shortId>` for a DRAFT (drafts get a slug AND a
 * short ID at creation, `assign-slug-on-create.ts`) — a link the `/e/` route
 * 404s, handed to the organiser as if it worked.
 *
 * The rule mirrors `isEventPubliclyReadable`
 * (`use-cases/events/_shared/event-public-readability.ts`), the function
 * `/events/<slug>` and `/e/<shortId>` apply to an anonymous reader. That
 * module pulls `@th/errors` and the authz helpers, which must not ride into
 * a client bundle, so the rule is restated here and a test pins the two
 * together across every status.
 */
export type EventLinkState = {
  status: "DRAFT" | "PUBLISHED" | "CANCELLED" | "COMPLETED" | "ARCHIVED";
  publishedAt: Date | string | null | undefined;
};

export function isEventLinkPublic(state: EventLinkState): boolean {
  if (state.status === "PUBLISHED" || state.status === "COMPLETED") return true;
  if (state.status === "DRAFT") return false;
  return (state.publishedAt ?? null) !== null;
}

export type EventLinkInput = EventLinkState & {
  slug: string | null | undefined;
  shortId: string | null | undefined;
};

export type EventPublicLink = {
  /**
   * What to hand out: the short link when the event has a short ID, else the
   * canonical page. Root-relative — prefix the origin at the moment of use.
   */
  sharePath: string;
  /** The canonical page (`/events/<slug…>`); what "View event" opens. */
  canonicalPath: string;
};

/**
 * The event's shareable link, or null when there is none a stranger could
 * open. A slug is required even for the short link: `/e/<shortId>` redirects
 * TO the slug page, and the resolver refuses an event without one.
 */
export function eventPublicLink(input: EventLinkInput): EventPublicLink | null {
  if (!isEventLinkPublic(input)) return null;
  const canonicalPath = eventPublicPath(input.slug);
  if (!canonicalPath) return null;
  return {
    sharePath: eventShortPath(input.shortId) ?? canonicalPath,
    canonicalPath,
  };
}

/**
 * The Settings → Sharing group's collapsed summary: the short link while it
 * works, otherwise the long path it showed before short IDs existed.
 */
export function eventSharingSummary(input: EventLinkInput): string | undefined {
  return (
    eventPublicLink(input)?.sharePath ?? eventPublicPath(input.slug) ?? undefined
  );
}

/**
 * Helpers for the /platform/reports queue (entity-report-intake spec FR-007,
 * relocated to platform trust & safety in spec v1.1).
 * Kept in a plain module (no React) so the label mapping, link building, age
 * formatting, and conflict detection are unit-testable without rendering the
 * queue — same split as `image-moderation.helpers.ts` next door.
 */

import { safeHref } from "@/lib/escape-html";

/** Mirrors `EntityReportSubjectType` from the entityReports router DTO. */
export type ReportSubjectType =
  | "PLACE"
  | "HUMAN"
  | "ORGANIZATION"
  | "ARRIVAL_AREA";

/** An ARRIVAL_AREA report's kind (`subjectKind` on the DTO). */
export type ReportArrivalAreaKind = "PARKING" | "ACCESSIBLE_DROP_OFF" | "LOAD_IN";

/** Which page an ARRIVAL_AREA report links to (`subjectParentType`). */
export type ReportSubjectParentType = "PLACE" | "EVENT";

/** Mirrors `EntityReportReason` from the entityReports router DTO. */
export type ReportReason =
  | "CLOSED_OR_GONE"
  | "INCORRECT_INFO"
  | "DUPLICATE"
  | "INAPPROPRIATE"
  | "SPAM"
  | "IMPERSONATION"
  | "OTHER";

/** i18n key for a report-reason label (moderation.reportsReason*). */
export function reasonLabelKey(reason: ReportReason): string {
  switch (reason) {
    case "CLOSED_OR_GONE":
      return "moderation.reportsReasonClosedOrGone";
    case "INCORRECT_INFO":
      return "moderation.reportsReasonIncorrectInfo";
    case "DUPLICATE":
      return "moderation.reportsReasonDuplicate";
    case "INAPPROPRIATE":
      return "moderation.reportsReasonInappropriate";
    case "SPAM":
      return "moderation.reportsReasonSpam";
    case "IMPERSONATION":
      return "moderation.reportsReasonImpersonation";
    case "OTHER":
      return "moderation.reportsReasonOther";
  }
}

/**
 * i18n key for a subject-type label (moderation.reportsSubject*). An
 * ARRIVAL_AREA reads as its kind ("Parking", "Accessible drop-off",
 * "Load-in") when the report carries one.
 */
export function subjectTypeLabelKey(
  subjectType: ReportSubjectType,
  kind?: ReportArrivalAreaKind | null,
): string {
  switch (subjectType) {
    case "PLACE":
      return "moderation.reportsSubjectPlace";
    case "HUMAN":
      return "moderation.reportsSubjectHuman";
    case "ORGANIZATION":
      return "moderation.reportsSubjectOrganization";
    case "ARRIVAL_AREA":
      switch (kind) {
        case "PARKING":
          return "moderation.reportsSubjectArrivalAreaParking";
        case "ACCESSIBLE_DROP_OFF":
          return "moderation.reportsSubjectArrivalAreaDropOff";
        case "LOAD_IN":
          return "moderation.reportsSubjectArrivalAreaLoadIn";
        default:
          return "moderation.reportsSubjectArrivalArea";
      }
  }
}

/**
 * Public-page route base per subject type. All three typed routes resolve the
 * hydrated `subjectSlug` (an entity-page slug) via `loadEntityPageBySlug` —
 * the same loader as /p/[slug] — and a type-mismatched slug server-redirects
 * to /p/[slug], so these links are safe even if a slug's entity type ever
 * drifts. Conventions verified against existing link builders:
 * `/places/${placeSlug}` (EventContent), `/humans/${mySlug}` (ProfileSection),
 * `/orgs/${organizerSlug}` (server/events).
 */
const SUBJECT_ROUTE_BASE: Record<Exclude<ReportSubjectType, "ARRIVAL_AREA">, string> = {
  PLACE: "/places",
  HUMAN: "/humans",
  ORGANIZATION: "/orgs",
};

/**
 * An ARRIVAL_AREA has no page of its own: it links the page it was reported
 * from, its place's (`/places/<entity-page slug>`) or the event's
 * (`/events/<event slug>`), per `subjectParentType`.
 */
const AREA_PARENT_ROUTE_BASE: Record<ReportSubjectParentType, string> = {
  PLACE: "/places",
  EVENT: "/events",
};

/**
 * Best-effort deep link to a reported subject's public page. Null when the
 * subject slug is unresolvable (row gone / degraded hydration / no page) —
 * the caller falls back to the unlinked type + id chip. Runs through the
 * house `safeHref` sanitizer so a hostile-shaped slug can never become a
 * `javascript:`/protocol-relative href.
 */
export function subjectHref(
  subjectType: ReportSubjectType,
  subjectSlug: string | null,
  parentType?: ReportSubjectParentType | null,
): string | null {
  if (!subjectSlug) return null;
  let base: string;
  if (subjectType === "ARRIVAL_AREA") {
    if (!parentType) return null;
    base = AREA_PARENT_ROUTE_BASE[parentType];
  } else {
    base = SUBJECT_ROUTE_BASE[subjectType];
  }
  const href = safeHref(`${base}/${subjectSlug}`);
  return href === "#" ? null : href;
}

/**
 * Locale-aware relative age ("5 minutes ago" / "hace 5 minutos") via
 * `Intl.RelativeTimeFormat`.
 *
 * Why not reuse the house `relativeTime` in
 * `app/platform/places/_components/VerificationReviewDetail.tsx`? That util is
 * English-hardcoded ("just now", "5m ago") on an en-only platform surface —
 * this queue is fully i18n'd (en + es catalogs), so hand-copying it here would
 * ship untranslated strings. `numeric: "auto"` yields "yesterday"/"ayer"-style
 * phrasing where the locale has it.
 */
export function formatRelativeAge(
  from: Date,
  now: Date,
  locale: string,
): string {
  // `Math.round` rounds half-values toward +Infinity, so it is NOT symmetric
  // around zero: round(-1.5) === -1, which would report "90 minutes ago" as
  // "1 hour ago" while "in 90 minutes" correctly becomes "in 2 hours". Round
  // half away from zero so past and future ages bucket identically.
  const round = (n: number) => Math.sign(n) * Math.round(Math.abs(n));
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const minutes = round((from.getTime() - now.getTime()) / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = round(minutes / 60);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = round(hours / 24);
  if (Math.abs(days) < 30) return rtf.format(days, "day");
  const months = round(days / 30);
  if (Math.abs(months) < 12) return rtf.format(months, "month");
  return rtf.format(round(months / 12), "year");
}

/**
 * Whether a tRPC mutation error is the review CAS losing a concurrent-review
 * race. `reviewEntityReport` throws `fail("CONFLICT", { message:
 * "report_already_reviewed" })` — the domain discriminator travels as the
 * error `message` (the structured `data.appCode` only carries the generic
 * `CONFLICT`), so the message is the reliable check.
 */
export function isReportAlreadyReviewedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { message?: unknown }).message === "report_already_reviewed"
  );
}

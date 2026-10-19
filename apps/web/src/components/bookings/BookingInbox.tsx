"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { XStack, YStack, styled } from "tamagui";
import {
  Button,
  DataTable,
  NextLinkAnchor,
  Spinner,
  StyledSelect,
  Text,
  TextInput,
  useFormatters,
  useNotify,
  useTranslations,
  type DataTableColumn,
} from "@th/ui";
import { ExternalLink, Inbox, Mail, MailCheck, Phone, Users } from "lucide-react";
import {
  getBookingRequestSender,
  isUnclaimedBookingInquiry,
  type BookingRequestSender,
} from "@th/types";

import { trpc } from "@/trpc";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import { fmtCurrency } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  BOOKING_FEE_TYPE_LABEL_KEYS,
  OPEN_BOOKING_STATUSES,
  formatSetLength,
  isoDateToLocal,
  type BookingFeeType,
  type BookingRequestStatus,
} from "@/lib/booking-requests";
import { OpenAgreementButton } from "@/app/admin/[slug]/bookings/_components/OpenAgreementButton";
import { adminAgreementHref } from "@/lib/agreement-routes";
import { StatusSegments } from "@/app/admin/[slug]/bookings/_components/StatusSegments";
import { BookingAcceptanceToggle } from "@/app/admin/[slug]/places/[placeId]/bookings/_components/BookingAcceptanceToggle";
import { CommunityListingAcceptanceToggle } from "@/app/admin/[slug]/places/[placeId]/bookings/_components/CommunityListingAcceptanceToggle";
import { BookingEmbedSection } from "@/app/admin/[slug]/places/[placeId]/bookings/_components/BookingEmbedSection";

import { AssigneePicker } from "./AssigneePicker";
import { BookingHoldSummary } from "./BookingHoldSummary";
import {
  BookingHoldsStrip,
  type BookingHoldConfirmOutcome,
} from "./BookingHoldsStrip";
import { BookingStageRail } from "./BookingStageRail";
import { BookingTagChip } from "./BookingTagChip";
import { BookingTagInput } from "./BookingTagInput";
import { BookingThread } from "./BookingThread";
import { VenueConfirmationActions } from "./VenueConfirmationActions";
import { isProvenEventFirstRow } from "./request-origin";
import { liveHolds, type BookingHoldSummary as HoldSummary } from "./booking-holds";
import { useOrgMembers } from "./useOrgMembers";
import {
  CreateEventFromBookingAction,
  type CreateEventFromBookingResult,
} from "./CreateEventFromBookingAction";
import { UnreadMessagesBadge } from "./UnreadMessagesBadge";
import {
  BookingInquirerUndeliverableBadge,
  BookingInquirerUndeliverableNotice,
} from "./BookingInquirerUndeliverable";
import { BookingInquirerEmailRelayNote } from "./BookingInquirerEmailRelayNote";
import {
  BookingCalendarFilterBar,
  type BookingFilterVenue,
} from "./BookingCalendarFilterBar";
import {
  BOOKING_INBOX_TABS,
  bookingInboxTabOf,
  countBookingInboxTabs,
  defaultBookingInboxTab,
  rowsForBookingInboxTab,
  type BookingInboxTab,
} from "./booking-inbox-tabs";
import {
  BOOKING_INBOX_REQUEST_PARAM,
  findBookingInboxRowElement,
  resolveBookingInboxDeepLink,
} from "./booking-inbox-deep-link";

// ─────────────────────────────────────────────────────────────────────────────
// THE venue-side booking inbox — one component, three scopes.
//
// This used to be two near-identical 1500–2000 line files: the place-level
// inbox (`places/[placeId]/bookings`) and the org-level cross-venue inbox
// (`OrgVenueRequestsInbox`, the "To your venues" panel). Same rows, same
// expanded detail, same thread, same accept/decline — diverging only in which
// columns showed, which empty state fired and which settings sat around the
// list. The owner's ask, verbatim: "The Booking requests on the admin page and
// booking table on the place needs to be the same."
//
// SCOPE decides the DATA and the CHROME around the list, nothing else:
//   - `place`        — `list({ scope: "venue", placeId })`. Renders the page
//                      header, the "Accept booking requests" switch and the
//                      website-embed section: those are PLACE SETTINGS and
//                      have no meaning across venues. No venue column.
//   - `org-venues`   — `list({ scope: "org-venues", orgId })`. Every venue the
//                      org owns in one list; a Venue column and the venue
//                      filter, because a cross-venue row that cannot say
//                      which venue it belongs to is not a cross-venue row.
//   - `human-venues` — `list({ scope: "human-venues" })`. The PERSONAL admin:
//                      every venue the actor owns directly PLUS every venue
//                      their orgs own — a hub across everything waiting on
//                      them, narrowed by the venue filter. Same chrome as
//                      `org-venues`.
//
// The rows, the detail panel, the conversation and the stage tabs are
// identical in all three — that is the point.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verified performance stats snapshotted onto the request at send time —
 * server-computed from the sender's `HumanStats` aggregate, never a
 * client-supplied number. `computedAt` is the point-in-time the aggregate was
 * last recomputed, not "now".
 */
type VerifiedStatsSnapshot = {
  totalEventsPerformed: number;
  avgDrawPerEvent: number | null;
  repeatFanCount: number;
  refLinkTickets: number;
  last90DayTickets: number;
  last90DayEvents: number;
  computedAt: string | Date;
};

/**
 * The subset of `bookingRequestSummarySchema` this inbox renders.
 *
 * DELIBERATELY ASSIGNED, NEVER CAST. `listQuery.data.requests` is assigned
 * straight to `BookingRow[]` below, so tsc checks the WHOLE row shape against
 * the server contract — a renamed or retyped summary field fails the build
 * here instead of surfacing as `undefined` at runtime. Note `placeId` and
 * `placeName` are NULLABLE on the schema (TO_PERFORMER rows carry neither);
 * these scopes only ever return TO_VENUE rows, but the type has to admit the
 * null or the assignment silently needs a cast, which switches checking off
 * for all ~35 fields.
 */
type BookingRow = {
  id: string;
  placeId: string | null;
  placeName: string | null;
  /**
   * The programming calendar this request routes to, and its name. Both null
   * on unrouted/pre-hierarchy rows; the name is independently null when the
   * calendar was deleted (SetNull), so the filter skips rows missing either.
   */
  calendarId: string | null;
  calendarName: string | null;
  /**
   * Polymorphic sender pair — null for ANONYMOUS embed inquiries
   * (booking-request-embed-button FR-005/FR-006). Narrow via
   * {@link senderOf} instead of null-checking these directly.
   */
  performerOwnerType: "human" | "organization" | null;
  performerOwnerId: string | null;
  performerDisplayName: string | null;
  /** Anonymous-inquiry contact fields (set for embed inquiries). */
  contactName: string | null;
  contactEmail: string | null;
  /**
   * When a real party redeemed the invite-to-claim token. Load-bearing: the
   * owner pair alone no longer says whether an inquiry is claimed, because an
   * unclaimed inquiry the venue has replied to carries a SHADOW owner pair
   * (booking-inquirer-outreach). {@link senderOf} is the only thing that
   * should read this.
   */
  claimedAt: Date | null;
  /**
   * Set when the venue's emailed reply to an anonymous inquiry could not be
   * delivered (booking-inquirer-outreach). Without this the venue's thread
   * is indistinguishable from one nobody has answered yet: they replied, the
   * inquirer never saw it, and nothing on either side says so. Read ONLY
   * through {@link undeliverableOf}, which re-applies the anonymity lens.
   */
  inquirerEmailUndeliverableAt: Date | null;
  /**
   * WHICH failure. Two different facts, never collapsed into one "delivery
   * failed": BOUNCED = the address is bad; COMPLAINED = it arrived and was
   * marked as junk, so we stop mailing it.
   */
  inquirerEmailUndeliverableStatus: "BOUNCED" | "COMPLAINED" | null;
  /** Submission provenance — platform form vs the venue's website embed. */
  source: "PLATFORM" | "EMBED";
  message: string;
  preferredDates: string[];
  expectedDraw: number | null;
  genre: string | null;
  /** LEGACY generic pitch links — superseded by the typed link* fields. */
  links: string[];
  actName: string | null;
  lineupSize: number | null;
  setLengthMinutes: number | null;
  contactPhone: string | null;
  techNeeds: string | null;
  feeType: BookingFeeType | null;
  feeAmountCents: number | null;
  feeCurrency: string | null;
  linkMusic: string | null;
  linkVideo: string | null;
  linkSocial: string | null;
  linkEpk: string | null;
  status: BookingRequestStatus;
  viewedAt: Date | null;
  respondedAt: Date | null;
  declineReason: string | null;
  agreementId: string | null;
  /**
   * The stage projection behind {@link BookingStageRail} and the stage tabs
   * — the agreement's status and the event it produced.
   *
   * ALL FOUR DEGRADE TO NULL TOGETHER when the server's batched stage lookup
   * fails (`resolveBookingStages`), so null means "not there yet OR we could
   * not tell" and must never render as a definite negative. From the SERVER
   * the event triple is all-or-nothing: a non-null `eventId` guarantees the
   * other two. One LOCAL exception: right after "Create event from this
   * booking" the inbox writes `eventId` + `eventStatus: "DRAFT"` with a null
   * `eventStartsAt` into the cache until the refetch lands, and the stage rail
   * tolerates that (no date line, no off-pitch flag).
   */
  agreementStatus:
    | "DRAFT"
    | "PROPOSED"
    | "COUNTERED"
    | "ACCEPTED"
    | "DECLINED"
    | "CANCELLED"
    | "FULFILLED"
    | "EXPIRED"
    | "DISPUTED"
    | null;
  eventId: string | null;
  eventStatus:
    | "DRAFT"
    | "PUBLISHED"
    | "ARCHIVED"
    | "CANCELLED"
    | "COMPLETED"
    | null;
  eventStartsAt: Date | null;
  /**
   * What the request asks the venue for. Picks the DEFAULT owner of the
   * event a venue confirmation mints (PERFORM → venue, RENT / USE → the
   * requester); the thread's confirmation action reads it. Pre-spec rows
   * read PERFORM.
   */
  intent: "PERFORM" | "RENT" | "USE";
  /** Built from an event (`originEventId` set) — the only kind the venue can confirm. */
  builtFromEvent: boolean;
  /**
   * P5-fixes — what the holds strip's "Send terms" / "Book without terms"
   * are gated on, derived server-side (list-booking-requests.ts): the
   * booking's event as the booking paths resolve it (its night in the
   * PLACE's zone; null = could not tell), the night of terms already out,
   * and who a booking without terms pays.
   */
  bookingEvent:
    | { state: "none" }
    | { state: "live"; night: string; calendarId: string | null }
    | { state: "gone" }
    | null;
  termsNight: string | null;
  bookWithoutTermsPayee: "place" | "requester" | null;
  hasBookedNight: boolean | null;
  /**
   * The venue's vouch for the row's event — resolved in the same batched
   * pass as the event triple above and degraded to `none` with it, so
   * `none` means "no event OR we could not tell". `eventId` is null exactly
   * when `state` is `none`; `ownerSide` says whose event it is, which is
   * what lets the thread offer "Withdraw confirmation" only where the
   * server would accept it.
   */
  venueConfirmation: {
    state: "none" | "unconfirmed" | "confirmed" | "withdrawn";
    eventId: string | null;
    ownerSide: "place" | "requester" | null;
  };
  expiresAt: Date | null;
  createdAt: Date;
  verifiedStatsSnapshot: VerifiedStatsSnapshot | null;
  /**
   * Viewer-scoped unread thread messages (this is the VENUE side). Always a
   * number — 0 covers both "quiet" and "the count lookup degraded", which is
   * why the badge renders nothing at 0 rather than an empty chip.
   */
  unreadMessageCount: number;
  /**
   * The request's holds (booking-holds FR-011) — every status, with the
   * server's lazy-expiry projection on each. The Holds tab, the row line and
   * the strip all read the LIVE subset through `liveHolds`.
   */
  holds: (HoldSummary & { askedFor: boolean })[];
  /** Venue-internal assignee (FR-015). Null on human-owned venues, always. */
  assigneeHumanId: string | null;
  /** Venue-internal org tags (FR-017). `[]` on human-owned venues. */
  tags: { id: string; name: string; color: string }[];
};

/** Assignee filter: everyone, nobody, or one member. */
type AssigneeFilter = "all" | "unassigned" | { humanId: string };
const ASSIGNEE_ALL = "__all__";
const ASSIGNEE_NONE = "__unassigned__";

export type BookingInboxScope =
  | { kind: "place"; placeId: string }
  | { kind: "org-venues"; orgId: string }
  | { kind: "human-venues" };

export interface BookingInboxProps {
  scope: BookingInboxScope;
  /** Admin slug of the shell this inbox runs under — event/agreement links. */
  slug: string;
  /**
   * Multi-venue scopes only — `countOpen.venues`, the authoritative owned-venue
   * set behind the filter. Omit (or pass `[]`) and no filter renders.
   */
  venues?: BookingFilterVenue[];
  /** `countOpen.ownedPlacesTruncated`. */
  venuesTruncated?: boolean;
  venuesLoading?: boolean;
  venuesError?: boolean;
  onRetryVenues?: () => void;
}

/**
 * The server places holds only on live requests (place-booking-hold:
 * PENDING / VIEWED / ACCEPTED). Mirrored here so a declined, withdrawn or
 * expired row never offers a button the server will refuse.
 */
function canPlaceHold(row: Pick<BookingRow, "status">): boolean {
  return row.status === "PENDING" || row.status === "VIEWED" || row.status === "ACCEPTED";
}

/**
 * The inbox's ONE sender lens, and the choke point that keeps every
 * "is this still an anonymous inquiry" branch below honest.
 *
 * `getBookingRequestSender` answers "who do we notify", and since
 * booking-inquirer-outreach that is no longer the same question: an unclaimed
 * inquiry the venue has replied to carries a SHADOW owner pair so the reply
 * has somewhere to go, and the raw lens would report it OWNED. That would
 * silently take away the venue's `mailto:` contact affordance (embed spec
 * FR-006), the "Resend invite" button, and the accepted-but-unclaimed copy —
 * for exactly the inquiries the venue engaged with.
 *
 * So: while the inquiry is unclaimed, present it as anonymous. `claimedAt` is
 * stamped only by the token-proved redeem, so this flips to `owned` precisely
 * when a real party attaches themselves.
 *
 * Wrapped in try/catch because the server already skips corrupt rows (neither
 * identity), so a throw should be unreachable — but one bad row must never
 * blank the whole inbox.
 */
function senderOf(row: BookingRow): BookingRequestSender | null {
  try {
    if (isUnclaimedBookingInquiry(row) && row.contactName && row.contactEmail) {
      return {
        kind: "anonymous",
        contactName: row.contactName,
        contactEmail: row.contactEmail,
      };
    }
    return getBookingRequestSender(row);
  } catch {
    return null;
  }
}

/**
 * "We emailed this person on the venue's behalf and it did not arrive."
 *
 * Routed through {@link senderOf} on purpose. The server stamps the columns
 * only on inquiries it actually MAILED and never clears them, so once the
 * inquirer claims their account the thread reaches them in-platform and a
 * surviving bounce stamp would be a lie about a channel nobody uses any more.
 * Same lens, same rule as every other inquiry affordance on this row.
 *
 * Both halves are required: a row carrying a status with no timestamp (or the
 * reverse) is a contract violation, and half a fact renders as no fact rather
 * than as an alarm with a blank date.
 */
function undeliverableOf(
  row: BookingRow,
): { status: "BOUNCED" | "COMPLAINED"; at: Date; contactEmail: string; contactName: string } | null {
  const sender = senderOf(row);
  if (sender?.kind !== "anonymous") return null;
  const status = row.inquirerEmailUndeliverableStatus;
  const at = row.inquirerEmailUndeliverableAt;
  if (!status || !at) return null;
  return {
    status,
    at: new Date(at),
    contactEmail: sender.contactEmail,
    contactName: sender.contactName,
  };
}

function safeExternalHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function StatPair({ label, value }: { label: string; value: string }) {
  return (
    <YStack gap="$1" minWidth={96}>
      <Text
        variant="caption"
        tone="muted"
        textTransform="uppercase"
        letterSpacing={0.4}
      >
        {label}
      </Text>
      <Text variant="bodySmall" weight="bold">
        {value}
      </Text>
    </YStack>
  );
}

/** Uppercase field label inside the expanded detail panel. */
function DetailLabel({ children }: { children: string }) {
  return (
    <Text
      variant="caption"
      weight="bold"
      tone="muted"
      textTransform="uppercase"
      letterSpacing={0.6}
    >
      {children}
    </Text>
  );
}

const TAB_LABEL_KEYS: Record<BookingInboxTab, string> = {
  open: "admin.bkInboxTabOpen",
  holds: "admin.bkInboxTabHolds",
  agreement: "admin.bkInboxTabAgreement",
  event: "admin.bkInboxTabEvent",
  closed: "admin.bkInboxTabClosed",
};

const TAB_EMPTY_KEYS: Record<BookingInboxTab, string> = {
  open: "admin.bkInboxEmptyOpen",
  holds: "admin.bkInboxEmptyHolds",
  agreement: "admin.bkInboxEmptyAgreement",
  event: "admin.bkInboxEmptyEvent",
  closed: "admin.bkInboxEmptyClosed",
};

// ─────────────────────────────────────────────────────────────────────────────
// Styled primitives
// ─────────────────────────────────────────────────────────────────────────────

/** The place page's own container; the org workspace supplies its own. */
const PageContainer = styled(YStack, {
  name: "BookingInboxPage",
  gap: "$4",
  padding: "$4",
  width: "100%",
  maxWidth: 1000,
  marginHorizontal: "auto",
  $gtMd: { padding: "$6" },
});

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function BookingInbox({
  scope,
  slug,
  venues = [],
  venuesTruncated = false,
  venuesLoading = false,
  venuesError = false,
  onRetryVenues,
}: BookingInboxProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const t = useTranslations();
  const fmt = useFormatters();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const isPlace = scope.kind === "place";
  const placeId = scope.kind === "place" ? scope.placeId : null;
  const isMultiVenue = !isPlace;
  /**
   * The ORG behind this inbox, when there is one. The assignee column, the
   * Unassigned filter and the tag chrome are venue-internal ORG workflow
   * (FR-015 / FR-017): a human-owned venue's owner is implicitly its
   * assignee and has no org tag vocabulary, so `human-venues` shows holds
   * and nothing else. The place scope takes its org from the admin shell it
   * is mounted in (`useCurrentAdminOwner`), so `/admin/{org}/places/{id}/
   * bookings` gets the chrome and `/admin/@me/places/{id}/bookings` does not.
   */
  const scopeOrgId = scope.kind === "org-venues" ? scope.orgId : null;

  const [chosenTab, setChosenTab] = useState<BookingInboxTab | null>(null);
  /**
   * ONE dimension, not two. Venue and calendar were separate selects until the
   * grouped control replaced them: a venue-side request routes to exactly one
   * calendar and every calendar belongs to exactly one venue, so "filter by
   * venue" only ever meant "all of that venue's calendars".
   *
   * The value is a flat set of CALENDAR ids — a venue is a group heading in
   * the control, never a value here — so the row predicate is one membership
   * test and no venue branch exists to drift.
   */
  const [selectedCalendarIds, setSelectedCalendarIds] = useState<string[]>([]);
  const [assigneeFilter, setAssigneeFilter] = useState<AssigneeFilter>("all");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  // Hold-confirm outcomes, per row — held here for the same reason as the
  // create-event outcomes below: confirming moves the row to the Event tab
  // and the DataTable remounts its subtree on the move.
  const [holdOutcomeById, setHoldOutcomeById] = useState<
    Record<string, BookingHoldConfirmOutcome>
  >({});
  // One clock for every row's hold line, ticking once a minute only while a
  // challenge is running somewhere in the list.
  const [now, setNow] = useState(() => new Date());
  // FOLLOW THE ROW after a hold write. Placing a hold re-files an accepted
  // request from Agreement to Holds; releasing the last one files it back.
  // Either way the row leaves the tab it was expanded on, and a detail panel
  // that vanishes mid-task is the accept-flow bug all over again. The strip
  // reports a write; once the refetch lands, the effect below moves the view
  // to wherever the row now is (a no-op when it did not move).
  //
  // LATCHED AGAINST THE FETCH COUNTER, NOT THE CACHE CLOCK. `since` is the
  // number of fetches that had COMPLETED SUCCESSFULLY at the moment of the
  // write; the effect only resolves once one more has. Resolving against the
  // list already in the cache (the stale one) found the row still on its old
  // tab, cleared the latch, and the real delivery then moved the row out from
  // under the open panel — the exact bug the latch exists to prevent. And
  // `dataUpdatedAt` is not that clock: every `setData` write (markViewed,
  // assign, setTags) bumps it too, against a list that is still stale.
  //
  // The latch is DROPPED, never left armed, when the refetch FAILS (`at` is
  // compared with `errorUpdatedAt`, which only a failed fetch moves) and when
  // the user picks a tab themselves. An armed latch that outlives its refetch
  // fires on the next unrelated delivery and yanks the tab minutes later.
  const [follow, setFollow] = useState<{
    id: string;
    since: number;
    at: number;
  } | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  // Deep-link scroll target, once the row has RENDERED. It may be on a tab
  // other than the latched default, so it does not exist until the commit
  // after `setChosenTab` — a frame-timed scroll would find nothing. The
  // effect after `rows` scrolls when the row is there, then clears.
  const [pendingScrollId, setPendingScrollId] = useState<string | null>(null);
  const [acceptTargetId, setAcceptTargetId] = useState<string | null>(null);
  const [declineTargetId, setDeclineTargetId] = useState<string | null>(null);
  const [declineReason, setDeclineReason] = useState("");
  // Invite-to-claim affordances on accepted ANONYMOUS rows (FR-007). The list
  // summary doesn't expose claimTokenExpiresAt (follow-up noted in the
  // feature spec), so an expiry date is only known after a resend in this
  // session — keyed per row so it survives expanding other rows.
  const [inviteExpiryById, setInviteExpiryById] = useState<
    Record<string, Date>
  >({});
  const [resendError, setResendError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  // "Create event from this booking" outcomes, per row. Held HERE and not in
  // the action: creating moves the row to the Event tab, and the DataTable
  // remounts the row's subtree on that move — state inside the action would
  // vanish with it, and the venue would never read what happened.
  const [createOutcomeById, setCreateOutcomeById] = useState<
    Record<string, CreateEventFromBookingResult>
  >({});

  const listInput = useMemo(
    () =>
      scope.kind === "place"
        ? { scope: "venue" as const, placeId: scope.placeId }
        : scope.kind === "org-venues"
          ? { scope: "org-venues" as const, orgId: scope.orgId }
          : { scope: "human-venues" as const },
    [scope],
  );

  const listQuery = trpc.bookingRequests.list.useQuery(listInput, {
    staleTime: 15_000,
    retry: 1,
  });

  /**
   * PLACE SCOPE ONLY. The venue's own switches, read for the EMPTY STATE. "No
   * requests yet" has three different causes and only one of them is "nothing
   * has happened yet"; naming the wrong one is what sent the reporter of this
   * bug hunting through page settings. Same query key `BookingAcceptanceToggle`
   * subscribes to and writes optimistically, so React Query dedupes it to one
   * request and the switch can never disagree with the sentence underneath it.
   */
  const placeQuery = trpc.places.getPlaceForEdit.useQuery(
    { placeId: placeId ?? "" },
    { enabled: placeId !== null, staleTime: 10_000, retry: 1 },
  );
  const place = placeQuery.data?.place;
  const isPlaceVerified = place?.verificationStatus === "VERIFIED";
  /**
   * THREE-STATE: true / false / `null` for "we do not know".
   *
   * It used to be `?? false`, and that default was a lie waiting for a reader.
   * `listBookingRequests` scope `venue` admits ANY member of an owning org
   * (`requirePlaceOwnership`), while `places.getPlaceForEdit` sits at
   * `canManagePlace` — so a SCANNER renders this whole inbox with `place`
   * undefined. Collapsing that to `false` told them their place was not
   * accepting requests when it was, and `BookingEmbedSection` then pointed
   * them at a switch that is not on their page (`BookingAcceptanceToggle`
   * returns null on the same error).
   *
   * Every consumer below must distinguish `false` from `null` explicitly. The
   * empty-state copy already does it structurally — it renders inside
   * `{place ? … : null}` — which is the precedent this follows.
   */
  const acceptsRequests: boolean | null = place
    ? place.acceptsBookingRequests
    : null;
  // Place scope: the org is the admin shell's owner entity (the org acting on
  // this place), resolved from the route slug — a human shell yields null.
  const { currentOwner } = useCurrentAdminOwner(slug);
  const orgId =
    scopeOrgId ??
    (isPlace && currentOwner?.kind === "org" ? currentOwner.orgId : null);
  const hasOrgChrome = orgId !== null;

  // Roster, read once per org and shared with every picker in the list.
  const members = useOrgMembers(orgId);

  const assignMutation = trpc.bookingRequests.assign.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const setTagsMutation = trpc.bookingTags.setForRequest.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const markViewedMutation = trpc.bookingRequests.markViewed.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const respondMutation = trpc.bookingRequests.respond.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const resendInviteMutation = trpc.bookingRequests.resendInvite.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const allRequests = useMemo<BookingRow[]>(
    () => listQuery.data?.requests ?? [],
    [listQuery.data?.requests],
  );

  const hasRunningChallenge = useMemo(
    () =>
      allRequests.some((r) =>
        r.holds.some((h) => h.status === "CHALLENGED" && !h.lapsed),
      ),
    [allRequests],
  );
  useEffect(() => {
    if (!hasRunningChallenge) return;
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [hasRunningChallenge]);

  /**
   * The venue selection RECONCILED against the venue set, every render.
   *
   * A held id can stop being an option under us — ownership revoked, the place
   * unverified, the count query refetching into a shorter list. The select then
   * matches no option and falls back to displaying "All venues" while the rows
   * stay filtered to a venue that is no longer there: the control says one thing
   * and the list does another, under an empty state blaming the filter.
   *
   * Derived rather than cleared in an effect, so the control and the rows can
   * never disagree for even one paint. It also degrades correctly when the count
   * query fails: `venues` is empty, no filter is on screen, so no invisible
   * filter is applied to the rows either.
   */
  /**
   * The live filter, DERIVED from the selection rather than stored — so a
   * calendar id that stops being an option under us (ownership revoked, the
   * count query refetching into a shorter list) simply stops filtering,
   * instead of leaving the control saying "All calendars" while the rows stay
   * narrowed to something no longer on offer.
   *
   * Never cleared in an effect: the control and the rows must not disagree for
   * even one paint. It also degrades correctly when the count query fails —
   * `venues` is empty, no control renders, and no invisible filter is applied.
   */
  const offeredCalendarIds = useMemo(
    // `?? []` is not defensive noise: during a rolling deploy a client running
    // this code can still hold a react-query payload cached before `calendars`
    // existed on the wire. Reading it as absent degrades to "no filter" —
    // every row visible — where a throw would blank the whole inbox.
    () => new Set(venues.flatMap((v) => (v.calendars ?? []).map((c) => c.id))),
    [venues],
  );
  const calendarFilter = useMemo(() => {
    if (!isMultiVenue) return null;
    const live = selectedCalendarIds.filter((id) => offeredCalendarIds.has(id));
    return live.length > 0 ? new Set(live) : null;
  }, [isMultiVenue, selectedCalendarIds, offeredCalendarIds]);

  // The filter narrows the SET the tabs count and render, in that order — so
  // "Open (3)" always means "3 rows on this tab, for what you are looking at",
  // never "3 somewhere in the org". Assignee and tags (org scopes only) narrow
  // the same set for the same reason.
  const venueScoped = useMemo<BookingRow[]>(() => {
    let rows =
      calendarFilter === null
        ? allRequests
        : allRequests.filter(
            (r) => r.calendarId !== null && calendarFilter.has(r.calendarId),
          );
    if (hasOrgChrome && assigneeFilter !== "all") {
      rows = rows.filter((r) =>
        assigneeFilter === "unassigned"
          ? r.assigneeHumanId === null
          : r.assigneeHumanId === assigneeFilter.humanId,
      );
    }
    if (hasOrgChrome && tagFilter.length > 0) {
      // ANY of the chosen tags — a filter that demands all of them is a
      // search, and the vocabulary is small.
      const wanted = new Set(tagFilter);
      rows = rows.filter((r) => r.tags.some((tag) => wanted.has(tag.id)));
    }
    return rows;
  }, [allRequests, assigneeFilter, calendarFilter, hasOrgChrome, tagFilter]);

  // Counts and rows run through the SAME classifier, so a tab can never
  // advertise a number it doesn't show.
  const tabCounts = useMemo(() => countBookingInboxTabs(venueScoped), [venueScoped]);

  // LATCHED: the default tab is a LANDING decision, taken once from the first
  // list that resolves — not a live function of the counts. Without the
  // latch, answering the LAST open request re-derives the default and moves
  // the user (observed on the org workspace: declining the final request
  // flipped the page mid-task). Responding to a request must never navigate.
  // A ref, not state: an idempotent "first non-null wins" derivation, safe
  // under a StrictMode double-render.
  const latchedDefault = useRef<BookingInboxTab | null>(null);
  if (latchedDefault.current === null && listQuery.data !== undefined) {
    latchedDefault.current = defaultBookingInboxTab(
      countBookingInboxTabs(allRequests),
    );
  }
  const tab: BookingInboxTab = chosenTab ?? latchedDefault.current ?? "open";

  // THE FETCH COUNTER. Counts fetches that finished WITHOUT an error — the
  // `isFetching` true→false edge, not `dataUpdatedAt`, which every cache
  // write also moves. A mocked reader may omit the flags; they then read as
  // "never fetching", and the counter never moves, which the latch treats as
  // "still waiting".
  const listFetching = listQuery.isFetching ?? false;
  const listErrored = listQuery.isError ?? false;
  const listErrorAt = listQuery.errorUpdatedAt ?? 0;
  const [fetchedCount, setFetchedCount] = useState(0);
  // Mirrored in a ref so `followRow` reads the count AT THE MOMENT OF THE
  // WRITE — the mutation's onSuccess fires from the render in which submit
  // was clicked, and a delivery that landed during the round-trip would
  // otherwise leave `since` one behind and the latch resolving against it.
  const fetchedCountRef = useRef(0);
  const wasFetching = useRef(listFetching);
  useEffect(() => {
    const was = wasFetching.current;
    wasFetching.current = listFetching;
    if (was && !listFetching && !listErrored) {
      fetchedCountRef.current += 1;
      setFetchedCount(fetchedCountRef.current);
    }
  }, [listFetching, listErrored]);

  const followRow = useCallback(
    (id: string) =>
      setFollow({ id, since: fetchedCountRef.current, at: Date.now() }),
    [],
  );
  const chooseTab = useCallback((next: BookingInboxTab) => {
    // The user's own choice wins over a pending follow: a latch that outlives
    // a tab click would move them off the tab they just picked.
    setFollow(null);
    setChosenTab(next);
  }, []);
  useEffect(() => {
    if (!follow) return;
    // The refetch FAILED: nothing newer will arrive for this write, and the
    // next successful delivery is unrelated. Drop the latch rather than let
    // it fire on that one.
    if (listErrorAt > follow.at) {
      setFollow(null);
      return;
    }
    // Still the list the write was made against — wait for the refetch.
    if (!(fetchedCount > follow.since)) return;
    const row = allRequests.find((r) => r.id === follow.id);
    if (row) {
      const target = bookingInboxTabOf(row);
      if (target !== tab) {
        setChosenTab(target);
        setExpandedIds((prev) => new Set(prev).add(follow.id));
      }
    }
    // Resolved on the first NEW list after the write, whether or not the row
    // moved (or survived) — never latched across unrelated refetches.
    setFollow(null);
    // `tab` is read, not tracked: this must run per LIST delivery, not per
    // tab click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRequests, follow, fetchedCount, listErrorAt]);


  const rows = useMemo<BookingRow[]>(
    () =>
      rowsForBookingInboxTab(venueScoped, tab).sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [venueScoped, tab],
  );

  // Deep-link scroll: after the commit that put the row on screen.
  useEffect(() => {
    if (!pendingScrollId) return;
    const el = findBookingInboxRowElement(
      document,
      "booking-inbox-table",
      pendingScrollId,
    );
    if (!el) return;
    el.scrollIntoView({ block: "start" });
    setPendingScrollId(null);
  }, [pendingScrollId, rows]);

  // `ownedPlacesTruncated` is scope-specific and OPTIONAL on the wire — only
  // `=== true` means "the tail was cut". Either source counts: the count query
  // feeds the filter's venue set, the list query feeds the rows, and both walk
  // the same capped enumeration.
  const truncated =
    listQuery.data?.ownedPlacesTruncated === true || venuesTruncated;

  /**
   * Who the request is WITH — the only thing that distinguishes one accepted
   * row's agreement link from the next, since they all share one visible label.
   */
  const counterpartyOf = useCallback(
    (row: BookingRow): string => {
      const sender = senderOf(row);
      if (sender?.kind === "anonymous") return sender.contactName;
      return (
        row.performerDisplayName ??
        row.actName ??
        String(t("admin.bkHubActFallback"))
      );
    },
    [t],
  );

  // ── Mark viewed (fire-and-forget on expand, optimistic) ──────────────────
  const markViewed = useCallback(
    (row: BookingRow) => {
      utils.bookingRequests.list.setData(listInput, (prev) =>
        prev
          ? {
              // Spread, not `{ requests }`: the multi-venue payloads also carry
              // `ownedPlacesTruncated`, and rebuilding the object from one key
              // would drop the truncation notice on every expand.
              ...prev,
              requests: prev.requests.map((r) =>
                r.id === row.id && r.status === "PENDING"
                  ? { ...r, status: "VIEWED" as const, viewedAt: new Date() }
                  : r,
              ),
            }
          : prev,
      );
      markViewedMutation.mutate(
        { bookingRequestId: row.id },
        {
          // Terminal/raced state — refresh to the server's truth.
          onError: () => void listQuery.refetch(),
        },
      );
    },
    [listInput, listQuery, markViewedMutation, utils.bookingRequests.list],
  );

  const toggleExpand = useCallback(
    (row: BookingRow) => {
      const willExpand = !expandedIds.has(row.id);
      // Fire-and-forget outside the state updater (updaters must stay pure —
      // StrictMode double-invokes them).
      if (willExpand && row.status === "PENDING") markViewed(row);
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
    },
    [expandedIds, markViewed],
  );

  // ── `?request=<id>` deep link ────────────────────────────────────────────
  // ONCE, on the first list that resolves: land on the row's stage tab, expand
  // it, scroll it into view, and strip the param (`replace`, no history entry)
  // so a refresh does not re-jump. Unknown id → nothing happens and the URL is
  // left alone. THE DEEP LINK WINS OVER THE LATCH: `chosenTab` outranks the
  // latched default, and any armed follow is dropped, exactly as a tab click
  // does. After this fires the latch and the follow resume as normal. A ref,
  // not state: fired at most once per mount, safe under StrictMode.
  const requestParam = searchParams?.get(BOOKING_INBOX_REQUEST_PARAM) ?? null;
  const deepLinkConsumed = useRef(false);
  useEffect(() => {
    if (deepLinkConsumed.current) return;
    if (!requestParam || listQuery.data === undefined) return;
    deepLinkConsumed.current = true;
    const target = resolveBookingInboxDeepLink(allRequests, requestParam);
    if (!target) return;
    const row = allRequests.find((r) => r.id === target.id);
    // Same side effect as a click on the row: an unopened request is viewed.
    if (row?.status === "PENDING") markViewed(row);
    setFollow(null);
    setChosenTab(target.tab);
    setExpandedIds((prev) => new Set(prev).add(target.id));
    setPendingScrollId(target.id);
    // Strip ONLY our param, natively. `router.replace` is a navigation: it
    // re-renders the route through the admin layout and can remount this
    // tree, dropping the tab and the expanded row it just set. The app router
    // syncs `useSearchParams` with the native history API, so this is enough.
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    params.delete(BOOKING_INBOX_REQUEST_PARAM);
    const query = params.toString();
    window.history.replaceState(
      window.history.state,
      "",
      query ? `${pathname}?${query}` : pathname,
    );
    // `markViewed` and `searchParams` are read at fire time, not tracked:
    // this must run per list delivery, never re-arm because a callback was
    // recreated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRequests, listQuery.data, pathname, requestParam]);

  // ── Respond (accept / decline) ───────────────────────────────────────────
  const handleRespondError = useCallback(
    (err: unknown) => {
      const e = err as { data?: { code?: string } | null };
      if (e?.data?.code === "CONFLICT") {
        toast.warning({
          id: "booking-respond-conflict",
          title: String(t("admin.bkInboxConflict")),
        });
      } else {
        toast.danger({
          id: "booking-respond-failed",
          title: String(t("admin.bkInboxActionFailed")),
          message: formatErrorMessage(err, t),
        });
      }
      void listQuery.refetch();
    },
    [listQuery, t, toast],
  );

  // The row behind the accept confirmation — accepting an ANONYMOUS inquiry
  // sends an invite-to-claim email instead of creating an Agreement (FR-007),
  // so the dialog copy and success toast must say what actually happens.
  const acceptTarget = useMemo(
    () => allRequests.find((r) => r.id === acceptTargetId) ?? null,
    [allRequests, acceptTargetId],
  );
  const acceptTargetSender = acceptTarget ? senderOf(acceptTarget) : null;

  const handleAccept = useCallback(() => {
    if (!acceptTargetId || respondMutation.isPending) return;
    const acceptedId = acceptTargetId;
    const isAnonymousAccept = acceptTargetSender?.kind === "anonymous";
    respondMutation.mutate(
      { bookingRequestId: acceptedId, action: "accept" },
      {
        // `result` carries the freshly-minted `agreementId`
        // (respondToBookingRequestOutputSchema). Dropping it on the floor is
        // what turns "Agreement draft created" into a dead end.
        onSuccess: (result) => {
          const agreementId = result.agreementId ?? null;
          // Write the answer into the cache before the refetch lands, so the
          // row is ALREADY on the Agreement tab we're about to switch to —
          // otherwise the tab flashes its empty state for one round-trip.
          // Safe as a plain write, not an optimistic guess: the mutation has
          // already succeeded, so this is the server's answer, early.
          utils.bookingRequests.list.setData(listInput, (prev) =>
            prev
              ? {
                  ...prev,
                  requests: prev.requests.map((r) =>
                    r.id === acceptedId
                      ? {
                          ...r,
                          status: "ACCEPTED" as const,
                          agreementId: agreementId ?? r.agreementId,
                          // Accept mints a DRAFT agreement, so the rail's
                          // agreement leg lights from this write, not the
                          // refetch (same parity as the create-event write).
                          agreementStatus: agreementId
                            ? ("DRAFT" as const)
                            : r.agreementStatus,
                          respondedAt: new Date(),
                        }
                      : r,
                  ),
                }
              : prev,
          );
          // Follow the request to where it now lives, with its detail open —
          // an accepted request is not "gone", it's the history of a booking.
          // Accept is only reachable from Open (the only tab that lists
          // answerable rows), where the row would otherwise vanish.
          setChosenTab("agreement");
          setExpandedIds((prev) => new Set(prev).add(acceptedId));
          toast.success({
            id: "booking-accepted",
            title: isAnonymousAccept
              ? String(t("admin.bkWsVenInviteSent"))
              : String(t("admin.bkInboxAcceptSuccess")),
            // Answers "where did it go?" for BOTH branches.
            message: String(t("admin.bkInboxAcceptSuccessMessage")),
            // An accepted ANONYMOUS inquiry has no Agreement yet (FR-007 sends
            // an invite-to-claim instead), and the output schema makes
            // `agreementId` optional — no id, no link, never a broken href.
            ...(isAnonymousAccept || !agreementId
              ? {}
              : {
                  // Long enough to read the action before auto-dismiss.
                  durationMs: 10_000,
                  action: {
                    label: String(t("admin.baOpenAgreement")),
                    onPress: () =>
                      router.push(adminAgreementHref(slug, agreementId)),
                  },
                }),
          });
          void utils.bookingRequests.list.invalidate();
          // Separate query key from `list` — answering here has to correct the
          // venue filter's open counts and the admin rail's Bookings badge,
          // neither of which reads this list.
          void utils.bookingRequests.countOpen.invalidate();
        },
        onError: handleRespondError,
        onSettled: () => setAcceptTargetId(null),
      },
    );
  }, [
    acceptTargetId,
    acceptTargetSender,
    handleRespondError,
    listInput,
    respondMutation,
    router,
    slug,
    t,
    toast,
    utils.bookingRequests.countOpen,
    utils.bookingRequests.list,
  ]);

  // ── Resend invite (accepted anonymous rows, FR-007; place scope) ─────────
  const handleResendInvite = useCallback(
    (row: BookingRow) => {
      if (resendInviteMutation.isPending) return;
      setResendError(null);
      resendInviteMutation.mutate(
        { bookingRequestId: row.id },
        {
          onSuccess: (result) => {
            setInviteExpiryById((prev) => ({
              ...prev,
              [row.id]: new Date(result.claimTokenExpiresAt),
            }));
            toast.success({
              id: "booking-invite-resent",
              title: String(t("admin.bkInboxInviteResent")),
            });
          },
          onError: (err) => {
            const code = (err as { data?: { code?: string } | null })?.data
              ?.code;
            setResendError({
              id: row.id,
              message:
                code === "TOO_MANY_REQUESTS"
                  ? String(t("admin.bkInboxInviteResendLimited"))
                  : formatErrorMessage(err, t),
            });
          },
        },
      );
    },
    [resendInviteMutation, t, toast],
  );

  // ── Assign / tag (org workflow, FR-015 / FR-017) ─────────────────────────
  const handleAssign = useCallback(
    (row: BookingRow, assigneeHumanId: string | null) => {
      if (assignMutation.isPending) return;
      assignMutation.mutate(
        { bookingRequestId: row.id, assigneeHumanId },
        {
          onSuccess: (result) => {
            // The server's answer, early — the refetch confirms it.
            utils.bookingRequests.list.setData(listInput, (prev) =>
              prev
                ? {
                    ...prev,
                    requests: prev.requests.map((r) =>
                      r.id === row.id
                        ? { ...r, assigneeHumanId: result.assigneeHumanId }
                        : r,
                    ),
                  }
                : prev,
            );
            void utils.bookingRequests.list.invalidate();
            // Assignment writes a ledger line.
            void utils.bookingRequests.messages.list.invalidate({
              bookingRequestId: row.id,
            });
          },
          onError: (err) => {
            toast.danger({
              id: "booking-assign-failed",
              title: String(t("admin.bkAssignFailed")),
              message: formatErrorMessage(err, t),
            });
            void listQuery.refetch();
          },
        },
      );
    },
    [assignMutation, listInput, listQuery, t, toast, utils.bookingRequests.list, utils.bookingRequests.messages.list],
  );

  const handleSetTags = useCallback(
    (row: BookingRow, tagIds: string[]) => {
      setTagsMutation.mutate(
        { bookingRequestId: row.id, tagIds },
        {
          onSuccess: (result) => {
            utils.bookingRequests.list.setData(listInput, (prev) =>
              prev
                ? {
                    ...prev,
                    requests: prev.requests.map((r) =>
                      r.id === row.id
                        ? {
                            ...r,
                            tags: result.tags.map((tag) => ({
                              id: tag.id,
                              name: tag.name,
                              color: tag.color,
                            })),
                          }
                        : r,
                    ),
                  }
                : prev,
            );
            void utils.bookingRequests.list.invalidate();
          },
          onError: (err) => {
            toast.danger({
              id: "booking-tags-failed",
              title: String(t("admin.bkTagsUpdateFailed")),
              message: formatErrorMessage(err, t),
            });
            void listQuery.refetch();
          },
        },
      );
    },
    [listInput, listQuery, setTagsMutation, t, toast, utils.bookingRequests.list],
  );

  const assigneeLabel = useCallback(
    (row: BookingRow): { text: string; muted: boolean } => {
      if (row.assigneeHumanId === null) {
        return { text: String(t("admin.bkAssigneeUnassigned")), muted: true };
      }
      const label = members.labelOf(row.assigneeHumanId);
      return label
        ? { text: label, muted: false }
        : { text: String(t("admin.bkAssigneeFormerMember")), muted: true };
    },
    [members, t],
  );

  const handleDecline = useCallback(
    (row: BookingRow) => {
      const reason = declineReason.trim();
      // TO_VENUE declines REQUIRE a reason (respond-to-booking-request.ts
      // enforces it on this direction only) — do not relax this to match the
      // org-as-act table, whose rows are TO_PERFORMER and need none.
      if (reason.length < 3 || respondMutation.isPending) return;
      respondMutation.mutate(
        { bookingRequestId: row.id, action: "decline", declineReason: reason },
        {
          onSuccess: () => {
            setDeclineTargetId(null);
            setDeclineReason("");
            void utils.bookingRequests.list.invalidate();
            // Separate query key — see the note in handleAccept.
            void utils.bookingRequests.countOpen.invalidate();
          },
          onError: handleRespondError,
        },
      );
    },
    [
      declineReason,
      handleRespondError,
      respondMutation,
      utils.bookingRequests.countOpen,
      utils.bookingRequests.list,
    ],
  );

  // Tag chips on a row — read-only here; editing lives in the expanded row.
  // Renders nothing for a row with no tags (an empty chip row is noise).
  const tagChips = useCallback(
    (row: BookingRow, testIdBase: string) =>
      hasOrgChrome && row.tags.length > 0 ? (
        <XStack gap="$1" flexWrap="wrap" minWidth={0} data-testid={`${testIdBase}-tags`}>
          {row.tags.map((tag) => (
            <BookingTagChip
              key={tag.id}
              name={tag.name}
              color={tag.color}
              testId={`${testIdBase}-tag-${tag.id}`}
            />
          ))}
        </XStack>
      ) : null,
    [hasOrgChrome],
  );

  // ── Columns ──────────────────────────────────────────────────────────────
  // Sender · [Venue] · Preferred dates · Stage · Received, plus the agreement
  // action. Genre and draw live in the expanded detail: on the multi-venue
  // scopes they were moved out to buy room for the VENUE column, and the
  // place scope now matches so the two surfaces read the same.
  const columns = useMemo<DataTableColumn<BookingRow>[]>(
    () => [
      {
        id: "sender",
        header: String(t("admin.bkInboxColSender")),
        width: 1.5,
        cell: (row) => {
          const sender = senderOf(row);
          // Anonymous embed inquiry (FR-006): the submitted contact name is
          // the identity; there is no performer profile/type to show. The
          // uppercase caption doubles as the calm EMBED-source badge.
          if (sender?.kind === "anonymous") {
            return (
              <YStack gap="$1" minWidth={0}>
                <Text variant="bodySmall" weight="bold" truncate>
                  {sender.contactName}
                </Text>
                <Text
                  variant="caption"
                  tone="muted"
                  textTransform="uppercase"
                  letterSpacing={0.4}
                >
                  {String(t("admin.bkWsVenAnonSource"))}
                </Text>
                {tagChips(row, `booking-inbox-row-${row.id}`)}
              </YStack>
            );
          }
          const typeLabel =
            row.performerOwnerType === "organization"
              ? String(t("admin.bkInboxSenderOrg"))
              : String(t("admin.bkInboxSenderHuman"));
          return (
            <YStack gap="$1" minWidth={0}>
              <Text variant="bodySmall" weight="bold" truncate>
                {row.performerDisplayName ?? typeLabel}
              </Text>
              <Text variant="caption" tone="muted">
                {typeLabel}
              </Text>
              {tagChips(row, `booking-inbox-row-${row.id}`)}
            </YStack>
          );
        },
      },
      ...(isMultiVenue
        ? [
            {
              id: "venue",
              header: String(t("admin.bkWsColVenue")),
              // MEASURED at 1280 inside the admin shell: at 1.3 the column
              // rendered ~165px and clipped "The Paramount Theatre" to "The
              // Paramount Theat". The venue is the one thing a cross-venue row
              // must be able to say, so it gets the width and the date column
              // gives it up.
              width: 1.6,
              truncate: true,
              tooltipValue: (row: BookingRow) => row.placeName ?? "",
              cell: (row: BookingRow) => (
                <Text
                  variant="bodySmall"
                  tone={row.placeName ? undefined : "muted"}
                  truncate
                >
                  {row.placeName ?? "—"}
                </Text>
              ),
            } satisfies DataTableColumn<BookingRow>,
          ]
        : []),
      {
        id: "dates",
        header: String(t("admin.bkInboxColDates")),
        width: isMultiVenue ? 1.05 : 1.2,
        cell: (row) => {
          const first = row.preferredDates[0];
          if (!first) {
            return (
              <Text variant="bodySmall" tone="muted">
                —
              </Text>
            );
          }
          const extra = row.preferredDates.length - 1;
          return (
            <Text variant="bodySmall">
              {fmt.dateTime(isoDateToLocal(first), { dateStyle: "medium" })}
              {extra > 0 ? ` +${extra}` : ""}
            </Text>
          );
        },
      },
      {
        id: "status",
        // WAS "Status", showing one chip that said `PENDING` — a word about
        // the REQUEST only, on a row whose booking may already have an
        // agreement out for review and an event on sale. The column shows
        // the whole arc, and the chip is GONE rather than sitting beside the
        // rail printing the same fact twice: the rail's request leg carries
        // the same six `bkStatus*` words the badge did.
        header: String(t("admin.bkStageColHeader")),
        // The rail is the widest thing in this cell and clipping it would
        // defeat the point.
        width: 1.7,
        // The unread chip STAYS, stacked under the rail. It is a different
        // KIND of fact — "a reply landed" is not a stage — and it is the one
        // signal that used to be invisible from every list surface.
        cell: (row) => {
          const undeliverable = undeliverableOf(row);
          return (
          <YStack gap="$2" alignItems="flex-start" minWidth={0}>
            <BookingStageRail
              status={row.status}
              agreementStatus={row.agreementStatus}
              eventId={row.eventId}
              eventStatus={row.eventStatus}
              eventStartsAt={row.eventStartsAt}
              preferredDates={row.preferredDates}
              venueConfirmation={row.venueConfirmation}
              testIdBase={`booking-inbox-row-${row.id}`}
            />
            {/* Directly under the rail, ABOVE the hold line and the unread
                chip: "your reply never arrived" outranks a hold date and a
                message count for attention. Renders nothing on every other
                row, so no row's height moves because of a neighbour. */}
            {undeliverable ? (
              <BookingInquirerUndeliverableBadge
                status={undeliverable.status}
                contactName={undeliverable.contactName}
                testIdBase={`booking-inbox-row-${row.id}`}
              />
            ) : null}
            <BookingHoldSummary
              holds={row.holds}
              now={now}
              testIdBase={`booking-inbox-row-${row.id}`}
            />
            <UnreadMessagesBadge
              count={row.unreadMessageCount}
              testIdBase={`booking-inbox-row-${row.id}`}
            />
          </YStack>
          );
        },
      },
      ...(hasOrgChrome
        ? [
            {
              id: "assignee",
              header: String(t("admin.bkInboxColAssignee")),
              width: 1.1,
              truncate: true,
              tooltipValue: (row: BookingRow) => assigneeLabel(row).text,
              cell: (row: BookingRow) => {
                const label = assigneeLabel(row);
                return (
                  <Text
                    variant="bodySmall"
                    tone={label.muted ? "muted" : undefined}
                    truncate
                    testID={`booking-inbox-row-${row.id}-assignee`}
                  >
                    {label.text}
                  </Text>
                );
              },
            } satisfies DataTableColumn<BookingRow>,
          ]
        : []),
      {
        id: "received",
        header: String(t("admin.bkInboxColReceived")),
        // MEASURED at 1280: below ~1.1 this column renders under 115px and
        // "Aug 20, 2026" wraps onto two lines mid-date.
        width: 1.15,
        truncate: true,
        tooltipValue: (row) => new Date(row.createdAt).toLocaleString(),
        cell: (row) => (
          <Text variant="bodySmall" tone="muted">
            {fmt.dateTime(new Date(row.createdAt), { dateStyle: "medium" })}
          </Text>
        ),
      },
    ],
    [assigneeLabel, fmt, hasOrgChrome, isMultiVenue, now, t, tagChips],
  );

  // ── Row action: the agreement, reachable WITHOUT expanding ───────────────
  // DataTable stops click propagation inside this cell, so following the link
  // never also toggles the row open. Renders nothing for every other row —
  // an empty cell here reads as "no agreement", which is the truth.
  const rowActions = useMemo(
    () => ({
      // A noun header is what makes the square icon below legible without a
      // hover: the column says what the control is about.
      header: String(t("admin.bkInboxColAgreement")),
      // Sized for the HEADER, not the 34px icon: at 0.8 the label sat flush
      // against the table's right edge and pushed a 3px scroll.
      width: 1,
      render: (row: BookingRow) =>
        row.status === "ACCEPTED" && row.agreementId ? (
          <OpenAgreementButton
            compact
            slug={slug}
            agreementId={row.agreementId}
            label={String(t("admin.baOpenAgreement"))}
            nameSuffix={counterpartyOf(row)}
            testID={`booking-row-agreement-${row.id}`}
          />
        ) : null,
    }),
    [counterpartyOf, slug, t],
  );

  // ── Mobile card (DataTable card mode, <600px) ────────────────────────────
  const renderMobileCard = useCallback(
    (row: BookingRow) => {
      const sender = senderOf(row);
      const isAnonymous = sender?.kind === "anonymous";
      const undeliverable = undeliverableOf(row);
      const typeLabel =
        row.performerOwnerType === "organization"
          ? String(t("admin.bkInboxSenderOrg"))
          : String(t("admin.bkInboxSenderHuman"));
      const firstDate = row.preferredDates[0];
      const extraDates = row.preferredDates.length - 1;

      return (
        <YStack gap="$2" minWidth={0}>
          <XStack gap="$2" alignItems="center" minWidth={0}>
            <Text
              variant="bodySmall"
              weight="bold"
              flexBasis={0}
              flexGrow={1}
              flexShrink={1}
              minWidth={0}
              truncate
            >
              {isAnonymous
                ? sender.contactName
                : (row.performerDisplayName ?? typeLabel)}
            </Text>
          </XStack>
          {/* Multi-venue: the venue, on its own line and never truncated
              away — on a card this is the only thing that says WHICH inbox
              the request is in. */}
          {isMultiVenue && row.placeName ? (
            <Text
              variant="caption"
              weight="bold"
              textTransform="uppercase"
              letterSpacing={0.4}
              minWidth={0}
              truncate
            >
              {row.placeName}
            </Text>
          ) : null}
          {/* The rail takes the status chip's place on its OWN line, not in
              the header row: at 320px the card has ~178px of content and the
              header row already pins a content-sized item against a flexible
              name — a three-segment rail there would squeeze the sender to
              nothing. */}
          <BookingStageRail
            status={row.status}
            agreementStatus={row.agreementStatus}
            eventId={row.eventId}
            eventStatus={row.eventStatus}
            eventStartsAt={row.eventStartsAt}
            preferredDates={row.preferredDates}
            venueConfirmation={row.venueConfirmation}
            testIdBase={`booking-inbox-card-${row.id}`}
          />
          {/* Same slot order as the table row: the undelivered reply sits
              directly under the rail, ahead of holds and unread. */}
          {undeliverable ? (
            <BookingInquirerUndeliverableBadge
              status={undeliverable.status}
              contactName={undeliverable.contactName}
              testIdBase={`booking-inbox-card-${row.id}`}
            />
          ) : null}
          <BookingHoldSummary
            holds={row.holds}
            now={now}
            testIdBase={`booking-inbox-card-${row.id}`}
          />
          {/* Own line for the same reason. */}
          <UnreadMessagesBadge
            count={row.unreadMessageCount}
            testIdBase={`booking-inbox-card-${row.id}`}
            alignSelf="flex-start"
          />
          {hasOrgChrome ? (
            <Text
              variant="caption"
              tone={assigneeLabel(row).muted ? "muted" : undefined}
              minWidth={0}
              truncate
              testID={`booking-inbox-card-${row.id}-assignee`}
            >
              {String(t("admin.bkAssigneeCardLine", { name: assigneeLabel(row).text }))}
            </Text>
          ) : null}
          {tagChips(row, `booking-inbox-card-${row.id}`)}
          {isAnonymous && (
            <Text
              variant="caption"
              tone="muted"
              textTransform="uppercase"
              letterSpacing={0.4}
            >
              {String(t("admin.bkWsVenAnonSource"))}
            </Text>
          )}
          <XStack gap="$2" alignItems="center" flexWrap="wrap">
            <Text variant="caption" tone="muted">
              {firstDate
                ? `${fmt.dateTime(isoDateToLocal(firstDate), { dateStyle: "medium" })}${extraDates > 0 ? ` +${extraDates}` : ""}`
                : "—"}
            </Text>
            <Text variant="caption" tone="muted" aria-hidden>
              ·
            </Text>
            <Text variant="caption" tone="muted">
              {fmt.dateTime(new Date(row.createdAt), { dateStyle: "medium" })}
            </Text>
          </XStack>
          {row.genre || row.expectedDraw ? (
            <XStack gap="$3" alignItems="center" minWidth={0}>
              {row.genre ? (
                <Text variant="caption" tone="muted" minWidth={0} truncate>
                  {row.genre}
                </Text>
              ) : null}
              {row.expectedDraw ? (
                <XStack gap="$1" alignItems="center" flexShrink={0}>
                  <Users size={12} aria-hidden style={{ opacity: 0.5 }} />
                  <Text variant="caption" tone="muted">
                    {row.expectedDraw.toLocaleString()}
                  </Text>
                </XStack>
              ) : null}
            </XStack>
          ) : null}
          {/* Card mode renders no `rowActions` column, so the agreement route
              is mirrored here — otherwise it would exist on desktop only. */}
          {row.status === "ACCEPTED" && row.agreementId ? (
            <OpenAgreementButton
              fullWidth
              slug={slug}
              agreementId={row.agreementId}
              label={String(t("admin.baOpenAgreement"))}
              nameSuffix={counterpartyOf(row)}
              testID={`booking-card-agreement-${row.id}`}
            />
          ) : null}
        </YStack>
      );
    },
    [assigneeLabel, counterpartyOf, fmt, hasOrgChrome, isMultiVenue, now, slug, t, tagChips],
  );

  // ── Expanded detail panel ────────────────────────────────────────────────
  const renderExpandedRow = useCallback(
    (row: BookingRow) => {
      if (!expandedIds.has(row.id)) return null;
      const isOpenRequest = OPEN_BOOKING_STATUSES.includes(row.status);
      const declining = declineTargetId === row.id;
      const sender = senderOf(row);
      // Anonymous = unclaimed: once the submitter claims, the owner pair is
      // backfilled and the lens flips to "owned" — the row then renders as a
      // normal accepted request (agreement link and all).
      const isAnonymous = sender?.kind === "anonymous";
      const undeliverable = undeliverableOf(row);
      const canPlace = canPlaceHold(row);
      const inviteExpiry = inviteExpiryById[row.id] ?? null;

      return (
        <YStack
          gap="$3"
          padding="$4"
          borderTopWidth={1}
          borderTopColor="$borderColor"
          backgroundColor="$surfaceMuted"
        >
          {/* Multi-venue: the venue leads the detail. In a cross-venue inbox
              "who asked" is only half the question; "asked WHERE" is the
              other. */}
          {isMultiVenue && row.placeName && (
            <YStack gap="$1">
              <DetailLabel>{String(t("admin.bkWsColVenue"))}</DetailLabel>
              <Text variant="bodySmall" weight="bold">
                {row.placeName}
              </Text>
            </YStack>
          )}

          {/* Org workflow header (FR-015 / FR-017): who at the venue owns
              this request, and how the venue files it. Venue-internal — the
              act never sees either — and absent on human-owned venues, whose
              owner is implicitly the assignee. */}
          {hasOrgChrome && orgId ? (
            <XStack gap="$4" flexWrap="wrap" alignItems="flex-start" minWidth={0}>
              <YStack flexBasis={260} flexGrow={1} flexShrink={1} minWidth={0} maxWidth="100%">
                <AssigneePicker
                  orgId={orgId}
                  value={row.assigneeHumanId}
                  onChange={(next) => handleAssign(row, next)}
                  isPending={assignMutation.isPending}
                  testIdBase={`booking-assignee-${row.id}`}
                />
              </YStack>
              <YStack gap="$1" flexBasis={260} flexGrow={1} flexShrink={1} minWidth={0} maxWidth="100%">
                <DetailLabel>{String(t("admin.bkTagsLabel"))}</DetailLabel>
                <BookingTagInput
                  orgId={orgId}
                  value={row.tags.map((tag) => tag.id)}
                  onChange={(next) => handleSetTags(row, next)}
                  disabled={setTagsMutation.isPending}
                  testIdBase={`booking-tags-${row.id}`}
                />
              </YStack>
            </XStack>
          ) : null}

          {/* "Where is this booking" is the question the detail is opened to
              answer, and every field below it is evidence for that answer
              rather than a substitute for it. */}
          <BookingStageRail
            variant="full"
            status={row.status}
            agreementStatus={row.agreementStatus}
            eventId={row.eventId}
            eventStatus={row.eventStatus}
            eventStartsAt={row.eventStartsAt}
            preferredDates={row.preferredDates}
            venueConfirmation={row.venueConfirmation}
            testIdBase={`booking-inbox-detail-${row.id}`}
          />

          {/* The venue's line for this request (booking-holds FR-012) —
              directly under the rail, because a hold is a state of the
              request stage, not a leg.
              
              THIS USED TO BE `!isAnonymous && …`, on the reasoning that a
              hold notifies the act and an unclaimed sender has no account to
              notify. The notify half is true — and is exactly why it is not a
              reason to hide the line. `notify-booking-hold-intents` SKIPS the
              act leg for an unclaimed inquiry by design
              (`booking_holds.notify.anonymous_act_skipped`); no placement path
              refuses one, and the seed ships an anonymous PENDING request
              holding a date on purpose. So the hold in the Stage column was
              real, and the detail was the thing that lied: staff read
              "Oct 13 · 1st hold" in the list and found no holds section at
              all when they opened the row.

              Now the line renders whenever it EXISTS, for anyone. What the
              strip does not get for an unclaimed sender is the two actions the
              server will not honour end-to-end — see `unclaimedInquiry` —
              plus "Place hold": offering a NEW un-notifiable hold is a product
              expansion this fix deliberately does not make, so `canPlace`
              stays false there and the add-row is absent exactly as before. */}
          {(!isAnonymous && canPlace) || liveHolds(row.holds).length > 0 ? (
            <BookingHoldsStrip
              bookingRequestId={row.id}
              placeId={row.placeId}
              preferredDates={row.preferredDates}
              holds={row.holds}
              eventAdminSlug={slug}
              confirmOutcome={holdOutcomeById[row.id] ?? null}
              canPlace={canPlace && !isAnonymous}
              unclaimedInquiry={isAnonymous}
              // What "Send terms" / "Book without terms" are gated on
              // (booking-the-night FR-003 / FR-004; hold-booking-actions.ts) —
              // all server-derived on the list row (P5-fixes).
              requestStatus={row.status}
              agreementId={row.agreementId}
              agreementStatus={row.agreementStatus}
              builtFromEvent={row.builtFromEvent}
              bookingEvent={row.bookingEvent}
              termsNight={row.termsNight}
              bookWithoutTermsPayee={row.bookWithoutTermsPayee}
              hasBookedNight={row.hasBookedNight}
              placeName={row.placeName}
              // Several rows expand at once (`expandedIds` is a Set and
              // `toggleExpand` never clears it), so every strip's "Place hold"
              // is otherwise named identically to its neighbours'.
              nameSuffix={counterpartyOf(row)}
              onHoldsChanged={() => followRow(row.id)}
              onConfirmed={(outcome) => {
                setHoldOutcomeById((prev) => ({ ...prev, [row.id]: outcome }));
                // The server's answer, early: confirm accepts an open
                // request and mints the draft event, so the row is on the
                // Event tab before the refetch lands (same rule as accept
                // and create-event, and for the same one-round-trip flash).
                utils.bookingRequests.list.setData(listInput, (prev) =>
                  prev
                    ? {
                        ...prev,
                        requests: prev.requests.map((r) =>
                          r.id === row.id
                            ? {
                                ...r,
                                status: "ACCEPTED" as const,
                                eventId: outcome.eventId,
                                eventStatus: "DRAFT" as const,
                                eventStartsAt: null,
                                holds: r.holds.map((h) =>
                                  h.id === outcome.holdId
                                    ? { ...h, status: "CONFIRMED" as const }
                                    : outcome.releasedHoldIds.includes(h.id)
                                      ? { ...h, status: "RELEASED" as const }
                                      : h,
                                ),
                              }
                            : r,
                        ),
                      }
                    : prev,
                );
                setChosenTab("event");
                setExpandedIds((prev) => new Set(prev).add(row.id));
              }}
              testIdBase={`booking-holds-${row.id}`}
            />
          ) : null}

          {row.actName && (
            <YStack gap="$1">
              <DetailLabel>{String(t("admin.bkInboxActNameLabel"))}</DetailLabel>
              <Text variant="bodySmall" weight="bold">
                {row.actName}
              </Text>
            </YStack>
          )}

          <YStack gap="$1">
            <DetailLabel>{String(t("admin.bkInboxMessageLabel"))}</DetailLabel>
            <Text variant="bodySmall" style={{ whiteSpace: "pre-wrap" }}>
              {row.message}
            </Text>
          </YStack>

          <YStack gap="$1">
            <DetailLabel>{String(t("admin.bkInboxColDates"))}</DetailLabel>
            <Text variant="bodySmall">
              {row.preferredDates
                .map((d) =>
                  fmt.dateTime(isoDateToLocal(d), { dateStyle: "full" }),
                )
                .join(" · ")}
            </Text>
          </YStack>

          {/* Draw: the artist's self-reported estimate vs. platform-verified
              stats (FR-010). Both are shown, distinctly labeled, so a venue can
              weigh the pitch against the ticketing reality. */}
          <YStack gap="$2">
            <DetailLabel>{String(t("admin.bkInboxColDraw"))}</DetailLabel>
            <StatPair
              label={String(t("admin.bkInboxDrawEstimateLabel"))}
              value={
                row.expectedDraw != null
                  ? row.expectedDraw.toLocaleString()
                  : "—"
              }
            />
            {row.verifiedStatsSnapshot && (
              <YStack
                gap="$2"
                padding="$3"
                borderWidth={1}
                borderColor="$borderColor"
                backgroundColor="$surface"
              >
                <Text variant="caption" weight="bold">
                  {String(
                    t("admin.bkInboxVerifiedStatsAsOf", {
                      date: fmt.dateTime(
                        new Date(row.verifiedStatsSnapshot.computedAt),
                        { dateStyle: "medium" },
                      ),
                    }),
                  )}
                </Text>
                <XStack gap="$4" flexWrap="wrap">
                  <StatPair
                    label={String(t("admin.bkInboxStatShows"))}
                    value={row.verifiedStatsSnapshot.totalEventsPerformed.toLocaleString()}
                  />
                  <StatPair
                    label={String(t("admin.bkInboxStatAvgDraw"))}
                    value={
                      row.verifiedStatsSnapshot.avgDrawPerEvent != null
                        ? Math.round(
                            row.verifiedStatsSnapshot.avgDrawPerEvent,
                          ).toLocaleString()
                        : "—"
                    }
                  />
                  <StatPair
                    label={String(t("admin.bkInboxStatRefLink"))}
                    value={row.verifiedStatsSnapshot.refLinkTickets.toLocaleString()}
                  />
                  <StatPair
                    label={String(t("admin.bkInboxStatRepeatFans"))}
                    value={row.verifiedStatsSnapshot.repeatFanCount.toLocaleString()}
                  />
                </XStack>
                <Text variant="caption" tone="muted">
                  {String(
                    t("admin.bkInboxStatLast90Value", {
                      tickets:
                        row.verifiedStatsSnapshot.last90DayTickets.toLocaleString(),
                      events:
                        row.verifiedStatsSnapshot.last90DayEvents.toLocaleString(),
                    }),
                  )}
                </Text>
              </YStack>
            )}
          </YStack>

          {row.genre && (
            <YStack gap="$1">
              <DetailLabel>{String(t("admin.bkInboxColGenre"))}</DetailLabel>
              <Text variant="bodySmall">{row.genre}</Text>
            </YStack>
          )}

          {/* Compact pitch details — lineup + set length. */}
          {(row.lineupSize != null || row.setLengthMinutes != null) && (
            <XStack gap="$4" flexWrap="wrap">
              {row.lineupSize != null && (
                <StatPair
                  label={String(t("admin.bkInboxLineupLabel"))}
                  value={row.lineupSize.toLocaleString()}
                />
              )}
              {row.setLengthMinutes != null && (
                <StatPair
                  label={String(t("admin.bkInboxSetLengthLabel"))}
                  value={formatSetLength(row.setLengthMinutes)}
                />
              )}
            </XStack>
          )}

          {/* Fee ask — type + formatted amount (tabular), or "Negotiable". */}
          {row.feeType && (
            <YStack gap="$1">
              <DetailLabel>{String(t("admin.bkInboxFeeLabel"))}</DetailLabel>
              <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
                <Text variant="bodySmall">
                  {String(t(BOOKING_FEE_TYPE_LABEL_KEYS[row.feeType]))}
                </Text>
                {row.feeAmountCents != null && (
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {fmtCurrency(
                      fmt,
                      row.feeAmountCents,
                      row.feeCurrency ?? "usd",
                    )}
                  </Text>
                )}
              </XStack>
            </YStack>
          )}

          {/* Our email to this inquirer failed. Deliberately IMMEDIATELY
              above the contact block below, never in place of it: once our
              sending stops working the venue's own mail client is the
              remaining option, so the explanation and the address it points
              at have to read as one thing. */}
          {undeliverable ? (
            <BookingInquirerUndeliverableNotice
              status={undeliverable.status}
              at={undeliverable.at}
              contactEmail={undeliverable.contactEmail}
              contactName={undeliverable.contactName}
              testIdBase={`booking-inbox-detail-${row.id}`}
            />
          ) : null}

          {/* Contact email — anonymous inquiries only (FR-006): the venue's
              off-platform reply channel. Owned requests keep the in-platform
              flow and never show this. */}
          {isAnonymous && (
            <YStack gap="$1">
              <DetailLabel>{String(t("admin.bkWsVenAnonContact"))}</DetailLabel>
              <a
                href={`mailto:${sender.contactEmail}`}
                aria-label={String(
                  t("admin.bkWsVenAnonReplyAria", {
                    name: sender.contactName,
                  }),
                )}
                style={{ textDecoration: "none", minWidth: 0 }}
              >
                <XStack gap="$2" alignItems="center" minWidth={0}>
                  <Mail
                    size={12}
                    aria-hidden
                    style={{ opacity: 0.6, flexShrink: 0 }}
                  />
                  <Text
                    variant="bodySmall"
                    tone="accent"
                    minWidth={0}
                    style={{ overflowWrap: "anywhere" }}
                  >
                    {sender.contactEmail}
                  </Text>
                </XStack>
              </a>
              <Text variant="caption" tone="muted">
                {String(t("admin.bkWsVenAnonReplyHint"))}
              </Text>
            </YStack>
          )}

          {/* Contact phone — click-to-call. */}
          {row.contactPhone && (
            <YStack gap="$1">
              <DetailLabel>{String(t("admin.bkInboxPhoneLabel"))}</DetailLabel>
              <a
                href={`tel:${row.contactPhone.replace(/[^+0-9]/g, "")}`}
                style={{ textDecoration: "none", minWidth: 0 }}
              >
                <XStack gap="$2" alignItems="center" minWidth={0}>
                  <Phone
                    size={12}
                    aria-hidden
                    style={{ opacity: 0.6, flexShrink: 0 }}
                  />
                  <Text variant="bodySmall" tone="accent">
                    {row.contactPhone}
                  </Text>
                </XStack>
              </a>
            </YStack>
          )}

          {/* Tech / backline / rider needs — multiline like the message. */}
          {row.techNeeds && (
            <YStack gap="$1">
              <DetailLabel>{String(t("admin.bkInboxTechNeedsLabel"))}</DetailLabel>
              <Text variant="bodySmall" style={{ whiteSpace: "pre-wrap" }}>
                {row.techNeeds}
              </Text>
            </YStack>
          )}

          {/* Links — typed slots first, then any legacy generic links. */}
          {(() => {
            const typed: { labelKey: string; url: string }[] = [
              { labelKey: "admin.bkInboxLinkMusicLabel", url: row.linkMusic ?? "" },
              { labelKey: "admin.bkInboxLinkVideoLabel", url: row.linkVideo ?? "" },
              { labelKey: "admin.bkInboxLinkSocialLabel", url: row.linkSocial ?? "" },
              { labelKey: "admin.bkInboxLinkEpkLabel", url: row.linkEpk ?? "" },
            ].filter((l) => l.url.length > 0);
            const legacy = row.links.filter((l) => l.length > 0);
            if (typed.length === 0 && legacy.length === 0) return null;
            return (
              <YStack gap="$2">
                <DetailLabel>{String(t("admin.bkInboxLinksLabel"))}</DetailLabel>
                <YStack gap="$2">
                  {[
                    ...typed.map((link) => ({
                      key: link.labelKey,
                      label: String(t(link.labelKey)),
                      href: safeExternalHref(link.url),
                    })),
                    ...legacy.map((link, i) => ({
                      key: `legacy-${i}`,
                      label: null,
                      href: safeExternalHref(link),
                    })),
                  ].map((link) =>
                    link.href ? (
                      <YStack gap="$1" key={link.key}>
                        {link.label ? (
                          <Text
                            variant="caption"
                            tone="muted"
                            textTransform="uppercase"
                            letterSpacing={0.4}
                          >
                            {link.label}
                          </Text>
                        ) : null}
                        <a
                          href={link.href}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ textDecoration: "none", minWidth: 0 }}
                        >
                          <XStack gap="$2" alignItems="flex-start" minWidth={0}>
                            <ExternalLink
                              size={12}
                              aria-hidden
                              style={{ opacity: 0.6, flexShrink: 0, marginTop: 3 }}
                            />
                            <Text
                              variant="bodySmall"
                              tone="accent"
                              flexBasis={0}
                              flexGrow={1}
                              flexShrink={1}
                              minWidth={0}
                              style={{ overflowWrap: "anywhere" }}
                            >
                              {link.href}
                            </Text>
                          </XStack>
                        </a>
                      </YStack>
                    ) : null,
                  )}
                </YStack>
              </YStack>
            );
          })()}

          {row.status === "ACCEPTED" && isAnonymous && (
            // Accepted-but-unclaimed anonymous inquiry (FR-007): no Agreement
            // exists yet — the submitter was emailed an invite-to-claim link.
            // Resend needs place-scoped context, so the place inbox offers it
            // inline and the multi-venue scopes point at that inbox instead of
            // pretending there is nothing more to do.
            <YStack
              gap="$2"
              padding="$3"
              borderWidth={1}
              borderColor="$borderColor"
              backgroundColor="$surface"
            >
              <XStack gap="$2" alignItems="center">
                <MailCheck
                  size={14}
                  aria-hidden
                  style={{ opacity: 0.7, flexShrink: 0 }}
                />
                <Text
                  variant="caption"
                  weight="bold"
                  textTransform="uppercase"
                  letterSpacing={0.6}
                >
                  {String(t("admin.bkWsVenInviteSent"))}
                </Text>
              </XStack>
              <Text variant="bodySmall" tone="muted">
                {String(
                  t("admin.bkWsVenInviteBody", { name: sender.contactName }),
                )}
                {inviteExpiry
                  ? ` ${String(
                      t("admin.bkInboxInviteExpires", {
                        date: fmt.dateTime(inviteExpiry, {
                          dateStyle: "medium",
                        }),
                      }),
                    )}`
                  : ""}
              </Text>
              {isPlace ? (
                <>
                  {resendError?.id === row.id && (
                    <Text variant="bodySmall" tone="error" role="alert">
                      {resendError.message}
                    </Text>
                  )}
                  <XStack>
                    <Button
                      variant="secondary"
                      size="$2"
                      disabled={resendInviteMutation.isPending}
                      onPress={() => handleResendInvite(row)}
                      testID={`booking-resend-invite-${row.id}`}
                    >
                      {resendInviteMutation.isPending ? (
                        <Spinner size="sm" />
                      ) : (
                        String(t("admin.bkInboxResendInvite"))
                      )}
                    </Button>
                  </XStack>
                </>
              ) : (
                <>
                  <Text variant="caption" tone="muted">
                    {String(t("admin.bkWsVenInviteManage"))}
                  </Text>
                  {row.placeId ? (
                    <XStack>
                      <NextLinkAnchor
                        href={`/admin/${slug}/places/${row.placeId}/bookings`}
                        // `placeName` is nullable on the summary schema while
                        // `placeId` is not, and an empty interpolation would
                        // announce as "Open 's booking inbox". A generic noun
                        // keeps the sentence whole.
                        aria-label={String(
                          t("admin.bkWsVenueViewAria", {
                            venue:
                              row.placeName ??
                              String(t("admin.bkWsVenueFallback")),
                          }),
                        )}
                      >
                        <Button
                          tag="span"
                          variant="secondary"
                          size="$2"
                          aria-hidden
                          tabIndex={-1}
                          testID={`booking-invite-inbox-${row.id}`}
                        >
                          {String(t("admin.bkHubVenueView"))}
                        </Button>
                      </NextLinkAnchor>
                    </XStack>
                  ) : null}
                </>
              )}
            </YStack>
          )}

          {/* Stage-aware: once an event exists the terms strip and the
              "Open event" slot in the thread say where the booking is, and
              "a draft agreement was created" would be stale. */}
          {row.status === "ACCEPTED" && !isAnonymous && !row.eventId && (
            <XStack gap="$3" alignItems="center" flexWrap="wrap">
              <Text variant="bodySmall" tone="muted">
                {String(t("admin.baInboxAcceptedNote"))}
              </Text>
              {row.agreementId ? (
                <OpenAgreementButton
                  slug={slug}
                  agreementId={row.agreementId}
                  label={String(t("admin.baOpenAgreement"))}
                  nameSuffix={counterpartyOf(row)}
                  testID={`booking-open-agreement-${row.id}`}
                />
              ) : null}
            </XStack>
          )}

          {row.status === "DECLINED" && row.declineReason && (
            <Text variant="bodySmall" tone="muted">
              {String(
                t("admin.bkInboxDeclinedNote", { reason: row.declineReason }),
              )}
            </Text>
          )}

          {isOpenRequest && row.expiresAt && (
            <Text variant="caption" tone="muted">
              {String(
                t("admin.bkInboxExpires", {
                  date: fmt.dateTime(new Date(row.expiresAt), {
                    dateStyle: "medium",
                  }),
                }),
              )}
            </Text>
          )}

          {/* ── Conversation (booking-conversation FR-001..003 /
              venue-hierarchy FR-012) ──────────────────────────────────────
              Sits between the pitch and the decision, because it is where the
              date actually gets agreed.

              SHOWN FOR ANONYMOUS (UNCLAIMED) INQUIRIES TOO — the venue side is
              a full participant in that thread and always was: BOTH gates in
              `thread-access.ts` return on `side === "VENUE"` before reaching
              the unclaimed-inquiry refusal, which sits in the PERFORMER branch
              alone. Hiding this block was the UI making a rule the server does
              not, and it made the emailed-reply relay
              (`notify-booking-inquirer.ts`) unreachable: there was no composer
              to send from. What the venue writes here is stored on the request
              and mailed to the submitted address; the inquirer cannot write
              back into it, because the PERFORMER side stays unauthorized until
              they claim — that guard is load-bearing (it stops anyone who signs
              up with the inquirer's address from reading the venue's private
              replies) and is not ours to relax. `BookingInquirerEmailRelayNote`
              says all of that in the thread, so a venue can tell an in-app
              message from an email.

              WRITABLE AT EVERY STATUS — deliberately, and there is no prop to
              close it. The thread is the request's history, so "what happened
              with that Friday?" still has somewhere to go after a decline,
              withdrawal or expiry. Who may write is a server-side
              authorization question (thread-access.ts), never a status one. */}
          <YStack
            gap="$3"
            paddingTop="$3"
            borderTopWidth={1}
            borderTopColor="$borderColor"
          >
            {/* WHOSE EVENT decides whether the venue's shell can open it.
                The route `slug` is this inbox's entity — the agreement's
                venue counterparty — so `/admin/{slug}/events/{id}` is right
                only for a VENUE-owned event (PERFORM). A RENT / USE
                confirmation mints the event into the REQUESTER's admin
                (`venueConfirmation.ownerSide === "requester"`), where the
                venue has no edit access: that link would 403. Both the
                ledger's event entries and the next-step slot read the same
                answer, so neither can disagree with the other. */}
            <BookingThread
              bookingRequestId={row.id}
              side="VENUE"
              // An unclaimed inquiry has no act and — once the shadow owner
              // pair is attached — no `performerDisplayName` either, so the
              // thread would fall back to the generic "Performer" for a
              // conversation the venue is having with a named person. The
              // submitted contact name is who they are until they claim.
              counterpartyLabel={
                row.actName ??
                row.performerDisplayName ??
                (isAnonymous ? sender.contactName : null)
              }
              eventAdminSlug={slug}
              eventLinksEnabled={
                row.venueConfirmation.ownerSide !== "requester"
              }
              // Gates the terms strip: null on an open pitch or a decline,
              // so no agreement read is issued for those rows at all.
              agreementId={row.agreementId}
              // FINALIZE IN THE CHAT. Mounted only once an agreement exists;
              // the action itself decides whether it is offerable (ACCEPTED,
              // venue side) or already done (event exists → Open event).
              nextStep={
                <>
                {row.agreementId ? (
                  <CreateEventFromBookingAction
                    agreementId={row.agreementId}
                    bookingRequestId={row.id}
                    eventId={row.eventId}
                    eventHref={
                      row.eventId &&
                      row.venueConfirmation.ownerSide !== "requester"
                        ? `/admin/${slug}/events/${row.eventId}`
                        : null
                    }
                    requesterOwned={
                      row.venueConfirmation.ownerSide === "requester"
                    }
                    venueName={row.placeName}
                    testIdBase={`booking-thread-${row.id}`}
                    outcome={createOutcomeById[row.id] ?? null}
                    // Follow the row to the Event tab, detail still open —
                    // the same "not gone, moved" rule accept uses.
                    onEventCreated={(created) => {
                      setCreateOutcomeById((prev) => ({
                        ...prev,
                        [row.id]: created,
                      }));
                      // Write the event onto the cached row BEFORE moving
                      // the view — the same rule accept uses. Switching
                      // first left the Event tab on its empty state for one
                      // round trip, unmounting the expanded thread and the
                      // notice that had just taken focus. The mutation has
                      // succeeded, so this is the server's answer, early;
                      // the refetch fills in the start date.
                      utils.bookingRequests.list.setData(listInput, (prev) =>
                        prev
                          ? {
                              ...prev,
                              requests: prev.requests.map((r) =>
                                r.id === row.id
                                  ? {
                                      ...r,
                                      eventId: created.result.eventId,
                                      eventStatus: "DRAFT" as const,
                                      eventStartsAt: null,
                                    }
                                  : r,
                              ),
                            }
                          : prev,
                      );
                      setChosenTab("event");
                    }}
                  />
                ) : null}
                {/* THE STAMP, beside the mint. Decides for itself whether
                    there is anything to offer (an unconfirmed or withdrawn
                    event; an accepted, event-less booking to confirm — which
                    mints; a requester-owned confirmed event to withdraw) and
                    renders nothing otherwise. Venue side only: this inbox.
                    Confirm is offered only for a request built from an event
                    (booking-the-night FR-011); Withdraw is per event and
                    stays (`venueConfirmationOffer`). */}
                <VenueConfirmationActions
                  bookingRequestId={row.id}
                  requestStatus={row.status}
                  agreementId={row.agreementId}
                  intent={row.intent}
                  // The date the rail above shows — what Confirm vouches for.
                  eventStartsAt={row.eventStartsAt}
                  venueConfirmation={row.venueConfirmation}
                  placeId={row.placeId}
                  builtFromEvent={isProvenEventFirstRow(row)}
                  testIdBase={`booking-thread-${row.id}`}
                />
                </>
              }
              // ANONYMOUS ONLY: this thread is a relay to email, and the
              // venue cannot tell that from the composer. Passed the same
              // `undeliverableOf` answer that drives the notice higher in this
              // panel, so a bounced inquiry says "this will not reach them"
              // right where the next message would be typed instead of
              // inviting one into a dead channel.
              notice={
                isAnonymous ? (
                  <BookingInquirerEmailRelayNote
                    contactName={sender.contactName}
                    contactEmail={sender.contactEmail}
                    undeliverable={undeliverable !== null}
                    testIdBase={`booking-thread-${row.id}`}
                  />
                ) : null
              }
              testIdBase={`booking-thread-${row.id}`}
            />
          </YStack>

          {isOpenRequest && !declining && (
            <XStack gap="$2" flexWrap="wrap">
              <Button
                variant="primary"
                size="$2"
                disabled={respondMutation.isPending}
                onPress={() => setAcceptTargetId(row.id)}
                testID={`booking-accept-${row.id}`}
              >
                {String(t("admin.bkInboxAccept"))}
              </Button>
              <Button
                variant="secondary"
                size="$2"
                disabled={respondMutation.isPending}
                onPress={() => {
                  setDeclineTargetId(row.id);
                  setDeclineReason("");
                }}
                testID={`booking-decline-${row.id}`}
              >
                {String(t("admin.bkInboxDecline"))}
              </Button>
            </XStack>
          )}

          {isOpenRequest && declining && (
            <YStack
              gap="$2"
              padding="$3"
              borderWidth={1}
              borderColor="$borderColor"
              backgroundColor="$surface"
            >
              <Text variant="bodySmall" weight="bold">
                {String(t("admin.bkInboxDeclineReasonLabel"))}
              </Text>
              <TextInput
                value={declineReason}
                onChangeText={setDeclineReason}
                placeholder={String(t("admin.bkInboxDeclineReasonPlaceholder"))}
                fullWidth
                aria-label={String(t("admin.bkInboxDeclineReasonLabel"))}
                testId={`booking-decline-reason-${row.id}`}
              />
              <Text variant="caption" tone="muted">
                {String(t("admin.bkInboxDeclineReasonHint"))}
              </Text>
              <XStack gap="$2" justifyContent="flex-end" flexWrap="wrap">
                <Button
                  variant="ghost"
                  size="$2"
                  disabled={respondMutation.isPending}
                  onPress={() => {
                    setDeclineTargetId(null);
                    setDeclineReason("");
                  }}
                >
                  {String(t("common.cancel"))}
                </Button>
                <Button
                  variant="destructive"
                  size="$2"
                  disabled={
                    declineReason.trim().length < 3 || respondMutation.isPending
                  }
                  onPress={() => handleDecline(row)}
                  testID={`booking-decline-confirm-${row.id}`}
                >
                  {respondMutation.isPending ? (
                    <Spinner size="sm" />
                  ) : (
                    String(t("admin.bkInboxDeclineConfirm"))
                  )}
                </Button>
              </XStack>
            </YStack>
          )}
        </YStack>
      );
    },
    [
      assignMutation.isPending,
      counterpartyOf,
      createOutcomeById,
      declineReason,
      declineTargetId,
      expandedIds,
      followRow,
      fmt,
      handleAssign,
      handleDecline,
      handleResendInvite,
      handleSetTags,
      hasOrgChrome,
      holdOutcomeById,
      inviteExpiryById,
      isMultiVenue,
      isPlace,
      listInput,
      orgId,
      resendError,
      resendInviteMutation.isPending,
      respondMutation.isPending,
      setTagsMutation.isPending,
      slug,
      t,
      utils.bookingRequests.list,
    ],
  );

  // ── Place-scope chrome ───────────────────────────────────────────────────
  const placeHeader = isPlace ? (
    <>
      <YStack gap="$1">
        <Text
          variant="h3"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={-0.5}
        >
          {String(t("admin.bkInboxTitle"))}
        </Text>
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.bkInboxSubtitle"))}
        </Text>
      </YStack>
      {/* FIRST on the page, above the tabs. This is the switch that decides
          whether this inbox can ever fill up, so it belongs where a venue
          comes to deal with bookings — not inside the public page editor's
          collapsed Page settings drawer, which is where it was and where
          nobody found it. */}
      {placeId ? <BookingAcceptanceToggle placeId={placeId} /> : null}
      {/* DIRECTLY UNDER the booking switch (community-listings-at-claimed-
          venues FR-005: "reachable later from the place's admin settings
          alongside the booking toggle"). It belongs here rather than in a
          community-flavoured corner of the admin because accepting community
          listings BLOCKS their slot for booking requests — the two switches
          decide the same calendar, so they are read together. */}
      {placeId ? <CommunityListingAcceptanceToggle placeId={placeId} /> : null}
    </>
  ) : null;

  // The place page owns its container; the org workspace supplies one.
  const Frame = isPlace ? PageContainer : YStack;
  const frameProps = isPlace ? {} : { gap: "$3" as const };

  // ── Error state ──────────────────────────────────────────────────────────
  // The acceptance switch rides along deliberately: if the request list is
  // down, turning requests OFF is exactly the thing a venue may still need to
  // do, and it is driven by a different query.
  if (listQuery.error) {
    return (
      <Frame {...frameProps}>
        {placeHeader}
        <Text variant="body" tone="error">
          {formatErrorMessage(listQuery.error, t)}
        </Text>
        <XStack>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => void listQuery.refetch()}
            testID="booking-inbox-retry"
          >
            {String(t("admin.placesRetry"))}
          </Button>
        </XStack>
      </Frame>
    );
  }

  // Three different emptinesses, and conflating them is how a venue with five
  // open requests gets told it has none. "Nothing at all" is an ONBOARDING
  // moment; "nothing for THIS venue" points at the filter; "nothing on this
  // tab" points at the other tabs.
  const hasAnyRequest = allRequests.length > 0;
  const emptyBodyKey =
    (calendarFilter !== null ||
      assigneeFilter !== "all" ||
      tagFilter.length > 0) &&
    venueScoped.length === 0
      ? "admin.bkWsVenEmptyFiltered"
      : TAB_EMPTY_KEYS[tab];

  const emptyState = hasAnyRequest ? (
    <YStack
      gap="$2"
      alignItems="center"
      justifyContent="center"
      paddingVertical="$7"
      paddingHorizontal="$4"
      borderWidth={2}
      borderColor="$borderColor"
    >
      <Inbox size={28} aria-hidden style={{ opacity: 0.3 }} />
      <Text variant="body" tone="muted" textAlign="center" maxWidth={380}>
        {String(t(emptyBodyKey))}
      </Text>
    </YStack>
  ) : isPlace ? (
    <YStack
      gap="$3"
      alignItems="center"
      justifyContent="center"
      paddingVertical="$8"
      paddingHorizontal="$4"
      borderWidth={2}
      borderColor="$borderColor"
    >
      <Inbox size={36} aria-hidden style={{ opacity: 0.3 }} />
      <Text variant="h4" weight="bold" textAlign="center">
        {String(t("admin.bkInboxEmptyTitle"))}
      </Text>
      {/* Name the ONE condition that is actually unmet. This used to read
          "once your venue is verified and accepting them. Check the venue page
          settings." — two conditions, neither confirmed, and a CTA into a
          collapsed drawer that never said the switch was inside it. Rendered
          only once the place is loaded: until then we do not know which
          sentence is true, and a guess is what caused the original bug. */}
      {place ? (
        <Text variant="body" tone="muted" textAlign="center" maxWidth={380}>
          {String(
            t(
              !isPlaceVerified
                ? "admin.bkInboxEmptyBodyUnverified"
                : acceptsRequests === false
                  ? "admin.bkInboxEmptyBodyOff"
                  : "admin.bkInboxEmptyBodyOn",
            ),
          )}
        </Text>
      ) : null}
      {/* Verification is the one unmet condition this page CANNOT fix inline —
          the switch above is already the fix for "turned off", so pointing a
          button at a control 200px higher would be noise. */}
      {place && !isPlaceVerified ? (
        <NextLinkAnchor
          href={`/admin/${slug}/places/${placeId}/settings#verification`}
          // The anchor is the control and carries the name: Tamagui's Button
          // emits `role="button" tabindex="0"` even with `tag="span"`, so left
          // alone it is an interactive descendant of a link plus a second tab
          // stop on the same rectangle.
          aria-label={String(t("admin.bkInboxEmptyVerifyCta"))}
        >
          <Button
            tag="span"
            variant="secondary"
            size="$2"
            aria-hidden
            tabIndex={-1}
            testID="booking-inbox-verify-cta"
          >
            {String(t("admin.bkInboxEmptyVerifyCta"))}
          </Button>
        </NextLinkAnchor>
      ) : null}
    </YStack>
  ) : (
    <YStack
      gap="$3"
      alignItems="center"
      justifyContent="center"
      paddingVertical="$8"
      paddingHorizontal="$4"
      borderWidth={2}
      borderColor="$borderColor"
    >
      <Inbox size={36} aria-hidden style={{ opacity: 0.3 }} />
      <Text variant="h4" weight="bold" textAlign="center">
        {String(t("admin.bkWsVenEmptyTitle"))}
      </Text>
      <Text variant="body" tone="muted" textAlign="center" maxWidth={380}>
        {String(t("admin.bkWsVenEmptyBody"))}
      </Text>
      <NextLinkAnchor href={`/admin/${slug}/places`}>
        <Button tag="span" variant="secondary" size="$2">
          {String(t("admin.bkWsVenEmptyCta"))}
        </Button>
      </NextLinkAnchor>
    </YStack>
  );

  return (
    <Frame {...frameProps}>
      {placeHeader}

      {isMultiVenue ? (
        <BookingCalendarFilterBar
          slug={slug}
          venues={venues}
          truncated={truncated}
          selectedCalendarIds={selectedCalendarIds}
          onSelect={setSelectedCalendarIds}
          isLoading={venuesLoading}
          isError={venuesError}
          onRetry={onRetryVenues ?? (() => undefined)}
        />
      ) : null}

      {/* Org workflow filters (FR-015 / FR-017): by assignee and by tag.
          Narrow the SAME set the tabs count — see `venueScoped`. */}
      {hasOrgChrome && orgId ? (
        <XStack gap="$3" flexWrap="wrap" alignItems="flex-start" minWidth={0} data-testid="booking-inbox-org-filters">
          <YStack gap="$1" flexBasis={220} flexGrow={0} flexShrink={1} minWidth={0} maxWidth="100%">
            <DetailLabel>{String(t("admin.bkInboxFilterAssignee"))}</DetailLabel>
            <StyledSelect
              value={
                assigneeFilter === "all"
                  ? ASSIGNEE_ALL
                  : assigneeFilter === "unassigned"
                    ? ASSIGNEE_NONE
                    : assigneeFilter.humanId
              }
              options={[
                { value: ASSIGNEE_ALL, label: String(t("admin.bkInboxFilterAssigneeAll")) },
                { value: ASSIGNEE_NONE, label: String(t("admin.bkAssigneeUnassigned")) },
                ...members.editors.map((m) => ({
                  value: m.humanId,
                  label: m.name ?? m.email ?? String(t("admin.bkAssigneeUnnamed")),
                })),
              ]}
              onChange={(next) =>
                setAssigneeFilter(
                  next === ASSIGNEE_ALL
                    ? "all"
                    : next === ASSIGNEE_NONE
                      ? "unassigned"
                      : { humanId: next },
                )
              }
              size="sm"
              fullWidth
              ariaLabel={String(t("admin.bkInboxFilterAssignee"))}
              testId="booking-inbox-filter-assignee"
            />
          </YStack>
          <YStack gap="$1" flexBasis={280} flexGrow={1} flexShrink={1} minWidth={0} maxWidth="100%">
            <DetailLabel>{String(t("admin.bkInboxFilterTags"))}</DetailLabel>
            <BookingTagInput
              orgId={orgId}
              value={tagFilter}
              onChange={setTagFilter}
              allowCreate={false}
              placeholder={String(t("admin.bkInboxFilterTagsPlaceholder"))}
              ariaLabel={String(t("admin.bkInboxFilterTags"))}
              testIdBase="booking-inbox-filter-tags"
            />
          </YStack>
        </XStack>
      ) : null}

      {/* A pressed-toggle group, not a tablist, on BOTH surfaces. The org
          workspace already owns the page's one tablist, and the place page
          gets the same control so the two inboxes read identically. Wraps as
          individually-outlined chips at 320px — see StatusSegments. */}
      <StatusSegments<BookingInboxTab>
        value={tab}
        onChange={chooseTab}
        ariaLabel={String(t("admin.bkWsFilterLabel"))}
        testIdBase="booking-inbox-tab"
        segments={BOOKING_INBOX_TABS.map((key) => ({
          key,
          label: `${String(t(TAB_LABEL_KEYS[key]))} (${tabCounts[key]})`,
        }))}
      />

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(row) => row.id}
        isLoading={listQuery.isLoading}
        emptyState={emptyState}
        onRowPress={toggleExpand}
        renderExpandedRow={renderExpandedRow}
        renderMobileCard={renderMobileCard}
        rowActions={rowActions}
        // Borderless panel with no scrolling ancestor — restore DataTable's
        // own overflow wrapper for scoped horizontal panning.
        scrollContainer
        testIdBase="booking-inbox-table"
      />

      {/* Setup, so it sits after the work — see the section's own docblock for
          why it followed the acceptance switch onto this page. */}
      {isPlace && placeId ? (
        <BookingEmbedSection
          placeId={placeId}
          slug={slug}
          acceptsBookingRequests={acceptsRequests}
        />
      ) : null}

      <ConfirmDialog
        open={acceptTargetId !== null}
        onConfirm={handleAccept}
        onCancel={() => setAcceptTargetId(null)}
        title={String(t("admin.bkInboxAcceptConfirmTitle"))}
        description={
          // Anonymous inquiry (FR-007): accepting sends an invite-to-claim
          // email — the Agreement is only created once the sender claims.
          acceptTargetSender?.kind === "anonymous"
            ? String(
                t("admin.bkWsVenAcceptAnonConfirm", {
                  name: acceptTargetSender.contactName,
                }),
              )
            : String(t("admin.bkInboxAcceptConfirmBody"))
        }
        confirmLabel={
          acceptTargetSender?.kind === "anonymous"
            ? String(t("admin.bkWsVenAcceptAnonCta"))
            : String(t("admin.bkInboxAccept"))
        }
        cancelLabel={String(t("common.cancel"))}
        loading={respondMutation.isPending}
        loadingLabel={String(t("common.loading"))}
      />
    </Frame>
  );
}

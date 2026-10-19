"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  Spinner,
  Text,
  TextInput,
  useFormatters,
  useTranslations,
} from "@th/ui";
import { MessageSquare, Paperclip, RefreshCw, Send } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { BookingSystemEntryRow } from "./BookingSystemEntryRow";
import {
  adminAgreementHref,
  standaloneAgreementHref,
} from "@/lib/agreement-routes";

import { BookingTermsStrip } from "./BookingTermsStrip";
import { describeBookingSystemEntry } from "./booking-system-entry";

// ─────────────────────────────────────────────────────────────────────────────
// Booking request thread (booking-conversation 2026-07-14 FR-001..003 /
// venue-hierarchy FR-012).
//
// THE REQUEST IS THE THREAD — this is where dates get agreed, so it mounts
// inside the request's own detail panel rather than on a route of its own.
// One component serves both sides; `side` is the caller's DECLARED side and is
// re-verified server-side on every call (thread-access.ts), so it is a UI
// input, not an authorization claim.
//
// PAGING: the procedure returns a cursor page OLDEST-FIRST, so page 1 is the
// oldest messages and the cursor walks forward toward the newest. A chat that
// showed only page 1 would hide the most recent — and the most recent is the
// whole point of this surface. The component therefore walks the cursor to the
// end (bounded by MAX_PAGES) and renders the accumulated thread. Real threads
// are far under one page; the walk exists so a long one is CORRECT rather than
// silently truncated.
//
// ALWAYS WRITABLE: there is no status gate here, and adding one back would be
// a regression. The composer used to disappear at DECLINED / WITHDRAWN /
// EXPIRED, which meant the moment a booking ended the two parties lost the
// only channel they had for it — "what happened with that Friday?" had nowhere
// to go once the row went terminal. The thread IS the booking's history, so it
// stays writable at every status; who may write is decided server-side by the
// authorization gates alone (thread-access.ts). Status still governs the
// BOOKING (accept / decline / withdraw keep their own CAS guards) — just never
// the conversation about it.
//
// THE THREAD IS A LEDGER, not only a chat. Rows with `authorSide === "SYSTEM"`
// are LIFECYCLE ENTRIES written by the server in the same transaction as the
// transition they record (accepted, agreement sent for review, event created,
// …). They carry an EMPTY `body` and a `systemKind` + `systemData` pair instead,
// and render as an unboxed line rather than a bubble — see
// `BookingSystemEntryRow`. Three consequences live in this file:
//   - entries NEVER count toward unread and are never stamped read (the server
//     excludes them from both `countUnreadByRequest` and `markRead`, so a local
//     derivation that included them would disagree with the list-row chip);
//   - an entry whose kind this build does not recognize is SKIPPED, never
//     rendered as a raw key or an empty bubble;
//   - the event link needs an admin slug the thread cannot derive on its own,
//     so it is a caller-supplied prop and simply absent when unavailable.
//
// THE TERMS ARE IN THE ROOM. A booking's prose and its binding header used to
// live on two different pages, and this one never showed the header — so an act
// and a venue agreed "Sep 25 works" in writing directly underneath a
// `proposedDate` of Sep 18 that neither of them could see, and the event was
// built from Sep 18. `BookingTermsStrip` (mounted just above the composer, at
// the junction between the newest message and the next one) closes that gap by
// SHOWING the header; it never parses message text looking for dates. Mounted
// only when the caller passes an `agreementId`, so a request with no agreement
// never creates the query at all — see that file's docblock.
//
// ATTACHMENTS are READ-ONLY here, deliberately: riders/stage plots are listed
// (name, size, when) but there is no add/delete. `attachments.add` takes a
// `storageKey` that the upload infrastructure is supposed to mint under
// `booking-requests/{id}/…`, and no procedure mints one yet. Shipping an
// uploader against a key this component invented would either 400 on the
// use case's prefix `superRefine` or register a key with no bytes behind it.
// See the report's follow-ups.
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors the use case's `BOOKING_MESSAGE_MAX`. */
const BODY_MAX = 4000;
const PAGE_SIZE = 50;
/** Safety stop on the cursor walk — 500 messages is far past any real thread. */
const MAX_PAGES = 10;

export type BookingThreadSide = "VENUE" | "PERFORMER";

type ThreadMessage = {
  id: string;
  bookingRequestId: string;
  authorSide: "VENUE" | "PERFORMER" | "SYSTEM";
  authorHumanId: string | null;
  body: string;
  /**
   * SYSTEM-entry discriminator; null on a human message. A plain `string`, not
   * the `BookingSystemEntryKind` union, on purpose: a row written by a newer
   * build can carry a kind this one has never heard of, and the renderer skips
   * what it does not recognize rather than failing the page.
   */
  systemKind: string | null;
  /** Per-kind params for the entry's copy. Timestamps inside are ISO strings. */
  systemData: Record<string, unknown> | null;
  readAt: Date | null;
  createdAt: Date;
};

/**
 * Unread means "a HUMAN is waiting on you" — the exact rule the server applies
 * in `countUnreadByRequest`. SYSTEM entries are excluded there and are never
 * stamped by `markRead`, so any local derivation that swept them in would light
 * up the in-thread badge for rows the list-row chip counts as zero, and would
 * paint a `readAt` the server never writes.
 */
function isUnreadCounterpartyMessage(
  message: ThreadMessage,
  side: BookingThreadSide,
): boolean {
  return (
    message.authorSide !== "SYSTEM" &&
    message.authorSide !== side &&
    !message.readAt
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BookingThread({
  bookingRequestId,
  side,
  /** Who the other party is, for the empty state and message attribution. */
  counterpartyLabel,
  /**
   * Admin slug the EVENT created from this booking lives under
   * (`/admin/{slug}/events/{id}`). A caller-supplied prop because the thread
   * cannot derive it: the event is owned by the agreement's venue counterparty,
   * and the messages list projects no owner at all. The two admin inboxes are
   * already mounted inside that entity's shell, so their route `slug` IS the
   * owner's admin slug; the performer's own sent-requests list is not, and the
   * performer has no admin access to the venue's events either — so it passes
   * nothing and the event entries render WITHOUT a link rather than with one
   * that 404s.
   */
  eventAdminSlug,
  /**
   * Whether `eventAdminSlug` can open THIS booking's event at all. False when
   * the event is the REQUESTER's (RENT / USE — `venueConfirmation.ownerSide`
   * on the inbox row): the slug is still the venue's shell, and still right
   * for the agreement link, but `/admin/{slug}/events/{id}` would 403. The
   * ledger's `booking_event.created` entry then renders without a link. The
   * entry's own `systemData` carries no owner, so the thread cannot decide
   * this itself.
   */
  eventLinksEnabled = true,
  /**
   * The Agreement this request produced (`BookingRequest.agreementId`, already
   * projected onto every list row), or null when the request has not minted
   * one — an open pitch, a decline, an unclaimed anonymous inquiry.
   *
   * IT IS THE FETCH GATE, not a hint. `BookingTermsStrip` is MOUNTED only when
   * this is non-null, so a thread with no agreement never creates the
   * `bookingAgreements.get` hook — no query key, no cache entry, nothing to
   * re-enable by accident — and renders no frame of any kind. A nullable prop
   * rather than a fetch inside the strip because the caller already has the
   * answer: making the thread ask for it would fire one request per opened
   * booking just to learn there is nothing to show.
   */
  agreementId,
  /**
   * The NEXT STEP, rendered between the terms strip and the composer — the
   * one slot in the thread where "what happens now" belongs. The venue inbox
   * puts "Create event from this booking" here (`CreateEventFromBookingAction`)
   * so finalizing happens in the conversation, next to the terms it is built
   * from, instead of on a different page. Caller-owned because the thread
   * serves both sides and the performer has no such step.
   */
  nextStep,
  /**
   * A standing fact about THIS thread's delivery, rendered under the heading
   * and above the messages — the first thing read after "Conversation", because
   * it changes what pressing Send means.
   *
   * The one caller today is the venue inbox on an unclaimed anonymous inquiry,
   * where the thread is a RELAY to email rather than an in-app chat
   * (`BookingInquirerEmailRelayNote`). Caller-owned for the same reason
   * `nextStep` is: the thread serves both sides and cannot know which of them
   * is looking, and the anonymity lens that answers it lives in the inbox.
   */
  notice,
  testIdBase = "booking-thread",
}: {
  bookingRequestId: string;
  side: BookingThreadSide;
  counterpartyLabel?: string | null;
  eventAdminSlug?: string | null;
  eventLinksEnabled?: boolean;
  agreementId?: string | null;
  nextStep?: ReactNode;
  notice?: ReactNode;
  testIdBase?: string;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();

  const [cursor, setCursor] = useState<string | null>(null);
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [body, setBody] = useState("");
  const [postError, setPostError] = useState<string | null>(null);
  /**
   * Cursor keys already ADVANCED past. A ref, not state, and separate from the
   * merge below: the merge must run on every delivery (a refetch of the last
   * page is how a newly-arrived counterparty message gets in), while the
   * advance must run exactly once per page or the walk loops forever.
   */
  const advancedRef = useRef<Set<string>>(new Set());

  // A new request means a new thread — drop everything, don't merge.
  useEffect(() => {
    setCursor(null);
    advancedRef.current = new Set();
    setMessages([]);
    setBody("");
    setPostError(null);
  }, [bookingRequestId]);

  const listQuery = trpc.bookingRequests.messages.list.useQuery(
    { bookingRequestId, side, limit: PAGE_SIZE, cursor },
    { enabled: Boolean(bookingRequestId), staleTime: 10_000, retry: 1 },
  );

  const page = listQuery.data;

  // MERGE — idempotent by message id, and returns the SAME array reference
  // when nothing is new. That identity check is load-bearing: `data` is a
  // fresh object on some deliveries, so an unconditional `setMessages` here
  // would re-render → re-run → render forever.
  useEffect(() => {
    if (!page) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const added = page.items.filter((m) => !seen.has(m.id));
      return added.length ? [...prev, ...added] : prev;
    });
  }, [page]);

  // ADVANCE — at most once per cursor, and never past MAX_PAGES.
  useEffect(() => {
    if (!page?.nextCursor) return;
    const key = cursor ?? "__first__";
    if (advancedRef.current.has(key)) return;
    if (advancedRef.current.size >= MAX_PAGES) return;
    advancedRef.current.add(key);
    setCursor(page.nextCursor);
  }, [page, cursor]);

  const isWalking =
    Boolean(page?.nextCursor) && advancedRef.current.size < MAX_PAGES;
  const isLoading = listQuery.isLoading || isWalking;

  // ── Unread (FR-003) ────────────────────────────────────────────────────
  // Derived from the messages themselves — `readAt` is null on a counterparty
  // message this side has not stamped yet. (`BookingRequest.lastMessageAt` is
  // bumped server-side but is not projected by the list procedures, so it
  // cannot drive this.) SYSTEM entries are excluded — see
  // `isUnreadCounterpartyMessage`.
  const unreadCount = useMemo(
    () => messages.filter((m) => isUnreadCounterpartyMessage(m, side)).length,
    [messages, side],
  );

  const newest = messages.length ? messages[messages.length - 1] : null;

  const markReadMutation = trpc.bookingRequests.messages.markRead.useMutation({
    retry: false,
    meta: { silent: true },
  });

  // Stamp read once per newest-message-id. The thread is only mounted when the
  // operator has actually opened the request, so mounting IS reading.
  const stampedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!newest || unreadCount === 0) return;
    if (stampedRef.current === newest.id) return;
    stampedRef.current = newest.id;
    markReadMutation.mutate(
      {
        bookingRequestId,
        side,
        upToCreatedAt: new Date(newest.createdAt),
      },
      {
        onSuccess: () => {
          // Reflect the stamp locally; a refetch would restart the walk.
          const upTo = new Date(newest.createdAt).getTime();
          const now = new Date();
          // Same predicate as the count above — the patch must be the EXACT
          // complement of what the server stamps, or an entry ends up wearing a
          // read receipt the database will never have.
          setMessages((prev) =>
            prev.map((m) =>
              isUnreadCounterpartyMessage(m, side) &&
              new Date(m.createdAt).getTime() <= upTo
                ? { ...m, readAt: now }
                : m,
            ),
          );
          // The LIST-ROW unread chip is fed by `bookingRequests.list`, a
          // different query key — and this component does NOT unmount when a
          // row collapses (the thread renders inside the still-mounted list).
          // Without this the row keeps claiming unread mail directly above the
          // thread the operator just read, for the rest of the session:
          // `refetchOnWindowFocus` is off globally and both list queries hold a
          // 15s staleTime that nothing re-triggers. Safe to invalidate here —
          // the server has confirmed the stamp, and this does not touch
          // `messages.list`, so the cursor walk is not restarted.
          void utils.bookingRequests.list.invalidate();
        },
        // A failed read-stamp is cosmetic — never surface it.
        onError: () => {
          stampedRef.current = null;
        },
      },
    );
    // markReadMutation and the `utils` proxy both churn identity every render;
    // keying on the newest id is what makes this fire exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newest?.id, unreadCount, bookingRequestId, side]);

  // ── Post ───────────────────────────────────────────────────────────────
  const postMutation = trpc.bookingRequests.messages.post.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const trimmed = body.trim();
  const canSend = trimmed.length > 0 && trimmed.length <= BODY_MAX;

  const handleSend = useCallback(() => {
    if (!canSend || postMutation.isPending) return;
    setPostError(null);
    postMutation.mutate(
      { bookingRequestId, side, body: trimmed },
      {
        onSuccess: (message) => {
          setBody("");
          // Append locally rather than refetching: a refetch restarts the
          // cursor walk from the oldest page.
          setMessages((prev) =>
            prev.some((m) => m.id === message.id)
              ? prev
              : [...prev, message as ThreadMessage],
          );
          // The counterparty's inbox badge is a different query key.
          void utils.bookingRequests.countOpen.invalidate();
        },
        onError: (err) => setPostError(formatErrorMessage(err, t)),
      },
    );
  }, [
    canSend,
    postMutation,
    bookingRequestId,
    side,
    trimmed,
    utils.bookingRequests.countOpen,
    t,
  ]);

  // ── Attachments (read-only — see the module note) ───────────────────────
  const attachmentsQuery = trpc.bookingRequests.attachments.list.useQuery(
    { bookingRequestId, side },
    { enabled: Boolean(bookingRequestId), staleTime: 30_000, retry: 1 },
  );
  const attachments = attachmentsQuery.data ?? [];

  // SYSTEM rows never reach this — they render as ledger entries, which carry
  // no author at all.
  const authorLabel = useCallback(
    (message: ThreadMessage): string => {
      if (message.authorSide === side) return String(t("booking.threadYou"));
      return (
        counterpartyLabel ??
        String(
          t(
            side === "VENUE"
              ? "booking.threadPerformer"
              : "booking.threadVenue",
          ),
        )
      );
    },
    [counterpartyLabel, side, t],
  );

  return (
    <YStack gap="$3" data-testid={testIdBase}>
      <XStack gap="$2" alignItems="center" flexWrap="wrap">
        <MessageSquare size={14} style={{ opacity: 0.7, flexShrink: 0 }} aria-hidden />
        <Text
          variant="caption"
          weight="bold"
          tone="muted"
          textTransform="uppercase"
          letterSpacing={0.6}
        >
          {String(t("booking.threadHeading"))}
        </Text>
        {unreadCount > 0 && (
          <Badge tone="info" size="sm" data-testid={`${testIdBase}-unread`}>
            {String(t("booking.threadUnread", { count: unreadCount }))}
          </Badge>
        )}
        {/* No polling: this refetches the page the walk ended on, which is
            where a newly-arrived counterparty message lands, and the merge
            above folds it in. An explicit control beats a background timer on
            a panel an operator may leave open all afternoon. */}
        <Button
          variant="ghost"
          size="$1"
          onPress={() => void listQuery.refetch()}
          disabled={listQuery.isFetching}
          aria-label={String(t("booking.threadRefresh"))}
          testID={`${testIdBase}-refresh`}
        >
          <RefreshCw size={12} aria-hidden />
        </Button>
      </XStack>

      {/* How this thread is delivered, before anything that gets typed into
          it. See the `notice` prop. */}
      {notice ?? null}

      {/* Messages */}
      {isLoading && messages.length === 0 ? (
        <XStack padding="$3" justifyContent="center">
          <Spinner size="sm" />
        </XStack>
      ) : listQuery.error ? (
        <YStack gap="$2" alignItems="flex-start">
          <Text variant="bodySmall" tone="error" role="alert">
            {formatErrorMessage(listQuery.error, t)}
          </Text>
          <Button
            variant="secondary"
            size="$2"
            onPress={() => void listQuery.refetch()}
          >
            {String(t("booking.threadRetry"))}
          </Button>
        </YStack>
      ) : messages.length === 0 ? (
        // LOOKS DEAD, ISN'T — do not delete. Every request now opens with a
        // `booking_request.opened` entry, so a thread created after the ledger
        // shipped is never empty. Requests that predate it have no entries at
        // all and reach this branch until someone writes the first message.
        <Text variant="bodySmall" tone="muted" data-testid={`${testIdBase}-empty`}>
          {String(t("booking.threadEmpty"))}
        </Text>
      ) : (
        <YStack
          gap="$2"
          role="log"
          aria-label={String(t("booking.threadHeading"))}
          data-testid={`${testIdBase}-messages`}
        >
          {messages.map((message) => {
            // ── Ledger entry ────────────────────────────────────────────────
            if (message.authorSide === "SYSTEM") {
              const view = describeBookingSystemEntry({
                systemKind: message.systemKind,
                systemData: message.systemData,
                t: (key, values) => String(t(key, values)),
                formatDateTime: (value) =>
                  fmt.dateTime(value, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }),
                // A hold's day has no clock — see `formatDate` on the args.
                formatDate: (value) => fmt.dateTime(value, { dateStyle: "medium" }),
                locale: fmt.locale,
                // The hold entries read differently per side (FR-013): the
                // act sees "You're 2nd in line", the venue sees the line it
                // keeps. `side` is the declared reader, which is exactly the
                // input this copy needs.
                viewerSide: side,
              });
              // Unrecognized kind (a row from a newer build) — render nothing
              // rather than an empty bubble or a raw key.
              if (!view) return null;
              // Both ids are interpolated into a PATH. `systemData` is not
              // re-validated on read, so `describeBookingSystemEntry` shape-
              // checks them (`readId`) and hands back null for anything that
              // is not a uuid — the entry then renders with no link at all.
              const eventHref =
                view.eventId && eventAdminSlug && eventLinksEnabled
                  ? `/admin/${eventAdminSlug}/events/${view.eventId}`
                  : null;
              // The agreement opens INSIDE the caller's admin shell when the
              // thread is mounted in one (the venue inbox); the performer's
              // list has no shell and keeps the standalone page.
              const agreementHref = view.agreementId
                ? eventAdminSlug
                  ? adminAgreementHref(eventAdminSlug, view.agreementId)
                  : standaloneAgreementHref(view.agreementId)
                : null;
              return (
                <BookingSystemEntryRow
                  key={message.id}
                  view={view}
                  timestamp={fmt.dateTime(new Date(message.createdAt), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                  href={eventHref ?? agreementHref}
                  linkLabel={
                    eventHref
                      ? String(t("booking.entryOpenEvent"))
                      : agreementHref
                        ? String(t("booking.entryOpenAgreement"))
                        : null
                  }
                  testId={`${testIdBase}-entry-${message.id}`}
                />
              );
            }

            const mine = message.authorSide === side;
            return (
              <YStack
                key={message.id}
                gap="$1"
                padding="$3"
                borderWidth={1}
                borderColor={mine ? "$accent" : "$borderColor"}
                backgroundColor={mine ? "$accentSoft" : "$surface"}
                data-testid={`${testIdBase}-message-${message.id}`}
              >
                <XStack gap="$2" alignItems="baseline" flexWrap="wrap">
                  <Text variant="caption" weight="bold">
                    {authorLabel(message)}
                  </Text>
                  <Text variant="caption" tone="muted">
                    {fmt.dateTime(new Date(message.createdAt), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })}
                  </Text>
                </XStack>
                <Text variant="bodySmall" style={{ whiteSpace: "pre-wrap" }}>
                  {message.body}
                </Text>
              </YStack>
            );
          })}
        </YStack>
      )}

      {/* The binding header, immediately above the box the next message gets
          typed into — see the module note. Rendered ONLY when the request has
          an agreement; there is deliberately no placeholder for the case where
          it does not. */}
      {agreementId ? (
        <BookingTermsStrip
          agreementId={agreementId}
          adminSlug={eventAdminSlug ?? null}
          nameSuffix={counterpartyLabel}
          testIdBase={testIdBase}
        />
      ) : null}

      {/* The next step, directly under the terms it acts on. */}
      {nextStep ?? null}

      {/* Composer — unconditional. See the module note: no status gate. */}
      <YStack gap="$2">
        <TextInput
          multiline
          value={body}
          onChangeText={setBody}
          placeholder={String(t("booking.threadPlaceholder"))}
          maxLength={BODY_MAX}
          fullWidth
          minHeight={88}
          aria-label={String(t("booking.threadComposerLabel"))}
          testId={`${testIdBase}-input`}
        />
        {postError && (
          <Text variant="caption" tone="error" role="alert">
            {postError}
          </Text>
        )}
        <XStack gap="$3" alignItems="center" justifyContent="flex-end" flexWrap="wrap">
          <Text variant="caption" tone="muted" aria-hidden>
            {`${trimmed.length} / ${BODY_MAX}`}
          </Text>
          <Button
            variant="primary"
            size="$2"
            disabled={!canSend || postMutation.isPending}
            onPress={handleSend}
            testID={`${testIdBase}-send`}
          >
            {postMutation.isPending ? (
              <Spinner size="sm" />
            ) : (
              <>
                <Send size={14} aria-hidden />
                {String(t("booking.threadSend"))}
              </>
            )}
          </Button>
        </XStack>
      </YStack>

      {/* Attachments — READ-ONLY (see the module note). Rendered only when the
          request actually has some, so a thread with none stays quiet. */}
      {attachments.length > 0 && (
        <YStack gap="$2" data-testid={`${testIdBase}-attachments`}>
          <Text
            variant="caption"
            weight="bold"
            tone="muted"
            textTransform="uppercase"
            letterSpacing={0.6}
          >
            {String(t("booking.threadAttachments"))}
          </Text>
          {attachments.map((file) => (
            <XStack
              key={file.id}
              gap="$2"
              alignItems="center"
              padding="$2"
              borderWidth={1}
              borderColor="$borderColor"
              backgroundColor="$surface"
              minWidth={0}
            >
              <Paperclip size={12} style={{ opacity: 0.6, flexShrink: 0 }} aria-hidden />
              {/* flexBasis, not `flex: 1`: Tamagui inherits RN's flexShrink: 0,
                  so a long filename would push the size out of the row. */}
              <Text
                variant="bodySmall"
                flexBasis={0}
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                truncate
              >
                {file.fileName}
              </Text>
              <Text variant="caption" tone="muted" flexShrink={0}>
                {formatBytes(file.sizeBytes)}
              </Text>
            </XStack>
          ))}
        </YStack>
      )}
    </YStack>
  );
}

"use client";

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "@bprogress/next/app";
import { YStack, XStack, Card, Stack, styled } from "tamagui";
import type { TamaguiElement } from "tamagui";
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  ClipboardList,
  UserRound,
} from "lucide-react";

import {
  Text,
  Button,
  Badge,
  DateTime,
  useLocale,
  useNotify,
  useTranslations,
} from "@th/ui";

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { useEmailGateLatch } from "@/hooks/useEmailGateLatch";
import { EmailVerificationRequired } from "@/components/auth/EmailVerificationRequired";
import { formatErrorMessage } from "@/lib/format-error-message";

// ─────────────────────────────────────────────────────────────────────────────
// `/my-lineups` (owner ruling "option A", 2026-09-30). Mirrors `/my-rsvps`:
// same header, card list, skeleton, signed-out promo, empty/error states and
// Load more. The card differs in one way that matters: it carries a "Remove
// me" button, so it is NOT one big link — the title is plain text and a
// separate "View event" link appears only for a published event with a slug.
// ─────────────────────────────────────────────────────────────────────────────

type LineupItem =
  inferRouterOutputs<AppRouter>["eventHumans"]["listMine"]["items"][number];

const PAGE_LIMIT = 20;

/** Localised role names — the server's `roleLabel` is English-only. */
const ROLE_KEYS: Record<LineupItem["role"], string> = {
  PERFORMER: "admin.ebLineupRolePerformer",
  HOST: "admin.ebLineupRoleHost",
  DJ: "admin.ebLineupRoleDj",
  INSTRUCTOR: "admin.ebLineupRoleInstructor",
  SPEAKER: "admin.ebLineupRoleSpeaker",
  VENDOR: "admin.ebLineupRoleVendor",
  VOLUNTEER: "admin.ebLineupRoleVolunteer",
  OTHER: "admin.ebLineupRoleOther",
};

/** Focus a Tamagui element ref on web. Native has no `.focus()` on a frame. */
function focusRef(ref: React.RefObject<TamaguiElement | null>): void {
  (ref.current as unknown as { focus?: () => void } | null)?.focus?.();
}

// ─────────────────────────────────────────────────────────────────────────────
// Skeleton loading (matches the /my-rsvps pattern)
// ─────────────────────────────────────────────────────────────────────────────

const SkeletonPulse = styled(Stack, {
  name: "MyLineupsSkeletonPulse",
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
  animation: "th-skeleton-pulse 1.8s ease-in-out infinite",
});

const LineupCardSkeleton = () => (
  <Card
    padding="$4"
    borderRadius={0}
    borderTopWidth={2}
    borderTopColor="$borderColor"
    borderBottomWidth={1}
    borderBottomColor="$borderColor"
  >
    <YStack gap="$3">
      <XStack justifyContent="space-between" alignItems="center">
        <SkeletonPulse height={20} width="60%" />
        <SkeletonPulse height={22} width={44} borderRadius={0} />
      </XStack>
      <XStack gap="$4" flexWrap="wrap">
        <SkeletonPulse height={16} width={140} />
        <SkeletonPulse height={16} width={180} />
      </XStack>
      <XStack
        justifyContent="flex-end"
        borderTopWidth={1}
        borderTopColor="$borderColorSoft"
        paddingTop="$3"
      >
        <SkeletonPulse height={44} width={120} />
      </XStack>
    </YStack>
  </Card>
);

// ─────────────────────────────────────────────────────────────────────────────
// Lineup card
// ─────────────────────────────────────────────────────────────────────────────

type LineupCardProps = {
  item: LineupItem;
  confirming: boolean;
  removing: boolean;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onConfirmRemove: () => void;
};

const LineupCard = ({
  item,
  confirming,
  removing,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: LineupCardProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const confirmTextId = useId();

  const removeButtonRef = useRef<TamaguiElement | null>(null);
  const confirmTextRef = useRef<HTMLParagraphElement | null>(null);
  // Set when the reader backs out ("Keep me on" / Escape): the footer swaps
  // back and focus returns to the button that opened the confirm. Not set
  // when another card's confirm takes over — focus is already there.
  const restoreFocusRef = useRef(false);
  const wasConfirming = useRef(confirming);

  useEffect(() => {
    if (confirming && !wasConfirming.current) {
      // Land on the question, not a button: a second Enter must not remove.
      confirmTextRef.current?.focus();
    } else if (!confirming && wasConfirming.current && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      focusRef(removeButtonRef);
    }
    wasConfirming.current = confirming;
  }, [confirming]);

  const cancel = useCallback(() => {
    if (removing) return;
    restoreFocusRef.current = true;
    onCancelRemove();
  }, [onCancelRemove, removing]);

  const onConfirmKeyDown = useCallback(
    (ev: KeyboardEvent<HTMLDivElement>) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        cancel();
      }
    },
    [cancel],
  );

  const isCancelled = item.status === "CANCELLED";
  const isDraft = item.status === "DRAFT";
  const isArchived = item.status === "ARCHIVED";
  const href =
    item.status === "PUBLISHED" && item.slug ? `/events/${item.slug}` : null;

  const roleName =
    item.role === "OTHER" && item.customRoleLabel
      ? item.customRoleLabel
      : item.role === "VOLUNTEER"
        ? // Page-local: es wants "Voluntariado" here, not the builder's word.
          String(t("myLineups.roleVolunteer"))
        : String(t(ROLE_KEYS[item.role] as Parameters<typeof t>[0]));
  const roleLine = item.organiserName
    ? String(
        t("myLineups.roleWithOrganiser", {
          role: roleName,
          organiser: item.organiserName,
        }),
      )
    : roleName;

  // The confirm says exactly what the server will do — no more, no less.
  // Signup: the server withdraws one only for a VOLUNTEER row with a live
  // signup (an editor-attached VOLUNTEER row with none is a plain removal).
  // Told: `organiserWillBeTold` is exact — false on an ownerless community
  // listing, on your own personal event, and on an org event where you are
  // the only owner/admin/editor (nobody else gets the leave notice).
  // Booking: `passesBookingAct` — leaving an upcoming booked show also gives
  // up your spot on that booking, for good; appended to whichever variant.
  const withdrawsSignup = item.role === "VOLUNTEER" && item.hasVolunteerSignup;
  const baseConfirmText = !item.organiserWillBeTold
    ? String(
        t(
          withdrawsSignup
            ? "myLineups.confirmTextVolunteerNobodyTold"
            : "myLineups.confirmTextNobodyTold",
        ),
      )
    : item.organiserName
      ? String(
          t(
            withdrawsSignup
              ? "myLineups.confirmTextVolunteer"
              : "myLineups.confirmText",
            { organiser: item.organiserName },
          ),
        )
      : String(
          t(
            withdrawsSignup
              ? "myLineups.confirmTextVolunteerNoOrganiser"
              : "myLineups.confirmTextNoOrganiser",
          ),
        );
  const confirmText = item.passesBookingAct
    ? `${baseConfirmText} ${String(t("myLineups.confirmBookingNote"))}`
    : baseConfirmText;

  return (
    <div role="listitem">
      <Card
        padding="$4"
        borderRadius={0}
        data-testid={`lineup-card-${item.eventHumanId}`}
      >
        <YStack gap="$3">
          <XStack alignItems="flex-start" gap="$2" flexWrap="wrap">
            <Text variant="h4" tag="h3" weight="bold" flexShrink={1}>
              {item.eventTitle}
            </Text>
            {isCancelled ? (
              <Badge tone="danger" size="sm">
                {String(t("myLineups.cancelledBadge"))}
              </Badge>
            ) : isDraft ? (
              <Badge tone="neutral" size="sm">
                {String(t("myLineups.draftBadge"))}
              </Badge>
            ) : isArchived ? (
              <Badge tone="neutral" size="sm">
                {String(t("admin.eventStatusArchived"))}
              </Badge>
            ) : item.isPast ? (
              <Badge tone="neutral" size="sm">
                {String(t("myLineups.endedBadge"))}
              </Badge>
            ) : null}
          </XStack>

          {/* Meta: when + in what capacity */}
          <XStack gap="$4" flexWrap="wrap">
            <XStack gap="$2" alignItems="center">
              <Calendar size={15} color="var(--colorMuted, #5C544A)" aria-hidden />
              <DateTime
                value={item.startsAt}
                timeZone={item.timezone}
                format="datetime"
                locale={locale}
                variant="body"
                tone="muted"
              />
            </XStack>
            <XStack gap="$2" alignItems="center" flexShrink={1} minWidth={0}>
              <UserRound
                size={15}
                color="var(--colorMuted, #5C544A)"
                aria-hidden
              />
              <Text variant="body" tone="muted" flexShrink={1}>
                {roleLine}
              </Text>
            </XStack>
          </XStack>

          {/* Footer — hairline, then the link + the one action */}
          <YStack
            borderTopWidth={1}
            borderTopColor="$borderColorSoft"
            paddingTop="$3"
          >
            {confirming ? (
              <div
                role="group"
                aria-labelledby={confirmTextId}
                onKeyDown={onConfirmKeyDown}
                data-testid={`lineup-confirm-${item.eventHumanId}`}
              >
                <YStack gap="$3">
                  <p
                    id={confirmTextId}
                    ref={confirmTextRef}
                    tabIndex={-1}
                    style={{ margin: 0 }}
                  >
                    <Text variant="body">{confirmText}</Text>
                  </p>
                  <XStack gap="$2" flexWrap="wrap">
                    {/* Busy, not `disabled`: `disabled` dims the button to
                        0.45, which would fade the very "Removing…" label that
                        is the progress feedback. The press is guarded here. */}
                    <Button
                      variant="primary"
                      size="$4"
                      onPress={() => {
                        if (!removing) onConfirmRemove();
                      }}
                      aria-busy={removing || undefined}
                      aria-disabled={removing || undefined}
                      data-testid={`lineup-confirm-remove-${item.eventHumanId}`}
                    >
                      {String(
                        t(
                          removing
                            ? "myLineups.removing"
                            : "myLineups.confirmRemove",
                        ),
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="$4"
                      onPress={cancel}
                      disabled={removing}
                      data-testid={`lineup-keep-${item.eventHumanId}`}
                    >
                      {String(t("myLineups.keepMeOn"))}
                    </Button>
                  </XStack>
                </YStack>
              </div>
            ) : (
              <XStack
                alignItems="center"
                justifyContent="space-between"
                gap="$3"
                flexWrap="wrap"
              >
                {href ? (
                  <Link
                    href={href}
                    aria-label={String(
                      t("myLineups.viewEventLabel", { title: item.eventTitle }),
                    )}
                    style={{
                      textDecoration: "none",
                      display: "inline-flex",
                      alignItems: "center",
                      minHeight: 44,
                    }}
                    data-testid={`lineup-view-${item.eventHumanId}`}
                  >
                    <Text variant="body" color="$accentText" weight="bold">
                      {String(t("myLineups.viewEvent"))}{" "}
                      <span aria-hidden>→</span>
                    </Text>
                  </Link>
                ) : (
                  // Keeps "Remove me" pinned right when there is no link.
                  <span />
                )}
                <Button
                  ref={removeButtonRef}
                  variant="secondary"
                  size="$4"
                  onPress={onAskRemove}
                  aria-label={String(
                    t("myLineups.removeMeLabel", { title: item.eventTitle }),
                  )}
                  data-testid={`lineup-remove-${item.eventHumanId}`}
                >
                  {String(t("myLineups.removeMe"))}
                </Button>
              </XStack>
            )}
          </YStack>
        </YStack>
      </Card>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Signed-out promo
// ─────────────────────────────────────────────────────────────────────────────

const SignedOutPromo = () => {
  const t = useTranslations();
  const { showSignInOverlay } = useAppOverlay();

  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      padding="$10"
      gap="$5"
      data-testid="my-lineups-signed-out"
    >
      <YStack
        width={80}
        height={80}
        borderRadius={0}
        backgroundColor="$surfaceMuted"
        justifyContent="center"
        alignItems="center"
      >
        <ClipboardList size={36} color="var(--colorMuted, #5C544A)" aria-hidden />
      </YStack>
      <YStack gap="$2" alignItems="center">
        <Text variant="h3" weight="bold" textAlign="center">
          {String(t("myLineups.signedOutTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={340}>
          {String(t("myLineups.signedOutDescription"))}
        </Text>
      </YStack>
      <Button
        variant="primary"
        size="$4"
        onPress={() => showSignInOverlay({ redirect: "/my-lineups" })}
        data-testid="my-lineups-sign-in-cta"
      >
        {String(t("myLineups.signIn"))}
      </Button>
    </YStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Empty state — informational only. There is nothing to do from here: a
// lineup is something an organiser puts you on, not something you browse to.
// ─────────────────────────────────────────────────────────────────────────────

const EmptyState = () => {
  const t = useTranslations();

  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      padding="$8"
      gap="$4"
      data-testid="my-lineups-empty"
    >
      <YStack
        width={64}
        height={64}
        borderRadius={0}
        backgroundColor="$surfaceMuted"
        justifyContent="center"
        alignItems="center"
      >
        <ClipboardList size={28} color="var(--colorMuted, #5C544A)" aria-hidden />
      </YStack>
      <YStack gap="$2" alignItems="center">
        <Text variant="h4" weight="bold" textAlign="center">
          {String(t("myLineups.emptyTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={320}>
          {String(t("myLineups.emptyDescription"))}
        </Text>
      </YStack>
    </YStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Header: shared by the list and the email-gated view, so both read the same.
// `flexWrap` + a real `minWidth` on the title column (the /my-tickets
// pattern): at 320 the back button claims ~200px of the row, which squeezed
// the h1 to ~100px and broke "LINEUPS" mid-word. Below ~200px of remaining
// space the title takes its own full-width row under the back link instead.
// ─────────────────────────────────────────────────────────────────────────────

const LineupsHeader = ({
  headingRef,
}: {
  headingRef: React.RefObject<TamaguiElement | null>;
}) => {
  const t = useTranslations();
  const router = useRouter();
  return (
    <XStack gap="$3" alignItems="center" flexWrap="wrap">
      {/* Accent lives on the Button frame (not an inner Text override) so the
          icon + label ride currentColor per the v2 atom grammar. `$accentText`
          rather than `$accent`: a control's label, and `accent` as small text
          fails AA on the Stub canvas. */}
      <Button
        variant="ghost"
        size="$3"
        color="$accentText"
        onPress={() => router.push("/")}
        aria-label={t("common.backToHome") as string}
        paddingHorizontal="$2"
        paddingVertical="$2"
      >
        <ArrowLeft size={16} strokeWidth={2.5} aria-hidden />
        {String(t("common.backToHome"))}
      </Button>
      <YStack gap="$1" flex={1} minWidth={200}>
        <Text
          ref={headingRef}
          variant="h2"
          tag="h1"
          weight="bold"
          textTransform="uppercase"
          letterSpacing={-0.5}
          // Programmatic focus target after a card is removed.
          tabIndex={-1}
          outlineStyle="none"
        >
          {String(t("myLineups.title"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("myLineups.subtitle"))}
        </Text>
      </YStack>
    </XStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Page body
// ─────────────────────────────────────────────────────────────────────────────

export const MyLineups = () => {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const sessionQuery = authClient.useSession();
  const sessionResolved = !sessionQuery.isPending;
  const isSignedIn = Boolean(sessionQuery.data?.user);

  // useInfiniteQuery injects a top-level `direction` into the input. The
  // procedure must allow + strip it (as community.myRsvps does) or every
  // request 400s on the strict base schema.
  const listQuery = trpc.eventHumans.listMine.useInfiniteQuery(
    { limit: PAGE_LIMIT },
    {
      enabled: isSignedIn,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  const leaveMutation = trpc.eventHumans.leave.useMutation();

  // Only one confirm is open at a time — one primary button per viewport.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Rows the reader just left: hidden at once, before the refetch lands.
  const [removedIds, setRemovedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const headingRef = useRef<TamaguiElement | null>(null);
  // Synchronous double-submit guard: `isPending` only flips on the next
  // render, so two presses in one tick would both get past it.
  const inFlightRef = useRef(false);

  const items = useMemo<LineupItem[]>(() => {
    const pages = listQuery.data?.pages ?? [];
    const seen = new Set<string>();
    return pages
      .flatMap((page) => page.items)
      .filter((item) => {
        if (removedIds.has(item.eventHumanId) || seen.has(item.eventHumanId)) {
          return false;
        }
        seen.add(item.eventHumanId);
        return true;
      });
  }, [listQuery.data?.pages, removedIds]);

  const handleConfirmRemove = useCallback(
    async (item: LineupItem) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const result = await leaveMutation.mutateAsync({
          eventId: item.eventId,
        });
        setRemovedIds((prev) => new Set(prev).add(item.eventHumanId));
        setConfirmingId(null);
        // The card that held focus is gone — park it on the page heading
        // rather than letting it fall back to <body>.
        focusRef(headingRef);
        void utils.eventHumans.listMine.invalidate();
        // The public lineup (event page, checkout attribution) drops them too.
        void utils.eventHumans.listPublic.invalidate({ eventId: item.eventId });
        if (result.withdrawnVolunteerSignupId) {
          // /my-volunteering and the viewer's own signup reads.
          void utils.volunteer.signups.listMyCommitments.invalidate();
          void utils.volunteer.signups.listMine.invalidate();
        }
        toast.success({
          title: String(t("myLineups.removed", { title: item.eventTitle })),
        });
      } catch (err) {
        toast.danger({
          title: String(t("myLineups.removeFailed")),
          message: formatErrorMessage(err, t),
        });
      } finally {
        inFlightRef.current = false;
      }
    },
    [leaveMutation, t, toast, utils],
  );

  // B2: an unverified account's lineups are withheld, not broken. "Try
  // again" can never fix that, so the page asks for the code instead. Latched,
  // so a focus refetch cannot unmount the open code card; once the code is
  // accepted EmailVerificationRequired invalidates every query and the list
  // loads in place.
  const listNeedsVerification = useEmailGateLatch(listQuery);

  const isInitialLoading =
    !sessionResolved ||
    (isSignedIn && listQuery.isLoading && !listNeedsVerification);
  const showSkeleton = useDelayedFlag(isInitialLoading, 200);

  // ── Signed out ─────────────────────────────────────────────────────────────
  if (sessionResolved && !isSignedIn) {
    return <SignedOutPromo />;
  }

  // ── Loading ────────────────────────────────────────────────────────────────
  if (isInitialLoading) {
    if (!showSkeleton) {
      return <YStack gap="$4" data-testid="my-lineups-loading" />;
    }
    return (
      <YStack gap="$4" data-testid="my-lineups-loading">
        <SkeletonPulse height={28} width="40%" />
        <SkeletonPulse height={14} width={140} />
        <YStack gap="$2">
          <LineupCardSkeleton />
          <LineupCardSkeleton />
          <LineupCardSkeleton />
        </YStack>
      </YStack>
    );
  }

  // ── Email not verified ─────────────────────────────────────────────────────
  if (listNeedsVerification && !listQuery.data) {
    return (
      <YStack gap="$4" data-testid="my-lineups-email-gate">
        <LineupsHeader headingRef={headingRef} />
        <EmailVerificationRequired context="lineups" headingTag="h2" />
      </YStack>
    );
  }

  // ── Error (nothing to show yet) ────────────────────────────────────────────
  // A failed BACKGROUND refetch keeps the list on screen — see the inline
  // notice below — rather than replacing what the reader already has.
  if (listQuery.error && !listQuery.data) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$8"
        gap="$4"
        data-testid="my-lineups-error"
      >
        <YStack
          width={64}
          height={64}
          borderRadius={0}
          backgroundColor="$red3"
          justifyContent="center"
          alignItems="center"
        >
          <AlertCircle size={28} color="var(--danger, #B91C1C)" aria-hidden />
        </YStack>
        {/* Keep the raw error out of the UI — translated copy only. */}
        <Text variant="h4" color="$red10">
          {String(t("myLineups.unableToLoad"))}
        </Text>
        <Button variant="secondary" onPress={() => listQuery.refetch()}>
          {String(t("myLineups.tryAgain"))}
        </Button>
      </YStack>
    );
  }

  const pendingEventId = leaveMutation.isPending
    ? (leaveMutation.variables?.eventId ?? null)
    : null;

  // ── Content ────────────────────────────────────────────────────────────────
  return (
    <YStack gap="$4" data-testid="my-lineups-content">
      <LineupsHeader headingRef={headingRef} />

      {listQuery.error ? (
        <XStack
          gap="$3"
          alignItems="center"
          flexWrap="wrap"
          role="status"
          data-testid="my-lineups-refresh-failed"
        >
          <AlertCircle size={15} color="var(--danger, #B91C1C)" aria-hidden />
          <Text variant="body" tone="muted">
            {String(t("myLineups.refreshFailed"))}
          </Text>
          <Button
            variant="secondary"
            size="$3"
            onPress={() => listQuery.refetch()}
          >
            {String(t("myLineups.tryAgain"))}
          </Button>
        </XStack>
      ) : null}

      {items.length === 0 && !listQuery.isFetching ? (
        <EmptyState />
      ) : (
        <YStack
          gap="$2"
          role="list"
          aria-label={String(t("myLineups.title"))}
        >
          {items.map((item) => (
            <LineupCard
              key={item.eventHumanId}
              item={item}
              confirming={confirmingId === item.eventHumanId}
              removing={pendingEventId === item.eventId}
              onAskRemove={() => setConfirmingId(item.eventHumanId)}
              onCancelRemove={() => setConfirmingId(null)}
              onConfirmRemove={() => void handleConfirmRemove(item)}
            />
          ))}
        </YStack>
      )}

      {listQuery.hasNextPage ? (
        <XStack justifyContent="center" paddingVertical="$2">
          <Button
            variant="secondary"
            size="$3"
            disabled={listQuery.isFetchingNextPage}
            onPress={() => void listQuery.fetchNextPage()}
            data-testid="my-lineups-load-more"
          >
            {String(
              t(
                listQuery.isFetchingNextPage
                  ? "common.loading"
                  : "myLineups.loadMore",
              ),
            )}
          </Button>
        </XStack>
      ) : null}
    </YStack>
  );
};

MyLineups.displayName = "MyLineups";

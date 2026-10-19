"use client";

import { useMemo } from "react";
import type { ComponentProps, ComponentType, ReactNode } from "react";
import { useRouter } from "@bprogress/next/app";
import { Card, Stack, XStack, YStack, styled } from "tamagui";
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  CalendarClock,
  Clock,
  FileText,
  HeartHandshake,
  MapPin,
  QrCode,
  Search,
} from "lucide-react";

import {
  Text,
  Button,
  Badge,
  NextLinkAnchor,
  useTranslations,
  useFormatters,
} from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useDelayedFlag } from "@/hooks/useDelayedFlag";
import { SignupSmsToggle } from "@/components/volunteering/SignupSmsToggle";
import {
  SIGNUP_STATUS_TONE,
  attendeeSignupStatusLabelKey,
  type SignupStatus,
} from "@/components/volunteering/volunteering-helpers";

import {
  bucketCommitments,
  commitmentHref,
  commitmentRowKey,
  commitmentSmsLabelKey,
  computeTotals,
  hasStatementShifts,
  readCreditedHours,
  formatDateBlock,
  formatDayLine,
  formatWindow,
  isOpenEndedCommitment,
  smsSwitchRowKeys,
  type Commitment,
} from "./my-volunteering-helpers";
// The QR sheet's OWN selection logic, imported rather than reimplemented: the
// entry point below must offer a code exactly when the document can mint one.
import { selectQrSubjects } from "../qr/print/_components/volunteer-qr-helpers";

// One rule only (`@media print { [data-print-hide] { display: none } }`), so
// the "Print hours statement" control never lands on paper if the volunteer
// prints this page instead of the statement.
import "@/app/_print/print-hide.css";

/** Stub `colorMuted`. Inline SVG colours can't take a Tamagui token, and the
 *  fallback is what SSR paints before the theme injector runs. */
const ICON_MUTED = "var(--colorMuted, #5C544A)";

// ─────────────────────────────────────────────────────────────────────────────
// Atoms
// ─────────────────────────────────────────────────────────────────────────────

const SkeletonPulse = styled(Stack, {
  name: "MyVolunteeringSkeletonPulse",
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
  animation: "th-skeleton-pulse 1.8s ease-in-out infinite",
});

/** v2 kicker index numeral — decorative, so aria-hidden. Matches the
 *  MyTickets / OrderDetail section-number treatment. */
const SectionNum = ({ children }: { children: ReactNode }) => (
  <Text
    variant="kicker"
    tone="accent"
    weight="bold"
    aria-hidden
    fontSize={14}
    minWidth={28}
  >
    {children}
  </Text>
);

const StatusBadge = ({ status }: { status: SignupStatus }) => {
  const t = useTranslations();
  return (
    <Badge
      tone={SIGNUP_STATUS_TONE[status]}
      size="sm"
      flexShrink={0}
      data-testid={`commitment-status-${status}`}
    >
      {String(t(attendeeSignupStatusLabelKey(status)))}
    </Badge>
  );
};

/** icon + label meta pair (flex row, gap only — v2 meta-list rule). */
const Meta = ({
  icon: Icon,
  children,
  truncate = false,
}: {
  icon: ComponentType<{
    size?: number;
    color?: string;
    "aria-hidden"?: boolean;
  }>;
  children: ReactNode;
  truncate?: boolean;
}) => (
  <XStack gap="$2" alignItems="center" minWidth={0} maxWidth="100%">
    <Icon size={15} color={ICON_MUTED} aria-hidden />
    <Text
      variant="bodySmall"
      tone="muted"
      {...(truncate
        ? {
            overflow: "hidden" as const,
            whiteSpace: "nowrap" as const,
            textOverflow: "ellipsis" as const,
          }
        : {})}
    >
      {children}
    </Text>
  </XStack>
);

/**
 * Row note for an ask whose owner is withheld (`signupsPaused`). Same caption
 * pair as the row footer ("N hours logged" bold, "Applied …" muted). A static
 * note, so no live region. The copy never says why.
 */
const PausedNote = () => {
  const t = useTranslations();
  return (
    <YStack gap="$1" data-testid="commitment-signups-paused">
      <Text variant="caption" weight="bold">
        {String(t("myVolunteering.signupsPausedTitle"))}
      </Text>
      <Text variant="caption" tone="muted">
        {String(t("myVolunteering.signupsPausedBody"))}
      </Text>
    </YStack>
  );
};

/**
 * The row's texts switch (the event page's per-signup switch, shared). It
 * sits OUTSIDE the row's link: toggling must never navigate, and a control
 * inside an anchor is invalid nesting. Revoke-only unless the server says
 * a reminder is sent for this signup (`textRemindersOffered`), so a signup
 * that is ON can always be switched off. This page is the only place an
 * ask volunteer can switch texts back on after a STOP (FR-006b).
 */
const RowSmsSwitch = ({
  row,
  frameProps,
}: {
  row: Commitment;
  frameProps?: ComponentProps<typeof SignupSmsToggle>["frameProps"];
}) => {
  const utils = trpc.useUtils();
  return (
    <SignupSmsToggle
      signupId={row.signupId}
      smsOptIn={row.smsOptIn}
      remindersOffered={row.textRemindersOffered}
      hasPhone={row.hasContactPhone}
      live={row.status === "PENDING" || row.status === "APPROVED"}
      labelKey={commitmentSmsLabelKey(row)}
      onSettled={() =>
        void utils.volunteer.signups.listMyCommitments.invalidate()
      }
      align="start"
      frameProps={frameProps}
      testId={`commitment-sms-${row.signupId}`}
    />
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Rows
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap a row in its event/ask link when the payload can address one. */
const RowLink = ({
  row,
  children,
}: {
  row: Commitment;
  children: ReactNode;
}) => {
  const href = commitmentHref(row);
  if (!href) return <>{children}</>;
  return (
    // display:block overrides NextLinkAnchor's flex/center default so the
    // card fills the column instead of shrink-wrapping.
    <NextLinkAnchor
      href={href}
      style={{ display: "block", textDecoration: "none", color: "inherit" }}
    >
      {children}
    </NextLinkAnchor>
  );
};

const useRowText = (row: Commitment) => {
  const t = useTranslations();
  const fmt = useFormatters();

  const roleLine = row.shiftLabel
    ? `${row.roleName} · ${row.shiftLabel}`
    : row.roleName;

  // A second clock read is fine here: this only decides DISPLAY (whether a
  // stale ask start is still worth showing), never which bucket a row is in.
  const openEnded = isOpenEndedCommitment(row, Date.now());
  const hasShowableWhen = Boolean(row.startsAt) && !openEnded;

  const dayLine =
    (hasShowableWhen && row.startsAt
      ? formatDayLine(fmt.dateTime, row.startsAt, row.eventTimezone)
      : null) ?? String(t("myVolunteering.windowless"));
  const windowLine = hasShowableWhen
    ? formatWindow(fmt.dateTime, row.startsAt, row.endsAt, row.eventTimezone)
    : null;

  return { roleLine, dayLine, windowLine, hasShowableWhen };
};

const CommitmentRow = ({
  row,
  dimmed = false,
  smsSwitch = false,
}: {
  row: Commitment;
  dimmed?: boolean;
  /** This row carries its signup's texts switch (`smsSwitchRowKeys`). */
  smsSwitch?: boolean;
}) => {
  const t = useTranslations();
  const fmt = useFormatters();
  const { roleLine, dayLine, windowLine, hasShowableWhen } = useRowText(row);

  const showApplied = row.status === "PENDING";
  // Same source and same status gate as the totals band, so a row and the
  // band can never disagree:
  //  - CHECKED_IN only — `hoursWorked` is writable BEFORE check-in as an admin
  //    override (`checkInAskVolunteer` in
  //    `packages/core/src/use-cases/volunteering/volunteer-signups.ts` preserves
  //    an explicit value), so an ungated row printed "8 hours logged" against a
  //    shift nobody had worked.
  //  - `hoursCredited`, never the raw `hoursWorked` — null hours mean "fall
  //    back to the shift's scheduled duration", not zero.
  const hours = readCreditedHours(row);
  const showHours = row.status === "CHECKED_IN" && hours !== null;

  return (
    <YStack>
      <RowLink row={row}>
        <Card
          padding="$4"
          borderRadius={0}
          borderTopWidth={1}
          borderTopColor="$borderColor"
          // Unlinked (paused) rows are not interactive: no hover/press wash.
          {...(commitmentHref(row)
            ? {
                hoverStyle: { backgroundColor: "$backgroundHover" },
                pressStyle: { opacity: 0.85 },
                cursor: "pointer" as const,
              }
            : { cursor: "default" as const })}
          // `commitmentRowKey`, not `signupId`: a standing volunteer's parent
          // signup emits one row per claimed occurrence, so `signupId` repeats
          // and this id would no longer address a single row.
          data-testid={`commitment-row-${commitmentRowKey(row)}`}
        >
          <YStack gap="$3">
            <XStack
              justifyContent="space-between"
              alignItems="flex-start"
              gap="$3"
              flexWrap="wrap"
            >
              <YStack gap="$1" flex={1} minWidth={160}>
                {/* History is demoted by TOKEN (ink → colorMuted on the title),
                  never by container alpha. A 0.75 opacity on the Card
                  multiplies every muted child, dropping the muted tier under
                  the 4.5:1 AA floor — and unlike the CSS-module precedent
                  (`.pastShowsZone`) a Tamagui `hoverStyle` can't restore it
                  for a keyboard user, because the focusable element is the
                  ANCHOR wrapping this Card, not the Card itself. */}
                <Text
                  variant="h4"
                  tag="h3"
                  weight="bold"
                  tone={dimmed ? "muted" : "default"}
                >
                  {row.title}
                </Text>
                <Text variant="bodySmall" tone="muted">
                  {roleLine}
                </Text>
              </YStack>
              <StatusBadge status={row.status} />
            </XStack>

            <XStack gap="$4" rowGap="$2" flexWrap="wrap">
              <Meta icon={hasShowableWhen ? Calendar : CalendarClock}>
                {dayLine}
              </Meta>
              {windowLine ? <Meta icon={Clock}>{windowLine}</Meta> : null}
              {row.addressText ? (
                <Meta icon={MapPin} truncate>
                  {row.addressText}
                </Meta>
              ) : null}
            </XStack>

            {showApplied || showHours ? (
              <XStack gap="$3" flexWrap="wrap" alignItems="center">
                {showApplied ? (
                  <Text variant="caption" tone="muted">
                    {String(
                      t("myVolunteering.appliedOn", {
                        date: fmt.dateTime(new Date(row.createdAt), {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        }),
                      }),
                    )}
                  </Text>
                ) : null}
                {showHours ? (
                  <Text
                    variant="caption"
                    weight="bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {String(
                      t("myVolunteering.hoursRecorded", { hours: hours ?? 0 }),
                    )}
                  </Text>
                ) : null}
              </XStack>
            ) : null}

            {/* Only a live APPROVED row: on pending, dimmed or History rows the
              "claimed shifts still stand" copy is false or misleading. */}
            {row.signupsPaused && row.status === "APPROVED" && !dimmed ? (
              <PausedNote />
            ) : null}
          </YStack>
        </Card>
      </RowLink>
      {/* Same inset as the card body, so the switch reads as this row's. */}
      {smsSwitch ? (
        <RowSmsSwitch
          row={row}
          frameProps={{ paddingHorizontal: "$4", paddingBottom: "$3" }}
        />
      ) : null}
    </YStack>
  );
};

/**
 * "Next up" hero — the one thing the volunteer is actually about to do.
 * Same molecules as the row, given a date block and a heavier rule so it
 * reads as the answer to "what's next", not as list item #1.
 */
const NextUpCard = ({ row }: { row: Commitment }) => {
  const fmt = useFormatters();
  const { roleLine, dayLine, windowLine, hasShowableWhen } = useRowText(row);
  const block =
    hasShowableWhen && row.startsAt
      ? formatDateBlock(fmt.dateTime, row.startsAt, row.eventTimezone)
      : null;

  return (
    <RowLink row={row}>
      <Card
        padding="$4"
        borderRadius={0}
        borderTopWidth={2}
        borderTopColor="$accent"
        backgroundColor="$surface"
        // Unlinked (paused) rows are not interactive: no hover/press wash.
        {...(commitmentHref(row)
          ? {
              hoverStyle: { backgroundColor: "$backgroundHover" },
              pressStyle: { opacity: 0.85 },
              cursor: "pointer" as const,
            }
          : { cursor: "default" as const })}
        // Same row identity as the list rows — `claimId ?? signupId`.
        data-testid={`commitment-next-up-${commitmentRowKey(row)}`}
      >
        <XStack gap="$4" alignItems="flex-start">
          {/* The date block IS the hero's date line — it stays in the
              accessible tree (reads "Sat 15 Aug") rather than being
              aria-hidden and repeated as a meta row below. `tag="span"` keeps
              the numeral out of the document heading outline. */}
          {block ? (
            <YStack
              width={64}
              flexShrink={0}
              alignItems="center"
              paddingVertical="$2"
              borderWidth={2}
              borderColor="$borderColor"
              backgroundColor="$surfaceMuted"
            >
              <Text variant="overline" tone="muted" fontSize={10}>
                {block.weekday}
              </Text>
              <Text
                variant="h3"
                tag="span"
                weight="bold"
                style={{ fontVariantNumeric: "tabular-nums" }}
                letterSpacing={-0.5}
              >
                {block.day}
              </Text>
              <Text variant="overline" tone="muted" fontSize={10}>
                {block.month}
              </Text>
            </YStack>
          ) : null}

          <YStack gap="$2" flex={1} minWidth={0}>
            <XStack
              gap="$2"
              alignItems="flex-start"
              justifyContent="space-between"
              flexWrap="wrap"
            >
              <Text variant="h4" tag="h3" weight="bold" flex={1} minWidth={140}>
                {row.title}
              </Text>
              <StatusBadge status={row.status} />
            </XStack>

            <Text variant="body" weight="bold">
              {roleLine}
            </Text>

            <YStack gap="$2">
              {/* Only when there's no date block to carry the date. */}
              {block ? null : (
                <Meta icon={hasShowableWhen ? Calendar : CalendarClock}>
                  {dayLine}
                </Meta>
              )}
              {windowLine ? <Meta icon={Clock}>{windowLine}</Meta> : null}
              {row.addressText ? (
                <Meta icon={MapPin} truncate>
                  {row.addressText}
                </Meta>
              ) : null}
            </YStack>

            {row.signupsPaused && row.status === "APPROVED" ? (
              <PausedNote />
            ) : null}
          </YStack>
        </XStack>
      </Card>
    </RowLink>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Sections
// ─────────────────────────────────────────────────────────────────────────────

const Section = ({
  index,
  title,
  children,
  testId,
}: {
  index: number;
  title: string;
  children: ReactNode;
  testId: string;
}) => (
  <YStack
    gap="$3"
    borderTopWidth={2}
    borderTopColor="$borderColor"
    paddingTop="$4"
    data-testid={testId}
  >
    <XStack gap="$2" alignItems="baseline">
      <SectionNum>{String(index).padStart(2, "0")}</SectionNum>
      <Text
        variant="h4"
        tag="h2"
        weight="bold"
        tone="muted"
        textTransform="uppercase"
        letterSpacing={1}
        flexShrink={1}
      >
        {title}
      </Text>
    </XStack>
    {children}
  </YStack>
);

// ─────────────────────────────────────────────────────────────────────────────
// Empty / error
//
// There is deliberately NO signed-out state here. `/my-volunteering` falls
// through `AppChrome`'s route lists to the full-auth branch, so `AppAuthGate`
// owns the signed-out story end to end — it never renders children without a
// session. A promo in this file could not run, and would cost three i18n keys
// in two locales, policed by the catalog-parity gate forever, for strings no
// user can read.
// ─────────────────────────────────────────────────────────────────────────────

const IconWell = ({ children }: { children: ReactNode }) => (
  <YStack
    width={80}
    height={80}
    borderRadius={0}
    backgroundColor="$surfaceMuted"
    justifyContent="center"
    alignItems="center"
  >
    {children}
  </YStack>
);

const EmptyState = () => {
  const t = useTranslations();

  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      padding="$8"
      gap="$5"
      data-testid="my-volunteering-empty"
    >
      <IconWell>
        <HeartHandshake size={36} color={ICON_MUTED} aria-hidden />
      </IconWell>
      <YStack gap="$2" alignItems="center">
        {/* tag="h2", not the variant's default h3: the empty state renders
            directly under the page <h1> with no sections in between, so h3
            would skip a level (axe `heading-order`). Visual size is unchanged. */}
        <Text variant="h3" tag="h2" weight="bold" textAlign="center">
          {String(t("myVolunteering.emptyTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={340}>
          {String(t("myVolunteering.emptyDescription"))}
        </Text>
      </YStack>
      {/* Dead-ending an empty state is the bug — send them to the only place
          volunteer calls are published today: event pages. */}
      {/* textDecoration:none — the anchor's underline otherwise cascades into
          the button label. */}
      <NextLinkAnchor href="/events" style={{ textDecoration: "none" }}>
        <Button tag="span" variant="primary" size="$4">
          <Search size={16} aria-hidden />
          {String(t("myVolunteering.emptyCta"))}
        </Button>
      </NextLinkAnchor>
    </YStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Page body
// ─────────────────────────────────────────────────────────────────────────────

export const MyVolunteering = () => {
  const t = useTranslations();
  const fmt = useFormatters();
  const router = useRouter();

  const sessionQuery = authClient.useSession();
  const sessionResolved = !sessionQuery.isPending;
  const isSignedIn = Boolean(sessionQuery.data?.user);

  const commitmentsQuery = trpc.volunteer.signups.listMyCommitments.useQuery(
    undefined,
    {
      enabled: isSignedIn,
      staleTime: 30_000,
      refetchOnWindowFocus: true,
    },
  );

  const rows = useMemo<Commitment[]>(
    () => commitmentsQuery.data ?? [],
    [commitmentsQuery.data],
  );

  // One clock read per render pass so a row can't be "upcoming" in the bucket
  // pass and "past" in the totals pass.
  const { buckets, totals } = useMemo(() => {
    const nowMs = Date.now();
    return {
      buckets: bucketCommitments(rows, nowMs),
      totals: computeTotals(rows, nowMs),
    };
  }, [rows]);

  // `!isSignedIn` counts as loading, not as "no commitments": the query is
  // disabled without a session, so an empty `rows` would otherwise render the
  // empty state to someone who simply isn't authenticated yet. AppAuthGate
  // means that can't actually happen — this just keeps the impossible branch
  // truthful instead of wrong.
  const isInitialLoading =
    !sessionResolved || !isSignedIn || commitmentsQuery.isLoading;
  const showSkeleton = useDelayedFlag(isInitialLoading, 200);

  // Section index numbers are assigned top-to-bottom AFTER assembly (v2 §8),
  // so an absent "Next up" renumbers the rest rather than leaving a hole.
  const sections = useMemo(() => {
    const out: Array<{
      id: string;
      titleKey: string;
      rows: Commitment[];
      hero?: boolean;
      dimmed?: boolean;
    }> = [];
    if (buckets.nextUp) {
      out.push({
        id: "next-up",
        titleKey: "myVolunteering.sectionNextUp",
        rows: [buckets.nextUp],
        hero: true,
      });
    }
    if (buckets.confirmed.length) {
      out.push({
        id: "confirmed",
        titleKey: "myVolunteering.sectionConfirmed",
        rows: buckets.confirmed,
      });
    }
    if (buckets.awaiting.length) {
      out.push({
        id: "awaiting",
        titleKey: "myVolunteering.sectionAwaiting",
        rows: buckets.awaiting,
      });
    }
    if (buckets.history.length) {
      out.push({
        id: "history",
        titleKey: "myVolunteering.sectionHistory",
        rows: buckets.history,
        dimmed: true,
      });
    }
    return out;
  }, [buckets]);

  // One texts switch per signup, on its first live row in page order.
  // History is left out: nothing is sent for a past or closed signup.
  const smsSwitchKeys = useMemo(
    () =>
      smsSwitchRowKeys([
        ...(buckets.nextUp ? [buckets.nextUp] : []),
        ...buckets.confirmed,
        ...buckets.awaiting,
      ]),
    [buckets],
  );

  // Headline count = things still live. A rejected or withdrawn application
  // is not a commitment — that's the premise of the separate buckets — so
  // folding History into this number would tell a volunteer with one shift
  // and six rejections that they hold "7 commitments".
  const activeCount =
    (buckets.nextUp ? 1 : 0) +
    buckets.confirmed.length +
    buckets.awaiting.length;

  // Never offer a document that would print empty. Same predicate the sheet
  // itself applies (`selectStatementShifts`), from the same module, so the
  // entry point and the document can't disagree about whether there is
  // anything to state.
  const canPrintStatement = useMemo(() => hasStatementShifts(rows), [rows]);

  /**
   * The event the "Print my check-in code" link points at, or null.
   *
   * Resolved through `selectQrSubjects` — the SAME module the sheet uses — so
   * the entry point and the document cannot disagree about whether a code can
   * be minted. It answers null for the cases the mint would refuse anyway: a
   * PENDING signup, an ask-only commitment with no event, anything not
   * APPROVED.
   *
   * Scoped to the "Next up" row because that is what the link sits under, and
   * because the token is human+EVENT scoped: one code covers every approved
   * shift at that event. (A volunteer with commitments at several future
   * events reaches the others as each becomes Next up. If that proves too
   * narrow, the sheet already accepts any `?event=`.)
   */
  const qrEventId = useMemo(() => {
    const nextUp = buckets.nextUp;
    if (!nextUp?.eventId) return null;
    const subjects = selectQrSubjects(rows);
    return (
      subjects.find((subject) => subject.eventId === nextUp.eventId)?.eventId ??
      null
    );
  }, [buckets.nextUp, rows]);

  // ── Loading ───────────────────────────────────────────────────────────────
  if (isInitialLoading) {
    if (!showSkeleton) {
      return <YStack gap="$4" data-testid="my-volunteering-loading" />;
    }
    return (
      <YStack gap="$4" data-testid="my-volunteering-loading">
        <SkeletonPulse height={28} width="55%" />
        <SkeletonPulse height={14} width={140} />
        <YStack gap="$2">
          {[0, 1, 2].map((i) => (
            <Card
              key={i}
              padding="$4"
              borderRadius={0}
              borderTopWidth={2}
              borderTopColor="$borderColor"
              borderBottomWidth={1}
              borderBottomColor="$borderColor"
            >
              <YStack gap="$3">
                <XStack justifyContent="space-between" alignItems="center">
                  <SkeletonPulse height={20} width="55%" />
                  <SkeletonPulse height={22} width={80} />
                </XStack>
                <XStack gap="$4" flexWrap="wrap">
                  <SkeletonPulse height={16} width={120} />
                  <SkeletonPulse height={16} width={96} />
                </XStack>
              </YStack>
            </Card>
          ))}
        </YStack>
      </YStack>
    );
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (commitmentsQuery.error) {
    return (
      <YStack
        alignItems="center"
        justifyContent="center"
        padding="$8"
        gap="$4"
        data-testid="my-volunteering-error"
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
        {/* Translated copy only — the raw transport error stays out of the UI.
            tag="h1": this branch replaces the whole page including its header,
            so this is the document's only heading — an <h4> alone would leave
            the route with no h1 at all. */}
        <Text variant="h4" tag="h1" color="$red10" textAlign="center">
          {String(t("myVolunteering.unableToLoad"))}
        </Text>
        <Button
          variant="secondary"
          onPress={() => void commitmentsQuery.refetch()}
        >
          {String(t("myVolunteering.tryAgain"))}
        </Button>
      </YStack>
    );
  }

  // ── Content ───────────────────────────────────────────────────────────────
  return (
    <YStack gap="$4" data-testid="my-volunteering-content">
      <XStack gap="$3" alignItems="center" flexWrap="wrap">
        {/* Accent lives on the Button frame (not an inner Text override) so
            the icon + label ride currentColor per the v2 atom grammar. */}
        <Button
          variant="ghost"
          size="$3"
          color="$accent"
          onPress={() => router.push("/")}
          aria-label={t("common.backToHome") as string}
          paddingHorizontal="$2"
          paddingVertical="$2"
        >
          <ArrowLeft size={16} strokeWidth={2.5} aria-hidden />
          {String(t("common.backToHome"))}
        </Button>
        <YStack gap="$1" flex={1} minWidth={180}>
          {/* "VOLUNTEERING" is a 12-character unbreakable word: at the h2
              step it exceeds a 320px column and Tamagui's break-word splits
              it mid-word ("VOLUNTEERI / NG"). One discrete step down below
              480px — not fluid vw scaling. */}
          <Text
            variant="h2"
            tag="h1"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={-0.5}
            $xs={{ fontSize: "$7", lineHeight: "$7" }}
          >
            {String(t("myVolunteering.title"))}
          </Text>
          <Text variant="body" tone="muted">
            {String(t("myVolunteering.countLine", { count: activeCount }))}
          </Text>
        </YStack>
      </XStack>

      {rows.length === 0 ? <EmptyState /> : null}

      {sections.map((section, i) => (
        <Section
          key={section.id}
          index={i + 1}
          title={String(t(section.titleKey))}
          testId={`my-volunteering-section-${section.id}`}
        >
          {section.hero ? (
            <>
              <NextUpCard row={section.rows[0]!} />
              {/* Outside the hero's link, beside its other controls. */}
              {smsSwitchKeys.has(commitmentRowKey(section.rows[0]!)) ? (
                <RowSmsSwitch row={section.rows[0]!} />
              ) : null}
              {/*
                The volunteer's own printable check-in code — a QR, NOT a
                badge. Badge stock is venue-issued and printed by the
                organizer; this is "scan me in" for the volunteer whose phone
                is dead, and it admits nobody by itself.

                OUTSIDE the card, not inside it: `NextUpCard` is wrapped in
                `RowLink`, and an anchor inside an anchor is invalid HTML that
                browsers recover from unpredictably.

                Gated on the same predicate the document applies
                (`canPrintQrCode`, from the same helper), so the entry point
                and the sheet cannot disagree about whether a code can exist.
                `data-print-hide`: if a volunteer prints THIS page, a "print"
                button on the paper is nonsense.
              */}
              {qrEventId ? (
                <XStack data-print-hide>
                  <NextLinkAnchor
                    href={`/my-volunteering/qr/print?event=${encodeURIComponent(qrEventId)}`}
                    style={{ textDecoration: "none" }}
                  >
                    <Button
                      tag="span"
                      variant="secondary"
                      size="$3"
                      minHeight={44}
                      tabIndex={-1}
                      data-testid="print-volunteer-qr"
                    >
                      <QrCode size={15} aria-hidden />
                      {String(t("myVolunteering.printQrAction"))}
                    </Button>
                  </NextLinkAnchor>
                </XStack>
              ) : null}
            </>
          ) : (
            <YStack gap="$2" className="th-card-stagger">
              {section.rows.map((row) => (
                <CommitmentRow
                  // `claimId ?? signupId`. A standing volunteer's parent
                  // signup emits ONE ROW PER CLAIMED OCCURRENCE, so
                  // `signupId` repeats across every date they worked and
                  // React silently drops the duplicates — an undercount
                  // for exactly the volunteers with the most shifts.
                  key={commitmentRowKey(row)}
                  row={row}
                  dimmed={section.dimmed}
                  smsSwitch={
                    !section.dimmed && smsSwitchKeys.has(commitmentRowKey(row))
                  }
                />
              ))}
            </YStack>
          )}
        </Section>
      ))}

      {/* The record band. Two gates, deliberately different:
            - the FIGURES are gated on THIS YEAR's shift count, not on "has ever
              checked in", so a veteran with nothing yet in the new year doesn't
              get a band reading 0/0 every January (v2 §S5: "no number, no band");
            - the STATEMENT link is gated on having any checked-in shift at all,
              because the printed document covers full history. Tying the link to
              the year's figures would hide a school-service letter from exactly
              the volunteer most likely to need one — someone whose shifts were
              all last term. */}
      {totals.shiftsThisYear > 0 || canPrintStatement ? (
        <YStack
          borderTopWidth={2}
          borderTopColor="$borderColor"
          paddingTop="$4"
          gap="$3"
        >
          {totals.shiftsThisYear > 0 ? (
            <YStack gap="$3" data-testid="my-volunteering-totals">
              <XStack gap="$6" rowGap="$4" flexWrap="wrap">
                <YStack gap="$1" minWidth={120}>
                  <Text
                    variant="h3"
                    tag="span"
                    weight="bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                    data-testid="my-volunteering-hours-value"
                  >
                    {/* 2dp, not 1. `creditedHours`
                        (`packages/types/src/volunteer-hours.ts`) rounds every
                        row to 2dp BEFORE anything sums it, so 2dp is the
                        value's exact precision. At 1dp this band read "12.8"
                        for the same 12.75 hours that the printed statement and
                        this page's own per-row "N hours logged" line (ICU,
                        3dp) both show in full — one volunteer, three numbers.
                        No MINIMUM digits: a plain 4-hour year still reads "4"
                        here, because the page is a summary; the statement is
                        the accounting document and fixes its digits. */}
                    {fmt.number(totals.hoursThisYear, {
                      maximumFractionDigits: 2,
                    })}
                  </Text>
                  <Text
                    variant="overline"
                    tone="muted"
                    weight="bold"
                    letterSpacing={1.5}
                  >
                    {String(
                      t("myVolunteering.totalsLabelHours", {
                        count: totals.hoursThisYear,
                      }),
                    )}
                  </Text>
                </YStack>
                <YStack gap="$1" minWidth={120}>
                  <Text
                    variant="h3"
                    tag="span"
                    weight="bold"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                    data-testid="my-volunteering-shifts-value"
                  >
                    {fmt.number(totals.shiftsThisYear)}
                  </Text>
                  <Text
                    variant="overline"
                    tone="muted"
                    weight="bold"
                    letterSpacing={1.5}
                  >
                    {String(
                      t("myVolunteering.totalsLabelShifts", {
                        count: totals.shiftsThisYear,
                      }),
                    )}
                  </Text>
                </YStack>
              </XStack>
              {/* Caption sits BELOW the figures, not beside them: baseline-aligned
              against 40px numerals it floated off to the right and read as a
              detached sentence rather than the band's caption. */}
              <Text variant="caption" tone="muted">
                {String(t("myVolunteering.totalsHint"))}
              </Text>
            </YStack>
          ) : null}

          {/* The one document a volunteer can produce for a registrar, a court
              officer, a grant administrator or an employer matching programme.
              `data-print-hide`: if someone prints THIS page rather than the
              statement, a "print" button on the paper is nonsense. */}
          {canPrintStatement ? (
            <XStack data-print-hide>
              {/* textDecoration:none — the anchor's underline otherwise
                  cascades into the button label. */}
              <NextLinkAnchor
                href="/my-volunteering/hours/print"
                style={{ textDecoration: "none" }}
              >
                <Button
                  tag="span"
                  variant="secondary"
                  size="$3"
                  minHeight={44}
                  data-testid="print-hours-statement"
                >
                  <FileText size={15} aria-hidden />
                  {String(t("myVolunteering.printStatementAction"))}
                </Button>
              </NextLinkAnchor>
            </XStack>
          ) : null}
        </YStack>
      ) : null}
    </YStack>
  );
};

MyVolunteering.displayName = "MyVolunteering";

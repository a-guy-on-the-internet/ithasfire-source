"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import * as Sentry from "@sentry/nextjs";
import { XStack, YStack } from "tamagui";
import { Button, Text, useFormatters, useTranslations } from "@th/ui";
import { ArrowUpRight, Download, RefreshCw, Wallet } from "lucide-react";
import type { GetPayeeStatementOutput } from "@th/core/use-cases/payouts/get-payee-statement";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { downloadCsv } from "@/lib/csv-export";
import { fmtCurrency, fmtDateShort } from "@/lib/format";
import { BORDER, MUTED_TEXT } from "@/lib/design-tokens";
import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { useAdminOwnerCapabilities } from "@/hooks/useAdminOwnerCapabilities";
import { AdminPageHeader } from "../../_components/AdminPageHeader";
import { AdminPageData } from "@/app/admin/_components/AdminPageData";

import { BalanceBreakdown } from "./BalanceBreakdown";
import { LedgerTable } from "./LedgerTable";
import { ledgerCsv, ledgerCsvFilename } from "./ledger-csv";
import { MinimumRow } from "./MinimumRow";
import { PayoutAnswerSkeleton, PayoutPanel } from "./PayoutPanel";
import { PayoutScheduleSection } from "./PayoutScheduleSection";
import {
  PayoutsRoleNotice,
  PayoutsSection,
  PayoutsSectionIndex,
  PayoutsSettingsBand,
  PayoutsSettingsRow,
} from "./PayoutsSections";
import { isForbiddenError } from "../_lib/is-forbidden-error";
import {
  StripeConnectionBadge,
  StripeIncompleteBanner,
  StripeSettingsRow,
  StripeSetupCard,
  StripeStatusSkeleton,
  stripeIncompleteAtTop,
  stripeSetupAtTop,
} from "./StripeAccountSection";
import {
  comingLater,
  headlineFromOverview,
  headlineFromStatement,
  payoutsBlockedFromStatus,
  type PayoutHeadline,
} from "./payout-headline";
import { useStatementPages, type StatementScope } from "./use-statement-pages";
import { useStripeAccount, type StripeAccountOwner } from "./use-stripe-account";

// ─────────────────────────────────────────────────────────────────────────────
// PayoutsView — the organiser's answer to "where is my money", and (since
// Payments merged in, 2026-10-05) the Stripe setup behind it. Four sections in
// a fixed order, each an anchor the rail and the phone chips jump to:
//
//   Balance   the answer (board B "Answer first", owner 2026-10-14): what we
//             send tonight and what more is coming, Owed to you beside it,
//             Ready now only when it differs; holds; the minimum as one fact
//             line; then "Coming up" (the dated list and the Today line)
//   Ledger    what has happened: the 5 newest, then "Show all entries"
//   Settings  one band, two rows (board B): Payout schedule and Stripe
//             account, each one line with Change / Details. The rows keep
//             their own anchors (#schedule, #stripe), so the rail and the
//             phone chips still list four places to jump to.
//
// The ORDER never changes with the account's state. Anything Stripe needs
// sits at the top of Balance — nothing else here can happen until it does —
// and the Stripe account section points up at it: the setup card when not
// connected (`stripeSetupAtTop`), the incomplete banner when connected but
// unfinished (`stripeIncompleteAtTop`). The two predicates are exclusive and
// each decides both places, so the onboarding CTA is on the page exactly once.
//
// ORG owners get the full Balance from `payouts.getOverview` + the statement
// pages. HUMAN owners have no per-event overview, so their register is built
// from the statement's own headline fields and the breakdown is replaced by
// a one-line note — nothing is fabricated to fill the gap.
//
// Failure surfaces are per section: a failed balance read takes down Balance
// (with a retry), never the Stripe setup an owner may need to finish; a
// failed statement takes down only the ledger; a failed Stripe status read
// shows in the Stripe account section and offers no setup button.
//
// A ROLE that cannot read a section (tRPC FORBIDDEN) gets a plain notice in
// that section, never an error with Retry. Balance and Ledger need
// canFinanceOrg (OWNER / ADMIN / FINANCE); schedule and Stripe need
// ORG_EDIT_OR_FINANCE_ROLES. So an EDITOR sees the last two working and a
// VIEWER (who has no nav entry, so arrives only by URL) sees four notices.
// ─────────────────────────────────────────────────────────────────────────────

const figureStyle = { fontVariantNumeric: "tabular-nums" } as const;

const skeletonBlock = (height: number) => ({
  height,
  backgroundColor: BORDER,
  opacity: 0.35,
});

function PayoutsSkeleton() {
  return (
    <YStack gap="$4" aria-busy data-testid="payouts-skeleton">
      {/* The answer's own frame, so the page does not reflow on load. */}
      <PayoutAnswerSkeleton />
      <div style={skeletonBlock(24)} />
      <div style={skeletonBlock(24)} />
      <YStack gap="$1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={skeletonBlock(44)} />
        ))}
      </YStack>
    </YStack>
  );
}

export const PayoutsView = () => {
  const { slug } = useParams<{ slug: string }>();
  const { currentOwner, isLoading: isOwnerLoading } =
    useCurrentAdminOwner(slug);
  const caps = useAdminOwnerCapabilities(currentOwner);
  const { canFinance } = caps;
  const t = useTranslations();
  const fmt = useFormatters();

  const scope = useMemo<StatementScope | null>(() => {
    if (currentOwner?.kind === "org") {
      return { kind: "org", orgId: currentOwner.orgId };
    }
    if (currentOwner?.kind === "human") return { kind: "human" };
    return null;
  }, [currentOwner]);

  // The Stripe status / onboarding / schedule entity.
  const owner = useMemo<StripeAccountOwner | null>(() => {
    if (currentOwner?.kind === "org") {
      return { kind: "org", orgId: currentOwner.orgId };
    }
    if (currentOwner?.kind === "human") {
      return { kind: "human", humanId: currentOwner.humanId };
    }
    return null;
  }, [currentOwner]);

  const isOrg = scope?.kind === "org";
  const overviewQuery = trpc.payouts.getOverview.useQuery(
    { orgId: scope?.kind === "org" ? scope.orgId : "" },
    { enabled: isOrg, staleTime: 30_000 },
  );
  const statement = useStatementPages(scope);
  const stripe = useStripeAccount(owner, caps);

  // The ledger download (spec 2026-10-14 payouts-ledger-export, FR-009). A
  // MUTATION, never a query: the server writes an audit row per export, so a
  // refetch on focus or remount must not re-run it. The ref refuses a second
  // press that lands before the disabled state has rendered.
  const exportLedger = trpc.payouts.exportLedger.useMutation();
  const exportInFlight = useRef(false);
  const handleExportLedger = () => {
    if (exportInFlight.current || !scope) return;
    exportInFlight.current = true;
    exportLedger.mutate(
      scope.kind === "org" ? { orgId: scope.orgId } : undefined,
      {
        onSuccess: (result) => {
          // A failure building the file is the browser's, so no server
          // backstop sees it. Report it, then rethrow: react-query moves the
          // mutation to error and the inline alert shows.
          try {
            downloadCsv(
              ledgerCsv(result.rows, t),
              ledgerCsvFilename(slug, new Date()),
            );
          } catch (err) {
            Sentry.captureException(err, {
              tags: { feature: "payouts-ledger-export" },
            });
            throw err;
          }
        },
        onSettled: () => {
          exportInFlight.current = false;
        },
      },
    );
  };

  // The Settings band's two disclosures. Controlled here so a jump to
  // `#schedule` or `#stripe` (rail, chip, an old `/payments#stripe` link)
  // lands on the row AND opens what the link was for.
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [stripeDetailsOpen, setStripeDetailsOpen] = useState(false);
  const handleJump = useCallback((sectionId: string) => {
    if (sectionId === "schedule") setScheduleOpen(true);
    if (sectionId === "stripe") setStripeDetailsOpen(true);
  }, []);

  const overview = isOrg ? overviewQuery.data : undefined;

  const headline = useMemo<PayoutHeadline | null>(() => {
    if (isOrg) return overview ? headlineFromOverview(overview) : null;
    return statement.first ? headlineFromStatement(statement.first) : null;
  }, [isOrg, overview, statement.first]);

  // What the PAGE waits for: the owner and the Balance read — the overview
  // on the org path, the statement's first page on the human path. NOT the
  // Stripe status: `getStatus` calls Stripe live, so only the slots that
  // need it (the setup slot at the top of Balance, the Stripe account
  // section, two strip cells) wait on it, each with its own placeholder.
  const isLoading =
    isOwnerLoading || (isOrg ? overviewQuery.isLoading : statement.isLoading);
  const balanceError = isOrg ? overviewQuery.error : statement.error;
  const isFetching =
    (isOrg ? overviewQuery.isFetching : false) ||
    statement.isLoadingMore ||
    stripe.statusQuery.isFetching;

  const handleRefresh = () => {
    void stripe.statusQuery.refetch();
    if (isOrg) void overviewQuery.refetch();
    statement.refetch();
  };

  const currency =
    headline?.currency ?? statement.first?.currency ?? "usd";
  const header = (
    <AdminPageHeader
      title={String(t("admin.payoutsTitle"))}
      subtitle={String(
        t("admin.payoutsSubtitle", { currency: currency.toUpperCase() }),
      )}
      section="payouts"
      trailing={
        /* Buttons go in as direct slot children (fragment) — the header's
           trailing XStack already provides gap + wrap/shrink. A nested
           non-wrapping XStack here forced horizontal overflow on phones. */
        <>
          <Button
            variant="ghost"
            size="$3"
            onPress={handleRefresh}
            disabled={isFetching}
          >
            <RefreshCw size={14} />
            {String(t("admin.refresh"))}
          </Button>
          {/* createLoginLink is ORG_FINANCE_ROLES: an EDITOR reads the
              Stripe status below but is not offered the dashboard. */}
          {stripe.isFullyConnected && canFinance && (
            <Button
              variant="secondary"
              size="$3"
              onPress={() => {
                void stripe.openStripeDashboard();
              }}
              disabled={stripe.isOpeningDashboard}
            >
              <ArrowUpRight size={14} />
              {String(t("admin.stripeDashboard"))}
            </Button>
          )}
        </>
      }
    />
  );

  if (!isOwnerLoading && (!scope || !owner)) {
    return (
      <YStack padding="$5" gap="$4">
        {header}
        <YStack
          alignItems="center"
          gap="$3"
          padding="$5"
          borderWidth={1}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <Wallet size={40} color={MUTED_TEXT} />
          <Text variant="body" tone="muted" textAlign="center">
            {String(t("admin.unableToDetermineOwner"))}
          </Text>
        </YStack>
      </YStack>
    );
  }

  if (isLoading || !owner) {
    return (
      <YStack padding="$5" gap="$6" maxWidth={880}>
        {header}
        <PayoutsSkeleton />
      </YStack>
    );
  }

  const setupAtTop = stripeSetupAtTop(stripe);
  const incompleteAtTop = stripeIncompleteAtTop(stripe);
  const noPayee = headline?.payeeId === null;
  // The download sits beside the Ledger heading only when the section shows
  // a ledger (an empty one included, C6). Not while the first page is in
  // flight: an EDITOR's statement answers FORBIDDEN, and the button would
  // flash in and then vanish.
  const ledgerShown =
    !noPayee && !statement.error && !statement.isLoading;

  return (
    <YStack padding="$5" gap="$6" maxWidth={880}>
      {header}

      {/* Phones only (CSS hides it from 960px, where the rail's Payouts
          children are the index). Mounted at every width: it also owns the
          rail's jump handler and scroll-spy. */}
      {/* The landing jump (`/payouts#stripe`) waits for the Stripe status:
          the setup card that may appear above would otherwise push the
          target out of view (no scroll anchoring in Safari). */}
      <PayoutsSectionIndex
        onJump={handleJump}
        ready
        landingReady={!stripe.statusQuery.isLoading}
      />

      <PayoutsSection id="balance">
        {/* The setup slot. While the status is in flight it holds a slim
            placeholder rather than nothing, so the slot is announced
            (aria-busy) and the late card grows from a known spot instead of
            appearing from zero. A full card-height reservation was rejected:
            for the common, connected owner it would collapse a big gap. */}
        {stripe.statusQuery.isLoading ? (
          <StripeStatusSkeleton />
        ) : setupAtTop ? (
          <StripeSetupCard stripe={stripe} canFinance={canFinance} />
        ) : incompleteAtTop ? (
          <StripeIncompleteBanner stripe={stripe} canFinance={canFinance} />
        ) : null}
        <BalanceContent
          headline={headline}
          noPayee={noPayee}
          stripeBannerAbove={incompleteAtTop}
          stripeStatusState={
            stripe.statusQuery.isLoading
              ? "loading"
              : stripe.status
                ? "known"
                : "unknown"
          }
          // The batch skips a payee with no Stripe account or payouts off
          // (run-batch `payeePayoutBlocker`); charges don't enter into it.
          // A loading or failed status read is never a blocker.
          payoutsBlocked={payoutsBlockedFromStatus(stripe.status)}
          balanceError={balanceError}
          onRetry={handleRefresh}
          isOrg={isOrg}
          overview={overview}
          statementFirst={statement.first ?? null}
          currency={currency}
          asOf={isOrg ? overview?.asOf : statement.first?.asOf}
          fmtToday={(asOf, balanceCents) =>
            String(
              t("admin.payoutsTodayLine", {
                date: fmtDateShort(fmt, asOf),
                balance: fmtCurrency(fmt, balanceCents, currency),
              }),
            )
          }
        />
      </PayoutsSection>

      <PayoutsSection
        id="ledger"
        aside={
          ledgerShown ? (
            // Shrinks with the column (DisclosureButton's pattern): at 320px
            // the wrapped header line is ~190px and "DESCARGAR CSV" plus its
            // icon and padding is wider, so the label wraps between words and
            // the height grows from the 44px floor instead of the button
            // running past the section rule. Wide, it keeps its natural size.
            <XStack maxWidth="100%" minWidth={0}>
              <Button
                variant="secondary"
                // $4 is the 44px rung: the touch-target floor.
                size="$4"
                height="auto"
                minHeight={44}
                paddingVertical="$2"
                flexShrink={1}
                minWidth={0}
                maxWidth="100%"
                // The label may shrink to its longest word and no further.
                textProps={{
                  whiteSpace: "normal",
                  textAlign: "center",
                  flexShrink: 1,
                  minWidth: "min-content",
                  style: {
                    overflowWrap: "normal",
                    wordBreak: "normal",
                    wordWrap: "normal",
                  },
                }}
                onPress={handleExportLedger}
                disabled={exportLedger.isPending}
                aria-busy={exportLedger.isPending}
                data-testid="ledger-download-csv"
              >
                <Download size={15} aria-hidden style={{ flexShrink: 0 }} />
                {String(
                  t(
                    exportLedger.isPending
                      ? "admin.payoutsLedgerDownloadPreparing"
                      : "admin.payoutsLedgerDownloadCsv",
                  ),
                )}
              </Button>
            </XStack>
          ) : undefined
        }
      >
        {ledgerShown && exportLedger.isError && (
          <Text
            variant="body"
            tone="error"
            role="alert"
            data-testid="ledger-download-failed"
          >
            {String(t("admin.payoutsLedgerDownloadFailed"))}
          </Text>
        )}
        {isForbiddenError(statement.error) ? (
          <PayoutsRoleNotice kind="money" testId="payouts-ledger-role-notice" />
        ) : noPayee ? (
          <Text variant="body" tone="muted" data-testid="payouts-ledger-nothing">
            {String(t("admin.payoutsLedgerEmpty"))}
          </Text>
        ) : statement.error ? (
          isOrg ? (
            <YStack
              gap="$3"
              padding="$4"
              borderWidth={2}
              borderColor="$borderColorSoft"
              borderRadius={0}
              data-testid="ledger-unavailable"
            >
              <Text variant="body" tone="muted">
                {String(t("admin.payoutsLedgerUnavailable"))}
              </Text>
              <Text variant="caption" tone="muted">
                {formatErrorMessage(statement.error, t)}
              </Text>
              <XStack>
                <Button
                  variant="secondary"
                  size="$4"
                  onPress={statement.refetch}
                >
                  {String(t("admin.retry"))}
                </Button>
              </XStack>
            </YStack>
          ) : (
            // Human path: the statement IS the balance, so Balance above
            // already carries the failure and its retry.
            <Text variant="body" tone="muted" data-testid="ledger-unavailable">
              {String(t("admin.payoutsLoadFailed"))}
            </Text>
          )
        ) : (
          <LedgerTable
            entries={statement.entries}
            unconfirmedSeams={statement.unconfirmedSeams}
            currency={currency}
            hasMore={statement.hasMore}
            canLoadMore={statement.canLoadMore}
            balanceAfterResolved={statement.balanceAfterResolved}
            isLoading={statement.isLoading}
            isLoadingMore={statement.isLoadingMore}
            loadMoreError={
              statement.loadMoreError
                ? formatErrorMessage(statement.loadMoreError, t)
                : null
            }
            refreshError={
              statement.refreshError
                ? formatErrorMessage(statement.refreshError, t)
                : null
            }
            onLoadMore={statement.loadMore}
            onRetry={statement.refetch}
          />
        )}
      </PayoutsSection>

      {/* Settings (board B): the two things an organiser rarely changes,
          one line each, the detail one labelled click away. */}
      <PayoutsSettingsBand>
        <PayoutsSettingsRow id="schedule" first>
          {/* Rendered before Stripe is set up: the server provisions default
              payout terms on first save, so the schedule is choosable
              pre-first-event. `payoutsReady` disables (and dims) the picker
              while no usable payee exists — saving would throw
              PAYEE_NOT_READY. The note points at wherever the setup is. */}
          <PayoutScheduleSection
            entity={owner}
            canEdit={canFinance}
            // The server's gate, not "fully set up": saving is refused
            // (PAYEE_NOT_READY) on the Payee row alone, so an account whose
            // Stripe details are still owed can already choose a schedule.
            payoutsReady={stripe.meetsPayoutGate}
            labelledBy="schedule"
            // Never the default "Stripe Connect section above" copy: nothing
            // on this page is called that. Not connected or incomplete → the
            // card or banner at the top; otherwise (the status read is still
            // in flight or failed) → the Stripe account row below.
            setupRequiredMessage={String(
              t(
                setupAtTop || incompleteAtTop
                  ? "admin.payoutScheduleSetupRequiredTop"
                  : "admin.payoutScheduleSetupRequiredBelow",
              ),
            )}
            disclosure={{ open: scheduleOpen, onOpenChange: setScheduleOpen }}
          />
        </PayoutsSettingsRow>

        <PayoutsSettingsRow
          id="stripe"
          aside={<StripeConnectionBadge stripe={stripe} />}
        >
          <StripeSettingsRow
            stripe={stripe}
            detailsOpen={stripeDetailsOpen}
            onDetailsOpenChange={setStripeDetailsOpen}
          />
        </PayoutsSettingsRow>
      </PayoutsSettingsBand>
    </YStack>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Balance
// ─────────────────────────────────────────────────────────────────────────────

type BalanceContentProps = {
  headline: PayoutHeadline | null;
  noPayee: boolean;
  /** Connected but incomplete: the banner above already says what to do. */
  stripeBannerAbove: boolean;
  /** Whether the Stripe status is known yet — gates the no-payee copy. */
  stripeStatusState: "loading" | "known" | "unknown";
  /** Status loaded and payouts not enabled: the batch skips this payee. */
  payoutsBlocked: boolean;
  balanceError: unknown;
  onRetry: () => void;
  isOrg: boolean;
  overview: Parameters<typeof BalanceBreakdown>[0]["overview"] | undefined;
  statementFirst: GetPayeeStatementOutput | null;
  currency: string;
  asOf: Date | string | undefined;
  fmtToday: (asOf: Date | string, balanceCents: number) => string;
};

function BalanceContent({
  headline,
  noPayee,
  stripeBannerAbove,
  stripeStatusState,
  payoutsBlocked,
  balanceError,
  onRetry,
  isOrg,
  overview,
  statementFirst,
  currency,
  asOf,
  fmtToday,
}: BalanceContentProps) {
  const t = useTranslations();

  if (isForbiddenError(balanceError)) {
    return (
      <PayoutsRoleNotice kind="money" testId="payouts-balance-role-notice" />
    );
  }

  if (balanceError || !headline) {
    return (
      <YStack gap="$4" data-testid="payouts-balance-error">
        <AdminPageData
          isLoading={false}
          isError
          error={{
            message: balanceError ? formatErrorMessage(balanceError, t) : null,
          }}
          errorMessage={String(t("admin.payoutsLoadFailed"))}
        >
          {null}
        </AdminPageData>
        <XStack justifyContent="center">
          <Button variant="secondary" size="$4" onPress={onRetry}>
            {String(t("admin.retry"))}
          </Button>
        </XStack>
      </YStack>
    );
  }

  // No payee: a normal state for a new owner, not an error (board B). If
  // Stripe IS connected but unfinished, the banner directly above already
  // says what is missing and carries the one Continue button.
  if (noPayee && stripeBannerAbove) return null;
  // Still loading: the setup-slot skeleton above is enough. Otherwise one
  // plain line; the setup card (or the Stripe row's error) says the rest.
  if (noPayee && stripeStatusState === "loading") return null;
  if (noPayee) {
    return (
      <Text variant="body" tone="muted" data-testid="payouts-no-payee">
        {String(t("admin.payoutsNothingYet"))}
      </Text>
    );
  }

  const otherCurrencies = isOrg ? (overview?.otherCurrencies ?? []) : [];
  // "…$X more ready by <date>." Org path only: a human owner has no maturity feed
  // in this shape, so the clause is left out rather than guessed.
  const later = isOrg && overview ? comingLater(overview) : null;

  return (
    <YStack gap="$6">
      <YStack gap="$3">
        <PayoutPanel
          headline={headline}
          payoutsBlocked={payoutsBlocked}
          later={later}
        />
        {otherCurrencies.length > 0 && (
          <Text
            variant="caption"
            tone="muted"
            data-testid="payouts-other-currencies"
          >
            {String(
              t("admin.payoutsOtherCurrencies", {
                currency: currency.toUpperCase(),
                count: otherCurrencies.length,
              }),
            )}
          </Text>
        )}
      </YStack>

      {/* The minimum is a rule the organiser is subject to: always on the
          page, one line while cleared, the full row otherwise. */}
      <MinimumRow headline={headline} />

      {/* ── Coming up ────────────────────────────────────────────────── */}
      <YStack gap="$4">
        <Text variant="overline" tone="muted" tag="h3">
          {String(t("admin.payoutsComingUpHeading"))}
        </Text>
        {isOrg && overview ? (
          <BalanceBreakdown overview={overview} />
        ) : statementFirst ? (
          <HumanArrivalNote statement={statementFirst} currency={currency} />
        ) : null}

        {/* ── Today ─────────────────────────────────────────────────── */}
        {asOf !== undefined && (
          <XStack
            gap="$3"
            alignItems="baseline"
            paddingBottom="$2"
            borderBottomWidth={2}
            borderBottomColor="$accent"
            data-testid="payouts-today"
          >
            <Text variant="overline" style={figureStyle}>
              {fmtToday(asOf, headline.balanceCents)}
            </Text>
          </XStack>
        )}
      </YStack>
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Human owner: no per-event breakdown exists. Show the one forecast the
// statement does carry, with its own "could not check".
// ─────────────────────────────────────────────────────────────────────────────

function HumanArrivalNote({
  statement,
  currency,
}: {
  statement: GetPayeeStatementOutput;
  currency: string;
}) {
  const t = useTranslations();
  const fmt = useFormatters();

  const arrival = !statement.arrivalResolved
    ? String(t("admin.payoutsHumanArrivalUnresolved"))
    : statement.nextArrivalAt === null || statement.nextArrivalCents === null
      ? String(t("admin.payoutsHumanNothingUpcoming"))
      : String(
          t("admin.payoutsHumanNextArrival", {
            date: fmtDateShort(fmt, statement.nextArrivalAt),
            amount: fmtCurrency(fmt, statement.nextArrivalCents, currency),
          }),
        );

  return (
    <YStack gap="$2" data-testid="payouts-human-note">
      <Text variant="bodySmall" style={figureStyle}>
        {arrival}
      </Text>
    </YStack>
  );
}

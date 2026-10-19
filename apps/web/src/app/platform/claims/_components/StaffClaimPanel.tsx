"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";
import { Spinner, XStack, YStack } from "tamagui";

import {
  Button,
  CharCountTextarea,
  Text,
  useFormatters,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import { fmtDate, truncateId } from "@/lib/format";
import {
  CLAIM_RESOLUTION_NOTE_MAX,
  REVIEW_CLAIM_ERROR_KEYS,
  claimKindLabelKey,
  claimShortId,
  isClaimUndecided,
  isRefundPending,
} from "@/lib/resale-claims";
import { ClaimStatusBadge } from "./ClaimMobileCard";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type StaffClaimRow = RouterOutputs["claims"]["list"]["items"][number];

type Decision = "approved" | "denied";

/** The panel's DOM id, for the chevron's `aria-controls`. */
export const staffClaimPanelId = (claimId: string) =>
  `staff-claim-panel-${claimId}`;

// Free text keeps its line breaks and never pushes a 320px column wider.
const PRE_WRAP = {
  whiteSpace: "pre-wrap" as const,
  overflowWrap: "anywhere" as const,
};

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <YStack gap="$1" minWidth={0}>
      <Text variant="overline" tone="muted">
        {label}
      </Text>
      {typeof children === "string" ? (
        <Text variant="bodySmall" style={PRE_WRAP}>
          {children}
        </Text>
      ) : (
        children
      )}
    </YStack>
  );
}

/**
 * Claim-desk detail for one claim: both sides' text, the facts, and the
 * decision. Staff can decide at any time; nothing waits for the seller (owner
 * ruling Q8). Approve is a FULL Stripe refund (no partial refunds), so both
 * decisions go through a confirm step that says what will happen.
 *
 * Approval commits the claim as `approved` BEFORE Stripe runs, so a refund
 * that then fails leaves an approved row. The panel therefore reads
 * `refundConfirmed`, never the status alone, before it says "refunded", and
 * offers "Retry refund" (the same `approved` call; the backend resumes it
 * idempotently) until the refund is confirmed. When Stripe REFUSED the refund
 * (REFUND_REJECTED), a retry within about 24 hours replays the same refusal,
 * so the block says so and demotes the button to "Retry anyway".
 *
 * Several panels can be open at once, so every action carries the claim's
 * kind and short id in its accessible name.
 */
export function StaffClaimPanel({
  claim,
  onAnnounce,
}: {
  claim: StaffClaimRow;
  /**
   * Page-level status line: a decision can move the row out of a filtered
   * list (and unmount this panel) right after it lands.
   */
  onAnnounce: (message: string, options?: { urgent?: boolean }) => void;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();

  const translate = useCallback(
    (key: string) => (fmt.getRawMessage(key) ? String(t(key)) : key),
    [fmt, t],
  );

  const kindKey = claimKindLabelKey(claim.kind);
  const kindLabel = kindKey ? String(t(kindKey)) : claim.kind;
  const claimRef = `${kindLabel} ${claimShortId(claim.id)}`;
  // Announcements read "Approved: <kind> (claim <id>)", so they take the parts.
  const announceParams = {
    kind: kindLabel,
    id: claimShortId(claim.id),
  };

  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState<Decision | null>(null);
  // Kept in state (not read from `review.error`) so it survives the refetch
  // that follows every outcome, and sits outside the undecided gate.
  const [lastError, setLastError] = useState<string | null>(null);
  // The code behind `lastError`: REFUND_REJECTED changes what the
  // refund-pending block tells staff to do.
  const [lastErrorCode, setLastErrorCode] = useState<string | null>(null);
  // A retry went through: until the row reads `refundConfirmed`, say it is
  // still pending and when to look in Stripe.
  const [retrySent, setRetrySent] = useState(false);
  // Set by `retryRefund` so the shared mutation callbacks know which call
  // they are answering.
  const retryingRef = useRef(false);

  const clearError = () => {
    setLastError(null);
    setLastErrorCode(null);
  };

  const describeError = useCallback(
    (err: unknown) => {
      const code = getAppErrorCode(err);
      const key = code ? REVIEW_CLAIM_ERROR_KEYS[code] : undefined;
      return key ? String(t(key)) : formatErrorMessage(err, translate);
    },
    [t, translate],
  );

  const review = trpc.claims.review.useMutation({
    // Every failure is worded inline below (`lastError`), and every failed
    // approval is also announced on the page (onError), so the global toast
    // would only add "Something went wrong" over it, and log a missing-copy
    // warning for REFUND_FAILED / REFUND_REJECTED, which are INTERNAL codes
    // worded here by REVIEW_CLAIM_ERROR_KEYS.
    meta: { silent: true },
    onSuccess: async (result) => {
      const wasRetry = retryingRef.current;
      retryingRef.current = false;
      setConfirming(null);
      setLastError(null);
      setLastErrorCode(null);
      setRetrySent(wasRetry);
      const key = wasRetry
        ? "resaleClaim.staffAnnounceRetrySent"
        : result.status === "approved"
          ? "resaleClaim.staffAnnounceApproved"
          : result.status === "denied"
            ? "resaleClaim.staffAnnounceDenied"
            : "resaleClaim.staffAnnounceUnderReview";
      onAnnounce(String(t(key, announceParams)));
      await utils.claims.list.invalidate();
    },
    onError: (err, variables) => {
      retryingRef.current = false;
      setConfirming(null);
      setRetrySent(false);
      const message = describeError(err);
      setLastError(message);
      const code = getAppErrorCode(err) ?? null;
      setLastErrorCode(code);
      if (code === "CLAIM_ALREADY_RESOLVED") {
        onAnnounce(
          String(
            t("resaleClaim.staffAnnounceDecidedElsewhere", announceParams),
          ),
        );
      } else if (code === "REFUND_FAILED" || code === "REFUND_REJECTED") {
        // The claim is committed `approved` before Stripe runs, so the
        // refetch below can move it out of an Open/Under review filter and
        // unmount this panel with its error. The page line outlives it.
        onAnnounce(
          String(
            t(
              code === "REFUND_FAILED"
                ? "resaleClaim.staffAnnounceRefundFailed"
                : "resaleClaim.staffAnnounceRefundRejected",
              announceParams,
            ),
          ),
          { urgent: true },
        );
      } else if (variables?.status === "approved") {
        // Any other failed approval (refund lock held, transfer reversal or
        // refund still settling, order missing) can also land after the
        // claim is committed `approved`, so the refetch can unmount this
        // panel and its inline error. The page line is the signal that
        // survives; it names the claim because several panels can be open.
        onAnnounce(`${claimRef}: ${message}`, { urgent: true });
      }
      // A refusal (already decided, refund failed after approval, dispute
      // block…) can mean the row is stale: refresh it under the error.
      void utils.claims.list.invalidate();
    },
  });

  const ids = useMemo(
    () => ({
      note: `staff-claim-note-${claim.id}`,
      noteHelp: `staff-claim-note-help-${claim.id}`,
      confirm: `staff-claim-confirm-${claim.id}`,
      confirmTitle: `staff-claim-confirm-title-${claim.id}`,
    }),
    [claim.id],
  );

  // Focus the confirm step when it opens so keyboard users land on it.
  useEffect(() => {
    if (confirming) document.getElementById(ids.confirm)?.focus();
  }, [confirming, ids.confirm]);

  const undecided = isClaimUndecided(claim.status);
  const refundPending = isRefundPending(claim);
  const refundRejected = refundPending && lastErrorCode === "REFUND_REJECTED";
  const busy = review.isPending;

  const submit = (status: Decision | "under_review") => {
    if (busy) return;
    clearError();
    const trimmed = note.trim();
    review.mutate({
      claimId: claim.id,
      status,
      ...(status !== "under_review" && trimmed
        ? { resolutionNote: trimmed }
        : {}),
    });
  };

  const retryRefund = () => {
    if (busy) return;
    clearError();
    retryingRef.current = true;
    review.mutate({ claimId: claim.id, status: "approved" });
  };

  const outcomeKey =
    claim.status === "approved"
      ? claim.refundConfirmed
        ? "resaleClaim.staffOutcomeApproved"
        : null // the "Refund not confirmed" block below says it
      : claim.status === "denied"
        ? "resaleClaim.staffOutcomeDenied"
        : claim.status === "expired"
          ? "resaleClaim.staffOutcomeExpired"
          : null;

  return (
    <YStack
      id={staffClaimPanelId(claim.id)}
      role="region"
      aria-label={String(t("resaleClaim.staffPanelLabel", { claim: claimRef }))}
      gap="$4"
      padding="$4"
      borderTopWidth={2}
      borderTopColor="$borderColor"
      backgroundColor="$surface"
      minWidth={0}
      data-testid={`staff-claim-panel-${claim.id}`}
    >
      <XStack alignItems="center" gap="$2" flexWrap="wrap">
        <Text variant="h4" tag="h3" weight="bold" flex={1} minWidth={0}>
          {kindLabel}
        </Text>
        <ClaimStatusBadge status={claim.status} />
      </XStack>

      {/* Facts: grid so labels align across rows; collapses to one column. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: 12,
        }}
      >
        <Fact label={String(t("resaleClaim.staffOrder"))}>
          <Link
            href={`/platform/orders?orderId=${encodeURIComponent(claim.orderId)}`}
          >
            <Text
              variant="bodySmall"
              fontFamily="$mono"
              color="$accentText"
              textDecorationLine="underline"
            >
              {truncateId(claim.orderId)}
            </Text>
          </Link>
        </Fact>
        <Fact label={String(t("resaleClaim.staffBuyer"))}>
          <Text variant="bodySmall" fontFamily="$mono">
            {/* Staff always get the "full" view; a dash, never a crash. */}
            {claim.view === "full" ? truncateId(claim.claimantId) : "\u2014"}
          </Text>
        </Fact>
        <Fact label={String(t("resaleClaim.staffSeller"))}>
          <Text variant="bodySmall" fontFamily="$mono">
            {claim.view === "full" ? truncateId(claim.respondentId) : "\u2014"}
          </Text>
        </Fact>
        <Fact label={String(t("resaleClaim.staffFiled"))}>
          {fmtDate(fmt, claim.createdAt)}
        </Fact>
        <Fact label={String(t("resaleClaim.windowClosedColumn"))}>
          {fmtDate(fmt, claim.deadline)}
        </Fact>
        {claim.resolvedAt && (
          <Fact label={String(t("resaleClaim.staffDecided"))}>
            {fmtDate(fmt, claim.resolvedAt)}
          </Fact>
        )}
      </div>

      <YStack gap="$1">
        <Text variant="overline">
          {String(t("resaleClaim.staffBuyerSaid"))}
        </Text>
        <Text
          variant="body"
          tone={claim.evidenceText ? undefined : "muted"}
          style={PRE_WRAP}
        >
          {claim.evidenceText ?? String(t("resaleClaim.staffNoDescription"))}
        </Text>
      </YStack>

      <YStack gap="$1">
        <Text variant="overline">
          {String(t("resaleClaim.staffSellerReply"))}
        </Text>
        {claim.sellerReplyText ? (
          <>
            <Text variant="body" style={PRE_WRAP}>
              {claim.sellerReplyText}
            </Text>
            {claim.sellerRespondedAt && (
              <Text variant="caption" tone="muted">
                {String(
                  t("resaleClaim.sentOn", {
                    date: fmtDate(fmt, claim.sellerRespondedAt),
                  }),
                )}
              </Text>
            )}
          </>
        ) : claim.sellerRespondedAt ? (
          // A legacy reply whose stored shape isn't the v1 `{ reply }`.
          <Text variant="body" tone="muted">
            {String(
              t("resaleClaim.staffReplyUnreadable", {
                date: fmtDate(fmt, claim.sellerRespondedAt),
              }),
            )}
          </Text>
        ) : (
          <Text variant="body" tone="muted">
            {String(
              t(
                undecided
                  ? "resaleClaim.staffNoSellerReply"
                  : "resaleClaim.staffNoSellerReplyDecided",
              ),
            )}
          </Text>
        )}
      </YStack>

      {/* Decided: the outcome and the note the parties see. */}
      {!undecided && (
        <YStack gap="$1">
          {outcomeKey && (
            <Text variant="body" weight="bold">
              {String(t(outcomeKey))}
            </Text>
          )}
          {claim.resolutionNote && (
            <>
              <Text variant="overline">
                {String(t("resaleClaim.staffNoteLabel"))}
              </Text>
              <Text variant="body" style={PRE_WRAP}>
                {claim.resolutionNote}
              </Text>
            </>
          )}
        </YStack>
      )}

      {/* Approved, refund not confirmed: never call it refunded; retry.
          Refused by Stripe: say a retry replays the refusal, demote it. */}
      {refundPending && (
        <YStack
          gap="$3"
          padding="$4"
          borderWidth={2}
          borderColor="$danger"
          data-testid={`staff-claim-refund-pending-${claim.id}`}
        >
          <Text variant="body" weight="bold">
            {String(
              t(
                refundRejected
                  ? "resaleClaim.staffRefundRejectedTitle"
                  : "resaleClaim.staffRefundNotConfirmedTitle",
              ),
            )}
          </Text>
          <Text variant="bodySmall">
            {String(
              t(
                refundRejected
                  ? "resaleClaim.staffRefundRejectedBody"
                  : "resaleClaim.staffRefundNotConfirmedBody",
              ),
            )}
          </Text>
          {retrySent && !refundRejected && (
            <Text
              variant="bodySmall"
              weight="bold"
              data-testid={`staff-claim-refund-still-pending-${claim.id}`}
            >
              {String(t("resaleClaim.staffRefundStillPending"))}
            </Text>
          )}
          <XStack>
            <Button
              variant={refundRejected ? "secondary" : "primary"}
              size="$4"
              height="auto"
              minHeight={44}
              paddingVertical="$2"
              maxWidth="100%"
              $xs={{ width: "100%" }}
              onPress={retryRefund}
              disabled={busy}
              aria-busy={busy || undefined}
              aria-label={String(
                t(
                  refundRejected
                    ? "resaleClaim.staffRetryAnywayFor"
                    : "resaleClaim.staffRetryRefundFor",
                  { claim: claimRef },
                ),
              )}
              data-testid={`staff-claim-retry-refund-${claim.id}`}
            >
              {busy && (
                <Spinner
                  size="small"
                  color={refundRejected ? "$color" : "$colorInverted"}
                />
              )}
              {String(
                t(
                  busy
                    ? "resaleClaim.sending"
                    : refundRejected
                      ? "resaleClaim.staffRetryAnyway"
                      : "resaleClaim.staffRetryRefund",
                ),
              )}
            </Button>
          </XStack>
        </YStack>
      )}

      {/* Undecided: note + actions, or the confirm step. */}
      {undecided && (
        <YStack gap="$3">
          <YStack gap="$2">
            <label htmlFor={ids.note} style={{ cursor: "default" }}>
              <Text variant="overline">
                {String(t("resaleClaim.staffNoteLabel"))}{" "}
                <Text variant="overline" tone="muted" tag="span">
                  {String(t("resaleClaim.optional"))}
                </Text>
              </Text>
            </label>
            <Text id={ids.noteHelp} variant="bodySmall" tone="muted">
              {String(t("resaleClaim.staffNoteHelp"))}
            </Text>
            <CharCountTextarea
              id={ids.note}
              value={note}
              onChange={setNote}
              maxLength={CLAIM_RESOLUTION_NOTE_MAX}
              minHeight={72}
              maxLines={8}
              disabled={busy}
              ariaDescribedBy={ids.noteHelp}
              testIdBase={`staff-claim-note-${claim.id}`}
            />
          </YStack>

          {confirming ? (
            <YStack
              id={ids.confirm}
              tabIndex={-1}
              role="group"
              aria-labelledby={ids.confirmTitle}
              gap="$3"
              padding="$4"
              borderWidth={2}
              borderColor={
                confirming === "approved" ? "$danger" : "$borderColor"
              }
              data-testid={`staff-claim-confirm-${claim.id}`}
            >
              <Text variant="body" weight="bold" id={ids.confirmTitle}>
                {String(
                  t(
                    confirming === "approved"
                      ? "resaleClaim.staffConfirmApproveTitle"
                      : "resaleClaim.staffConfirmDenyTitle",
                    { claim: claimRef },
                  ),
                )}
              </Text>
              <Text variant="bodySmall">
                {String(
                  t(
                    confirming === "approved"
                      ? "resaleClaim.staffConfirmApproveBody"
                      : "resaleClaim.staffConfirmDenyBody",
                  ),
                )}
              </Text>
              <Text variant="bodySmall" tone="muted">
                {String(t("resaleClaim.staffBothTold"))}
              </Text>
              <XStack gap="$3" flexWrap="wrap">
                <Button
                  variant={
                    confirming === "approved" ? "destructive" : "primary"
                  }
                  size="$4"
                  height="auto"
                  minHeight={44}
                  paddingVertical="$2"
                  maxWidth="100%"
                  $xs={{ width: "100%" }}
                  onPress={() => submit(confirming)}
                  disabled={busy}
                  aria-busy={busy || undefined}
                  aria-label={String(
                    t(
                      confirming === "approved"
                        ? "resaleClaim.staffConfirmApproveFor"
                        : "resaleClaim.staffConfirmDenyFor",
                      { claim: claimRef },
                    ),
                  )}
                  data-testid={`staff-claim-confirm-${confirming}-${claim.id}`}
                >
                  {busy && <Spinner size="small" color="$colorInverted" />}
                  {String(
                    t(
                      busy
                        ? "resaleClaim.sending"
                        : confirming === "approved"
                          ? "resaleClaim.staffConfirmApprove"
                          : "resaleClaim.staffConfirmDeny",
                    ),
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="$4"
                  height="auto"
                  minHeight={44}
                  paddingVertical="$2"
                  maxWidth="100%"
                  $xs={{ width: "100%" }}
                  onPress={() => setConfirming(null)}
                  disabled={busy}
                  aria-label={String(
                    t("resaleClaim.staffConfirmBackFor", { claim: claimRef }),
                  )}
                >
                  {String(t("resaleClaim.staffConfirmBack"))}
                </Button>
              </XStack>
            </YStack>
          ) : (
            <XStack gap="$3" flexWrap="wrap">
              <Button
                variant="secondary"
                size="$4"
                height="auto"
                minHeight={44}
                paddingVertical="$2"
                maxWidth="100%"
                $xs={{ width: "100%" }}
                onPress={() => {
                  clearError();
                  setConfirming("approved");
                }}
                disabled={busy}
                aria-label={String(
                  t("resaleClaim.staffApproveFor", { claim: claimRef }),
                )}
                data-testid={`staff-claim-approve-${claim.id}`}
              >
                {String(t("resaleClaim.staffApprove"))}
              </Button>
              <Button
                variant="secondary"
                size="$4"
                height="auto"
                minHeight={44}
                paddingVertical="$2"
                maxWidth="100%"
                $xs={{ width: "100%" }}
                onPress={() => {
                  clearError();
                  setConfirming("denied");
                }}
                disabled={busy}
                aria-label={String(
                  t("resaleClaim.staffDenyFor", { claim: claimRef }),
                )}
                data-testid={`staff-claim-deny-${claim.id}`}
              >
                {String(t("resaleClaim.staffDeny"))}
              </Button>
              {claim.status === "open" && (
                <Button
                  variant="ghost"
                  size="$4"
                  height="auto"
                  minHeight={44}
                  paddingVertical="$2"
                  maxWidth="100%"
                  $xs={{ width: "100%" }}
                  onPress={() => submit("under_review")}
                  disabled={busy}
                  aria-label={String(
                    t("resaleClaim.staffMarkUnderReviewFor", {
                      claim: claimRef,
                    }),
                  )}
                  data-testid={`staff-claim-under-review-${claim.id}`}
                >
                  {busy && <Spinner size="small" color="$color" />}
                  {String(t("resaleClaim.staffMarkUnderReview"))}
                </Button>
              )}
            </XStack>
          )}
        </YStack>
      )}

      {/* Outside every status gate, so it survives the refetch that moves
          the claim from undecided to approved/denied. */}
      {lastError && (
        <Text
          variant="bodySmall"
          tone="error"
          role="alert"
          data-testid={`staff-claim-error-${claim.id}`}
        >
          {lastError}
        </Text>
      )}
    </YStack>
  );
}

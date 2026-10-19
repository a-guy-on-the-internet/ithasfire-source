"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import {
  CLAIM_TEXT_MAX,
  claimKindLabelKey,
  claimShortId,
  isClaimUndecided,
  isRefundPending,
} from "@/lib/resale-claims";

type RouterOutputs = inferRouterOutputs<AppRouter>;
export type SellerClaimRow = RouterOutputs["claims"]["listMy"]["items"][number];

// Free text keeps its line breaks and never pushes a 320px column wider.
const PRE_WRAP = {
  whiteSpace: "pre-wrap" as const,
  overflowWrap: "anywhere" as const,
};

/** The panel's DOM id, for the expander's `aria-controls`. */
export const sellerClaimPanelId = (claimId: string) =>
  `seller-claim-panel-${claimId}`;

/** Never "refunded" until the refund is confirmed (`refundConfirmed`). */
function outcomeKey(claim: SellerClaimRow): string | null {
  if (claim.status === "approved") {
    return isRefundPending(claim)
      ? "resaleClaim.sellerOutcomeApprovedPending"
      : "resaleClaim.sellerOutcomeApproved";
  }
  if (claim.status === "denied") return "resaleClaim.sellerOutcomeDenied";
  if (claim.status === "expired") return "resaleClaim.sellerOutcomeExpired";
  return null;
}

/**
 * Seller's view of one claim: what the buyer said, and the reply form while
 * support has not decided (owner ruling Q9.3: the seller can reply until
 * then). `recordSellerResponse` overwrites the reply while the claim is
 * undecided, so a sent reply can be changed.
 *
 * The buyer is shown by what they wrote only: the claim row carries no
 * contact details, and none are fetched here.
 */
export function SellerClaimPanel({
  claim,
  onDecidedBeforeReply,
}: {
  claim: SellerClaimRow;
  /**
   * Staff decided while the seller was writing. The refetch moves the row to
   * the Resolved tab and unmounts this panel, so the page says it.
   */
  onDecidedBeforeReply: () => void;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const utils = trpc.useUtils();

  const translate = useCallback(
    (key: string) => (fmt.getRawMessage(key) ? String(t(key)) : key),
    [fmt, t],
  );

  const undecided = isClaimUndecided(claim.status);
  const hasReply = !!claim.sellerReplyText;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [justSent, setJustSent] = useState(false);

  // Decided (by a refetch) while editing: drop the editor so the sent reply
  // shows again instead of vanishing behind a form that can't be sent.
  useEffect(() => {
    if (!undecided) setEditing(false);
  }, [undecided]);

  const kindKey = claimKindLabelKey(claim.kind);
  const claimRef = `${kindKey ? String(t(kindKey)) : claim.kind} ${claimShortId(claim.id)}`;

  const respond = trpc.claims.respond.useMutation({
    onSuccess: async () => {
      setEditing(false);
      setJustSent(true);
      await utils.claims.listMy.invalidate();
    },
    onError: (err) => {
      // Decided while the seller was typing: refresh so the panel shows
      // the outcome instead of a form that can no longer be sent.
      if (getAppErrorCode(err) === "CLAIM_ALREADY_RESOLVED") {
        onDecidedBeforeReply();
        void utils.claims.listMy.invalidate();
      }
    },
  });

  const ids = useMemo(
    () => ({
      reply: `seller-claim-reply-${claim.id}`,
      help: `seller-claim-reply-help-${claim.id}`,
      error: `seller-claim-reply-error-${claim.id}`,
    }),
    [claim.id],
  );

  const submitError = useMemo(() => {
    const err = respond.error;
    if (!err) return null;
    if (getAppErrorCode(err) === "CLAIM_ALREADY_RESOLVED") {
      return String(t("resaleClaim.sellerErrorResolved"));
    }
    return formatErrorMessage(err, translate);
  }, [respond.error, t, translate]);

  const send = () => {
    if (respond.isPending) return;
    const text = draft.trim();
    if (text.length === 0) {
      setFieldError(String(t("resaleClaim.sellerReplyRequired")));
      document.getElementById(ids.reply)?.focus();
      return;
    }
    setJustSent(false);
    respond.mutate({ claimId: claim.id, sellerEvidence: { reply: text } });
  };

  const dateOpts = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  } as const;

  const showForm = undecided && (!hasReply || editing);
  const busy = respond.isPending;

  return (
    <YStack
      id={sellerClaimPanelId(claim.id)}
      role="region"
      aria-label={String(
        t("resaleClaim.sellerPanelLabel", { claim: claimRef }),
      )}
      gap="$4"
      padding="$4"
      borderTopWidth={2}
      borderTopColor="$borderColor"
      backgroundColor="$surface"
      minWidth={0}
      data-testid={`seller-claim-panel-${claim.id}`}
    >
      {/* Outcome first once decided; while undecided, what happens next. */}
      {undecided ? (
        <Text variant="body">{String(t("resaleClaim.sellerNext"))}</Text>
      ) : (
        <YStack gap="$1">
          <Text variant="body" weight="bold">
            {outcomeKey(claim) ? String(t(outcomeKey(claim)!)) : claim.status}
          </Text>
          {claim.resolutionNote && (
            <>
              <Text variant="overline">
                {String(t("resaleClaim.supportNote"))}
              </Text>
              <Text variant="body" style={PRE_WRAP}>
                {claim.resolutionNote}
              </Text>
            </>
          )}
        </YStack>
      )}

      <YStack gap="$1">
        <Text variant="overline">
          {String(t("resaleClaim.sellerBuyerSaid"))}
          {kindKey ? ` · ${String(t(kindKey))}` : ""}
        </Text>
        <Text
          variant="body"
          tone={claim.evidenceText ? undefined : "muted"}
          style={PRE_WRAP}
        >
          {claim.evidenceText ?? String(t("resaleClaim.sellerNoDescription"))}
        </Text>
      </YStack>

      {/* Sent reply (read-only view) */}
      {hasReply && !editing && (
        <YStack gap="$1">
          <Text variant="overline">
            {String(t("resaleClaim.sellerYourReply"))}
          </Text>
          <Text variant="body" style={PRE_WRAP}>
            {claim.sellerReplyText}
          </Text>
          {claim.sellerRespondedAt && (
            <Text variant="caption" tone="muted">
              {String(
                t("resaleClaim.sentOn", {
                  date: fmt.dateTime(
                    new Date(claim.sellerRespondedAt),
                    dateOpts,
                  ),
                }),
              )}
            </Text>
          )}
        </YStack>
      )}

      {justSent && !editing && (
        <Text variant="bodySmall" tone="success" role="status">
          {String(t("resaleClaim.sellerReplySentStatus"))}
        </Text>
      )}

      {!undecided && !hasReply && (
        <Text variant="bodySmall" tone="muted">
          {String(t("resaleClaim.sellerNoReplyDecided"))}
        </Text>
      )}

      {undecided && hasReply && !editing && (
        <YStack gap="$2" minWidth={0} alignItems="stretch">
          <Button
            variant="secondary"
            size="$4"
            height="auto"
            minHeight={44}
            paddingVertical="$2"
            maxWidth="100%"
            $xs={{ width: "100%" }}
            $gtXs={{ alignSelf: "flex-start", width: "auto" }}
            onPress={() => {
              setDraft(claim.sellerReplyText ?? "");
              setFieldError(null);
              setJustSent(false);
              respond.reset();
              setEditing(true);
            }}
            aria-label={String(
              t("resaleClaim.sellerReplyEditFor", { claim: claimRef }),
            )}
            data-testid={`seller-claim-edit-${claim.id}`}
          >
            {String(t("resaleClaim.sellerReplyEdit"))}
          </Button>
          <Text variant="bodySmall" tone="muted" style={PRE_WRAP}>
            {String(t("resaleClaim.sellerReplyCanChange"))}
          </Text>
        </YStack>
      )}

      {/* Reply form */}
      {showForm && (
        <YStack gap="$2">
          <label htmlFor={ids.reply} style={{ cursor: "default" }}>
            <Text variant="overline">
              {String(t("resaleClaim.sellerYourReply"))}
            </Text>
          </label>
          <Text id={ids.help} variant="bodySmall" tone="muted">
            {String(t("resaleClaim.sellerReplyHelp"))}
          </Text>
          <div
            onBlur={() => {
              if (draft.trim().length === 0 && draft.length > 0) {
                setFieldError(String(t("resaleClaim.sellerReplyRequired")));
              }
            }}
          >
            <CharCountTextarea
              id={ids.reply}
              value={draft}
              onChange={(next) => {
                setDraft(next);
                if (fieldError) setFieldError(null);
              }}
              maxLength={CLAIM_TEXT_MAX}
              minHeight={96}
              maxLines={10}
              disabled={busy}
              error={!!fieldError}
              ariaDescribedBy={
                fieldError ? `${ids.help} ${ids.error}` : ids.help
              }
              testIdBase={`seller-claim-reply-${claim.id}`}
            />
          </div>
          {fieldError && (
            <Text id={ids.error} variant="bodySmall" tone="error" role="alert">
              {fieldError}
            </Text>
          )}
          {submitError && (
            <Text variant="bodySmall" tone="error" role="alert">
              {submitError}
            </Text>
          )}
          <XStack gap="$3" flexWrap="wrap" minWidth={0}>
            <Button
              variant="primary"
              size="$4"
              height="auto"
              minHeight={44}
              paddingVertical="$2"
              maxWidth="100%"
              $xs={{ width: "100%" }}
              onPress={send}
              disabled={busy}
              aria-busy={busy || undefined}
              aria-label={
                busy
                  ? undefined
                  : String(
                      t(
                        hasReply
                          ? "resaleClaim.sellerReplyUpdateFor"
                          : "resaleClaim.sellerReplySubmitFor",
                        { claim: claimRef },
                      ),
                    )
              }
              data-testid={`seller-claim-send-${claim.id}`}
            >
              {busy && <Spinner size="small" color="$colorInverted" />}
              {String(
                t(
                  busy
                    ? "resaleClaim.sending"
                    : hasReply
                      ? "resaleClaim.sellerReplyUpdate"
                      : "resaleClaim.sellerReplySubmit",
                ),
              )}
            </Button>
            {editing && (
              <Button
                variant="ghost"
                size="$4"
                height="auto"
                minHeight={44}
                paddingVertical="$2"
                maxWidth="100%"
                $xs={{ width: "100%" }}
                onPress={() => {
                  setEditing(false);
                  setFieldError(null);
                  respond.reset();
                }}
                disabled={busy}
                aria-label={String(
                  t("resaleClaim.sellerReplyCancelFor", { claim: claimRef }),
                )}
              >
                {String(t("resaleClaim.cancel"))}
              </Button>
            )}
          </XStack>
        </YStack>
      )}
    </YStack>
  );
}

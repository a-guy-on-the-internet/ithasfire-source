"use client";

import { useCallback, useState } from "react";
import { XStack } from "tamagui";
import { Button, Text, useNotify, useTranslations } from "@th/ui";
import { CalendarPlus, Check, RotateCcw, Rss } from "lucide-react";

import { trpc } from "@/trpc";
import { publicRuntimeEnv } from "@/config/env.public";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  copyTextFromPromise,
  isClipboardBlockedError,
} from "@/lib/copy-text-from-promise";

import {
  composeVolunteerFeedUrls,
  downloadIcsFile,
} from "./volunteering-helpers";

export type AddToCalendarButtonProps = {
  /**
   * Signup to export. When absent only the feed-subscribe affordance
   * renders (e.g. a page-level "subscribe to my volunteering" control).
   */
  signupId?: string;
  /** Show the "subscribe to my volunteering" feed control. Default true. */
  showFeedSubscribe?: boolean;
  /** Compact sizing for dense rows (44px min height is kept either way). */
  compact?: boolean;
};

/**
 * Per-signup `.ics` download + "subscribe to my volunteering" feed link
 * (generic-volunteering-asks FR-012). The feed URL is composed client-side
 * from the token, the same way `src/lib/calendar/calendar-actions.ts` builds
 * the venue feed URL —
 * copied as a `webcal:` link so calendar apps subscribe rather than import.
 */
export function AddToCalendarButton({
  signupId,
  showFeedSubscribe = true,
  compact = false,
}: AddToCalendarButtonProps) {
  const t = useTranslations();
  const notify = useNotify();
  const utils = trpc.useUtils();

  const [downloading, setDownloading] = useState(false);
  const [copiedFeed, setCopiedFeed] = useState(false);
  const [copiedReset, setCopiedReset] = useState(false);

  const feedTokenMutation = trpc.volunteer.ics.myFeedToken.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const rotateFeedMutation = trpc.volunteer.ics.rotateMyFeedToken.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const handleDownload = useCallback(async () => {
    if (!signupId || downloading) return;
    setDownloading(true);
    try {
      const result = await utils.volunteer.ics.mySignupIcs.fetch({ signupId });
      downloadIcsFile(result.filename, result.icsBody);
    } catch (err) {
      notify.toast.danger({
        id: "volunteer-ics-download-failed",
        title: String(t("volunteering.icsDownloadFailed")),
        message: formatErrorMessage(err, t),
      });
    } finally {
      setDownloading(false);
    }
  }, [signupId, downloading, utils, notify, t]);

  const handleSubscribe = useCallback(async () => {
    // Set when the token mutation itself rejects: the rejected payload
    // promise inside ClipboardItem makes clipboard.write() fail with a
    // NotAllowedError too, so without this the API error would masquerade
    // as a clipboard block ("try again or copy it manually" — with no link).
    let mutationError: unknown;
    try {
      // Built SYNCHRONOUSLY (no await first): Safari consumes the click's
      // transient user activation on the first await, so the clipboard write
      // must be authorized under the original gesture — copyTextFromPromise
      // hands this promise straight to ClipboardItem.
      const webcalUrlPromise = feedTokenMutation
        .mutateAsync({})
        .then(
          ({ feedToken }) =>
            composeVolunteerFeedUrls(publicRuntimeEnv.apiBaseUrl, feedToken)
              .webcalUrl,
        )
        .catch((error: unknown) => {
          mutationError = error;
          throw error;
        });
      await copyTextFromPromise(webcalUrlPromise);
      setCopiedFeed(true);
      setTimeout(() => setCopiedFeed(false), 2000);
    } catch (err) {
      console.error("volunteer feed subscribe failed", mutationError ?? err);
      notify.toast.danger({
        id: "volunteer-feed-subscribe-failed",
        title: String(t("volunteering.feedSubscribeFailed")),
        message:
          mutationError !== undefined
            ? formatErrorMessage(mutationError, t)
            : isClipboardBlockedError(err)
              ? String(t("volunteering.feedCopyBlocked"))
              : formatErrorMessage(err, t),
      });
    }
  }, [feedTokenMutation, notify, t]);

  const handleResetFeed = useCallback(async () => {
    // Rotation kills every previously subscribed calendar app — make the
    // user opt in. window.confirm matches the PromoFormDialog precedent
    // for a one-shot guard without a bespoke dialog.
    const confirmed = window.confirm(
      String(t("volunteering.resetFeedLinkConfirm")),
    );
    if (!confirmed) return;
    // See handleSubscribe: distinguishes an API failure from a genuine
    // clipboard block (the former also surfaces as a NotAllowedError).
    let mutationError: unknown;
    try {
      // window.confirm is synchronous, so the user activation is still live
      // here — build the FRESH-token URL as a promise before any await and
      // let copyTextFromPromise keep the write inside the gesture (Safari).
      const webcalUrlPromise = rotateFeedMutation
        .mutateAsync({})
        .then(
          ({ feedToken }) =>
            composeVolunteerFeedUrls(publicRuntimeEnv.apiBaseUrl, feedToken)
              .webcalUrl,
        )
        .catch((error: unknown) => {
          mutationError = error;
          throw error;
        });
      await copyTextFromPromise(webcalUrlPromise);
      setCopiedReset(true);
      setTimeout(() => setCopiedReset(false), 2000);
      notify.toast.success({
        id: "volunteer-feed-reset",
        title: String(t("volunteering.feedLinkReset")),
        message: String(t("volunteering.feedLinkResetBody")),
      });
    } catch (err) {
      console.error("volunteer feed reset failed", mutationError ?? err);
      notify.toast.danger({
        id: "volunteer-feed-reset-failed",
        title: String(t("volunteering.feedResetFailed")),
        message:
          mutationError !== undefined
            ? formatErrorMessage(mutationError, t)
            : isClipboardBlockedError(err)
              ? String(t("volunteering.feedCopyBlocked"))
              : formatErrorMessage(err, t),
      });
    }
  }, [rotateFeedMutation, notify, t]);

  const size = compact ? ("$2" as const) : ("$3" as const);

  return (
    <XStack gap="$2" alignItems="center" flexWrap="wrap">
      {signupId ? (
        <Button
          variant="outlined"
          size={size}
          minHeight={44}
          disabled={downloading}
          onPress={() => {
            void handleDownload();
          }}
          data-testid="volunteer-ics-download"
          aria-label={String(t("volunteering.addToCalendar"))}
        >
          <XStack gap="$2" alignItems="center">
            <CalendarPlus size={14} />
            <Text tone="inherit" variant="bodySmall">
              {downloading
                ? String(t("common.loading"))
                : String(t("volunteering.addToCalendar"))}
            </Text>
          </XStack>
        </Button>
      ) : null}

      {showFeedSubscribe ? (
        <Button
          variant="ghost"
          size={size}
          minHeight={44}
          disabled={feedTokenMutation.isPending}
          onPress={() => {
            void handleSubscribe();
          }}
          data-testid="volunteer-feed-subscribe"
          aria-label={String(t("volunteering.subscribeFeed"))}
        >
          <XStack gap="$2" alignItems="center">
            {copiedFeed ? <Check size={14} /> : <Rss size={14} />}
            <Text variant="bodySmall">
              {copiedFeed
                ? String(t("volunteering.feedLinkCopied"))
                : String(t("volunteering.subscribeFeed"))}
            </Text>
          </XStack>
        </Button>
      ) : null}

      {showFeedSubscribe ? (
        <Button
          variant="ghost"
          size={size}
          minHeight={44}
          disabled={rotateFeedMutation.isPending}
          onPress={() => {
            void handleResetFeed();
          }}
          data-testid="volunteer-feed-reset"
          aria-label={String(t("volunteering.resetFeedLink"))}
        >
          <XStack gap="$2" alignItems="center">
            {copiedReset ? <Check size={14} /> : <RotateCcw size={14} />}
            {/* Danger-tinted label: rotation breaks every old link. */}
            <Text variant="bodySmall" color={copiedReset ? undefined : "$danger"}>
              {copiedReset
                ? String(t("volunteering.feedLinkCopied"))
                : String(t("volunteering.resetFeedLink"))}
            </Text>
          </XStack>
        </Button>
      ) : null}
    </XStack>
  );
}

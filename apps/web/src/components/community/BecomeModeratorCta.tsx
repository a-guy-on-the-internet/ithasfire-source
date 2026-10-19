"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  CharCountTextarea,
  Modal,
  Text,
  useNotify,
  useTranslations,
} from "@th/ui";
import { ShieldCheck } from "lucide-react";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { formatErrorMessage } from "@/lib/format-error-message";
import { getAppErrorCode } from "@/lib/app-error";

const STATEMENT_MAX_LENGTH = 2000;

export type BecomeModeratorCtaProps = {
  /**
   * Visual treatment. Purely presentational — the apply behavior is
   * identical across variants.
   *
   * - `"banner"` (default) — bordered shield banner for standalone use.
   * - `"footer"` — a quiet, de-emphasized band with a thin top separator
   *   and muted surface. Used at the bottom of the community event page so
   *   recruitment stays present without competing with the listing content.
   */
  variant?: "banner" | "footer";
};

/**
 * Banner CTA inviting signed-in users to apply as community moderators
 * (community-managed-event-listings spec FR-010 — ≈ Wikipedia RfA).
 *
 * Mounted on the public event page for COMMUNITY listings (via
 * CommunityListingNotice, compact). The CTA opens a dialog with an optional
 * statement and submits community.applyToBeModerator. Friendly handling for
 * the two expected rejections: CONFLICT (already a moderator — the use
 * case's deliberate reuse of the generic 409) and
 * MODERATOR_APPLICATION_ALREADY_PENDING (one open application at a time).
 */
export function BecomeModeratorCta({
  variant = "banner",
}: BecomeModeratorCtaProps) {
  const isFooter = variant === "footer";
  const t = useTranslations();
  const { toast } = useNotify();
  const { showSignInOverlay } = useAppOverlay();

  const sessionQuery = authClient.useSession();
  const isSignedIn = Boolean(sessionQuery.data?.user);

  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState("");

  const close = () => {
    setOpen(false);
    setStatement("");
  };

  // Applications require an account (protected procedure) — route
  // signed-out visitors through sign-in and back to this page instead of
  // letting the mutation bounce with a raw UNAUTHORIZED toast.
  const handleApplyPress = () => {
    if (!isSignedIn) {
      const redirect =
        typeof window !== "undefined"
          ? `${window.location.pathname}${window.location.search}`
          : "/";
      showSignInOverlay({ redirect: redirect || "/" });
      return;
    }
    setOpen(true);
  };

  const applyMut = trpc.community.applyToBeModerator.useMutation({
    onSuccess: () => {
      toast.success({
        title: String(t("becomeModerator.successToast")),
        message: String(t("becomeModerator.successHint")),
      });
      close();
    },
    onError: (err) => {
      const code = getAppErrorCode(err);
      if (code === "CONFLICT") {
        // applyToBeModerator's only CONFLICT source is "already_moderator".
        toast.info({ title: String(t("becomeModerator.alreadyModerator")) });
        close();
        return;
      }
      if (code === "MODERATOR_APPLICATION_ALREADY_PENDING") {
        toast.info({ title: String(t("becomeModerator.alreadyPending")) });
        close();
        return;
      }
      toast.danger({
        title: String(t("becomeModerator.failedToast")),
        message: formatErrorMessage(err, (key) => String(t(key))),
      });
    },
  });

  const submit = () => {
    const trimmed = statement.trim();
    applyMut.mutate(trimmed ? { statement: trimmed } : {});
  };

  return (
    <>
      {/* Footer: quiet band — thin top separator + muted surface, so the
          recruitment ask recedes beneath the listing content. Banner:
          strict Swiss bordered shield band for standalone use. */}
      <XStack
        gap="$3"
        paddingVertical={isFooter ? "$3" : "$4"}
        paddingHorizontal={isFooter ? 0 : "$4"}
        borderWidth={isFooter ? 0 : 2}
        borderTopWidth={isFooter ? 1 : 2}
        borderColor="$borderColor"
        backgroundColor={isFooter ? "transparent" : "$surface"}
        alignItems="center"
        flexWrap="wrap"
      >
        <ShieldCheck
          size={isFooter ? 18 : 24}
          aria-hidden
          style={{ flexShrink: 0, opacity: isFooter ? 0.6 : 1 }}
        />
        <YStack flex={1} minWidth={200} gap="$1">
          <Text
            variant={isFooter ? "caption" : "bodySmall"}
            weight="bold"
            textTransform="uppercase"
            letterSpacing={0.5}
            tone={isFooter ? "muted" : undefined}
          >
            {String(t("becomeModerator.title"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("becomeModerator.body"))}
          </Text>
        </YStack>
        {/* size $3 keeps the apply button a comfortable ≥44px tap target. */}
        <Button
          variant={isFooter ? "ghost" : "secondary"}
          size="$3"
          onPress={handleApplyPress}
        >
          {String(t("becomeModerator.apply"))}
        </Button>
      </XStack>

      <Modal open={open} onClose={close}>
        <Modal.Panel width={520}>
          <Modal.Header
            title={String(t("becomeModerator.dialogTitle"))}
            onClose={close}
          />
          <Modal.Body>
            <YStack gap="$2">
              <Text
                variant="caption"
                weight="bold"
                textTransform="uppercase"
                letterSpacing={0.5}
              >
                {String(t("becomeModerator.statementLabel"))}
              </Text>
              <CharCountTextarea
                value={statement}
                onChange={setStatement}
                maxLength={STATEMENT_MAX_LENGTH}
                minHeight={96}
                placeholder={String(t("becomeModerator.statementPlaceholder"))}
                disabled={applyMut.isPending}
                testIdBase="become-moderator-statement"
              />
            </YStack>
          </Modal.Body>
          <Modal.Footer>
            <Button
              variant="ghost"
              size="$3"
              onPress={close}
              disabled={applyMut.isPending}
            >
              {String(t("becomeModerator.cancel"))}
            </Button>
            <Button
              variant="primary"
              size="$3"
              onPress={submit}
              disabled={applyMut.isPending}
            >
              {String(t("becomeModerator.submit"))}
            </Button>
          </Modal.Footer>
        </Modal.Panel>
      </Modal>
    </>
  );
}

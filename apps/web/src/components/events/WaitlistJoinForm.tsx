"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useTheme, XStack, YStack } from "tamagui";
import { Bell, Check } from "lucide-react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { Text, Button, useTranslations } from "@th/ui";
import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { getAppErrorCode } from "@/lib/app-error";
import { TURNSTILE_SITE_KEY } from "@/app/embed/[embedId]/_components/embed-helpers";

export type WaitlistJoinFormProps = {
  eventId: string;
  /** Optional organizer-provided copy above the form. */
  description?: string | null;
  /** Compact layout for mobile. */
  mobile?: boolean;
};

/**
 * "Notify me" sign-up form for upcoming events.
 * Uses the `events.joinEventWaitlist` tRPC mutation under the hood.
 *
 * Auth-aware: when the viewer is signed in, their humanId is injected
 * server-side by the tRPC `optionalProcedure`, so no email input is
 * needed. For anonymous visitors, a plain email field is shown instead.
 */
export function WaitlistJoinForm({
  eventId,
  description,
  mobile = false,
}: WaitlistJoinFormProps) {
  const theme = useTheme();
  const t = useTranslations();

  // ── Auth state ──────────────────────────────────────────────────────────
  const sessionQuery = authClient.useSession();
  // Defer session-dependent rendering until after hydration so the server
  // and initial client tree always match (avoids sign-in gate mismatch).
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    setHasMounted(true);
  }, []);
  const isSignedIn = hasMounted && Boolean(sessionQuery.data?.user);
  const userEmail = sessionQuery.data?.user?.email ?? undefined;

  const [email, setEmail] = useState("");
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Turnstile: the SERVER requires it for anonymous joins whenever it is
  // enabled (joinEventWaitlist), so mirror that — a signed-in viewer never
  // sees or needs the widget, and nothing renders without a site key.
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance | null>(null);
  const needsTurnstile = Boolean(
    hasMounted && !isSignedIn && !sessionQuery.isPending && TURNSTILE_SITE_KEY,
  );

  const joinMutation = trpc.events.joinEventWaitlist.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      setJoined(true);
      setError(null);
    },
    onError: (err) => {
      // A consumed or failed Turnstile token is dead — reset for a retry.
      turnstileRef.current?.reset();
      setTurnstileToken(null);
      const code = getAppErrorCode(err);
      if (code === "TURNSTILE_TOKEN_REQUIRED") {
        setError(String(t("errors.turnstileTokenRequired")));
      } else if (code === "TURNSTILE_VERIFICATION_FAILED") {
        setError(String(t("errors.turnstileVerificationFailed")));
      } else if (err.data?.code === "TOO_MANY_REQUESTS") {
        setError(String(t("eventDetail.notifyMeRateLimited")));
      } else if (code === "WAITLIST_FULL") {
        setError("Sign-ups are currently full.");
      } else if (code === "WAITLIST_NOT_OPEN") {
        setError("Sign-ups aren't open yet. Check back soon.");
      } else {
        setError("Something went wrong. Please try again.");
      }
    },
  });

  const handleSubmit = useCallback(() => {
    if (isSignedIn) {
      // Logged-in: no email needed; tRPC injects viewerHumanId automatically.
      setError(null);
      joinMutation.mutate({ eventId });
      return;
    }
    if (!email.trim()) return;
    if (needsTurnstile && !turnstileToken) {
      setError(String(t("eventDetail.appVerifyToContinue")));
      return;
    }
    setError(null);
    joinMutation.mutate({
      eventId,
      contactEmail: email.trim(),
      ...(turnstileToken ? { turnstileToken } : {}),
    });
  }, [
    isSignedIn,
    email,
    eventId,
    joinMutation,
    needsTurnstile,
    turnstileToken,
    t,
  ]);

  if (joined) {
    return (
      <YStack
        gap={10}
        padding={mobile ? 16 : 20}
        borderRadius={0}
        borderWidth={2}
        borderColor="$borderColor"
        backgroundColor="$surfaceMuted"
        alignItems="center"
      >
        <XStack gap={8} alignItems="center">
          <Check size={18} color={theme.success?.val} />
          <Text style={{ fontSize: 15, fontWeight: "700" }} color="$color">
            {String(t("eventDetail.notifyMeConfirmed"))}
          </Text>
        </XStack>
        <Text style={{ fontSize: 13 }} tone="muted">
          {String(t("eventDetail.notifyMeConfirmedHint"))}
        </Text>
      </YStack>
    );
  }

  return (
    <YStack
      gap={12}
      padding={mobile ? 16 : 20}
      borderRadius={0}
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surfaceMuted"
    >
      <XStack gap={8} alignItems="center">
        <Bell size={16} color={theme.accent?.val ?? theme.color?.val} />
        <Text style={{ fontSize: 15, fontWeight: "700" }} color="$color">
          {String(t("eventDetail.notifyMe"))}
        </Text>
      </XStack>

      {description && (
        <Text style={{ fontSize: 13 }} tone="muted">
          {description}
        </Text>
      )}

      {isSignedIn ? (
        /* ── Signed-in: show email hint + one-tap button ────────────── */
        <YStack gap={8}>
          {userEmail && (
            <Text style={{ fontSize: 13 }} tone="muted">
              {String(t("eventDetail.notifyMeSignedInHint")).replace(
                "{email}",
                userEmail,
              )}
            </Text>
          )}
          <Button
            variant="primary"
            size="$3"
            onPress={handleSubmit}
            disabled={joinMutation.isPending}
            data-testid="waitlist-join-btn"
          >
            {joinMutation.isPending
              ? String(t("eventDetail.notifyMeSubmitting"))
              : String(t("eventDetail.notifyMeButton"))}
          </Button>
        </YStack>
      ) : (
        /* ── Anonymous: email input + button ─────────────────────────── */
        <XStack gap={8} alignItems="flex-end" flexWrap="wrap">
          <YStack flex={1} minWidth={180}>
            <input
              type="email"
              placeholder={String(t("eventDetail.notifyMeEmailPlaceholder"))}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSubmit();
              }}
              style={{
                width: "100%",
                padding: mobile ? "10px 12px" : "10px 14px",
                fontSize: mobile ? 15 : 16,
                fontFamily: "inherit",
                borderRadius: 0,
                border: `1px solid ${theme.borderColor?.val ?? "color-mix(in srgb, var(--foreground, #211C16) 20%, transparent)"}`,
                backgroundColor: "transparent",
                color: theme.color?.val ?? "#211C16",
                // No `outline: none` — keep the UA focus ring; this input
                // has no other focus affordance.
              }}
              data-testid="waitlist-email-input"
            />
          </YStack>
          <Button
            variant="primary"
            size="$3"
            onPress={handleSubmit}
            disabled={
              joinMutation.isPending ||
              !email.trim() ||
              (needsTurnstile && !turnstileToken)
            }
            data-testid="waitlist-join-btn"
          >
            {joinMutation.isPending
              ? String(t("eventDetail.notifyMeSubmitting"))
              : String(t("eventDetail.notifyMeButton"))}
          </Button>
        </XStack>
      )}

      {needsTurnstile && (
        <YStack gap={6} data-testid="waitlist-turnstile">
          <Turnstile
            ref={turnstileRef}
            siteKey={TURNSTILE_SITE_KEY}
            options={{ theme: "light", size: "normal" }}
            onSuccess={setTurnstileToken}
            onExpire={() => setTurnstileToken(null)}
            onError={() => setTurnstileToken(null)}
          />
          {!turnstileToken && (
            <Text style={{ fontSize: 12 }} tone="muted">
              {String(t("eventDetail.appVerifyToContinue"))}
            </Text>
          )}
        </YStack>
      )}

      {error && (
        <Text style={{ fontSize: 13 }} tone="error">
          {error}
        </Text>
      )}
    </YStack>
  );
}

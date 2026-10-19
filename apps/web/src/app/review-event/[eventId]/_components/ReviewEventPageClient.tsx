"use client";

import { useEffect } from "react";
import { useRouter } from "@bprogress/next/app";
import { AlertCircle } from "lucide-react";
import { Button, Text, useTranslations, useFormatters } from "@th/ui";
import { normalizeError } from "@th/errors";
import { Stack, XStack, YStack, styled } from "tamagui";

import { authClient } from "@/lib/auth/auth-client";
import { trpc } from "@/trpc";
import { EmailVerificationRequired } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";

import { AttendeeReviewForm } from "@/app/_components/attendee-review";
import { IneligibleScreen } from "./IneligibleScreen";

// ─────────────────────────────────────────────────────────────────────────────
// Review-event page client. Owns every viewer state:
//   session pending / redirecting → skeleton
//   signed out                    → redirect to /sign-in?redirect=…
//   eligibility loading           → skeleton
//   eligibility error             → calm error + retry
//   ineligible                    → per-reason explanation (IneligibleScreen)
//   eligible                      → the conversational review form
// Eligibility is a server-enforced convenience read; submit re-checks it.
// ─────────────────────────────────────────────────────────────────────────────

const SkeletonPulse = styled(Stack, {
  name: "AttendeeReviewSkeleton",
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
  animation: "th-skeleton-pulse 1.8s ease-in-out infinite",
});

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: "100%",
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px 16px",
        background: "rgba(0, 0, 0, 0.02)",
      }}
    >
      <div style={{ width: "100%", maxWidth: 600 }}>{children}</div>
    </div>
  );
}

function FormSkeleton() {
  return (
    <YStack
      gap="$4"
      padding="$5"
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      data-testid="attendee-review-loading"
    >
      <SkeletonPulse height={3} width="40%" />
      <SkeletonPulse height={28} width="80%" />
      <SkeletonPulse height={16} width="60%" />
      <YStack gap="$2" paddingTop="$3">
        <SkeletonPulse height={56} width="100%" />
        <SkeletonPulse height={16} width="50%" />
      </YStack>
      <XStack justifyContent="flex-end" paddingTop="$3">
        <SkeletonPulse height={44} width={140} />
      </XStack>
    </YStack>
  );
}

interface ReviewEventPageClientProps {
  eventId: string;
  campaign?: string;
}

export function ReviewEventPageClient({
  eventId,
  campaign,
}: ReviewEventPageClientProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const router = useRouter();

  const session = authClient.useSession();
  const isSignedIn = Boolean(session.data?.user);
  const isSessionPending = session.isPending;

  // Signed out → sign-in with a redirect back here (matches the RequestToPlay
  // gate idiom).
  useEffect(() => {
    if (!isSessionPending && !isSignedIn) {
      router.replace(
        `/sign-in?redirect=${encodeURIComponent(`/review-event/${eventId}`)}`,
      );
    }
  }, [isSessionPending, isSignedIn, eventId, router]);

  const previewQuery = trpc.events.getGatedPreview.useQuery(
    { eventId },
    { staleTime: 60_000, retry: false },
  );

  const eligibilityQuery = trpc.attendeeReviews.getEligibility.useQuery(
    { eventId },
    { enabled: isSignedIn, retry: false, staleTime: 30_000 },
  );

  // Session resolving, or redirecting an anonymous viewer.
  if (isSessionPending || !isSignedIn) {
    return (
      <Shell>
        <FormSkeleton />
      </Shell>
    );
  }

  if (eligibilityQuery.isLoading) {
    return (
      <Shell>
        <FormSkeleton />
      </Shell>
    );
  }

  // B2: eligibility rests on tickets bought with this email, which stay
  // withheld until it is verified. Retry cannot fix that; the code can.
  if (isEmailVerificationRequired(eligibilityQuery.error)) {
    return (
      <Shell>
        <EmailVerificationRequired
          context="review"
          headingTag="h1"
          testId="attendee-review-verify-email"
        />
      </Shell>
    );
  }

  if (eligibilityQuery.error || !eligibilityQuery.data) {
    const { formError } = normalizeError(eligibilityQuery.error, (k) =>
      String(t(k)),
    );
    return (
      <Shell>
        <YStack
          alignItems="center"
          justifyContent="center"
          padding="$8"
          gap="$4"
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
          data-testid="attendee-review-error"
        >
          <AlertCircle size={28} color="var(--danger)" aria-hidden />
          <Text variant="h4" weight="bold" textAlign="center">
            {String(t("attendeeReview.error.title"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center" maxWidth={340}>
            {formError ?? String(t("attendeeReview.error.body"))}
          </Text>
          <Button
            variant="secondary"
            onPress={() => eligibilityQuery.refetch()}
          >
            {String(t("attendeeReview.error.retry"))}
          </Button>
        </YStack>
      </Shell>
    );
  }

  const eligibility = eligibilityQuery.data;

  // Any ineligible verdict stops here — never fall through to the form. A
  // null reason (shouldn't happen; core always sets one) degrades to the
  // generic ineligible copy rather than rendering the form to a barred viewer.
  if (!eligibility.eligible) {
    return (
      <Shell>
        <YStack
          borderWidth={2}
          borderColor="$borderColor"
          borderRadius={0}
        >
          <IneligibleScreen reason={eligibility.reason ?? null} t={t} />
        </YStack>
      </Shell>
    );
  }

  const eventTitle = previewQuery.data?.title;
  const deadline = eligibility.windowClosesAt
    ? fmt.dateTime(new Date(eligibility.windowClosesAt), {
        month: "short",
        day: "numeric",
      })
    : null;

  return (
    <Shell>
      <YStack gap="$3">
        {/* Event header — title + gentle deadline line. */}
        <YStack gap="$1" data-testid="attendee-review-header">
          <Text
            variant="kicker"
            tone="accent"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={1}
          >
            {String(t("attendeeReview.pageKicker"))}
          </Text>
          {eventTitle ? (
            <Text variant="h3" tag="h1" weight="bold">
              {eventTitle}
            </Text>
          ) : null}
          {deadline ? (
            <Text variant="bodySmall" tone="muted">
              {String(t("attendeeReview.deadline", { date: deadline }))}
            </Text>
          ) : null}
        </YStack>

        <AttendeeReviewForm
          eventId={eventId}
          eventSlug={previewQuery.data?.slug ?? null}
          campaign={campaign}
        />
      </YStack>
    </Shell>
  );
}

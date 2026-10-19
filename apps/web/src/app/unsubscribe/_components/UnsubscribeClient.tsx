"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, XCircle } from "lucide-react";

import { trpc } from "@/trpc";
import {
  StatusScreen,
  ButtonPrimary,
  LoadingScreen,
} from "@/components/layout/PagePrimitives";

type Status = "idle" | "processing" | "success" | "error" | "missing-params";

interface Props {
  kind: "contact_list" | "waitlist" | "org" | "review-prompts" | null;
  listId: string | null;
  eventId: string | null;
  orgId: string | null;
  humanId: string | null;
  email: string | null;
  token: string | null;
}

export function UnsubscribeClient({
  kind,
  listId,
  eventId,
  orgId,
  humanId,
  email,
  token,
}: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const calledRef = useRef(false);

  const resolvedKind = kind ?? "contact_list";
  const isWaitlist = resolvedKind === "waitlist";
  const isOrg = resolvedKind === "org";
  const isReviewPrompts = resolvedKind === "review-prompts";

  const unsubscribeMutation = trpc.announcements.unsubscribe.useMutation();
  const unsubscribeOrgMutation =
    trpc.announcements.unsubscribeOrg.useMutation();
  const unsubscribeReviewPromptsMutation =
    trpc.announcements.unsubscribeReviewPrompts.useMutation();

  useEffect(() => {
    if (calledRef.current) return;

    // Validate required params based on kind
    const hasRequiredParams = isReviewPrompts
      ? email && token && humanId
      : isOrg
        ? email && token && orgId
        : isWaitlist
          ? email && token && eventId
          : email && token && listId;

    if (!hasRequiredParams) {
      setStatus("missing-params");
      return;
    }

    calledRef.current = true;
    setStatus("processing");

    const run = isReviewPrompts
      ? unsubscribeReviewPromptsMutation.mutateAsync({
          kind: "review-prompts" as const,
          humanId: humanId!,
          email: email!,
          token: token!,
        })
      : isOrg
        ? unsubscribeOrgMutation.mutateAsync({
            orgId: orgId!,
            email: email!,
            token: token!,
          })
        : unsubscribeMutation.mutateAsync(
            isWaitlist
              ? {
                  kind: "waitlist" as const,
                  eventId: eventId!,
                  email: email!,
                  token: token!,
                }
              : {
                  kind: "contact_list" as const,
                  listId: listId!,
                  email: email!,
                  token: token!,
                },
          );

    run
      .then(() => setStatus("success"))
      .catch((err) => {
        setStatus("error");
        setErrorMessage(err?.message ?? null);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, listId, eventId, orgId, humanId, email, token]);

  const successMessage = isReviewPrompts
    ? "You\u2019ve been unsubscribed from weekly review-request emails. You\u2019ll still see review prompts in the app."
    : isOrg
      ? "You\u2019ve been unsubscribed from announcements by this organization."
      : isWaitlist
        ? "You\u2019ve been removed from this event\u2019s notification list."
        : "You won\u2019t receive any more emails from this list.";

  if (status === "idle") return null;

  if (status === "processing") {
    return <LoadingScreen message="Processing your request&hellip;" />;
  }

  if (status === "success") {
    return (
      <StatusScreen
        icon={CheckCircle2}
        iconColor="#16a34a"
        iconBg="rgba(34,197,94,0.12)"
        title="You've been unsubscribed"
        description={successMessage}
      >
        <ButtonPrimary href="/" style={{ marginTop: 8 }}>
          Go to homepage
        </ButtonPrimary>
      </StatusScreen>
    );
  }

  if (status === "error") {
    return (
      <StatusScreen
        icon={XCircle}
        iconColor="#dc2626"
        iconBg="rgba(239,68,68,0.12)"
        title="Something went wrong"
        description={
          errorMessage ??
          "We couldn\u2019t process your unsubscribe request. The link may be invalid or expired."
        }
      >
        <ButtonPrimary href="/" style={{ marginTop: 8 }}>
          Go to homepage
        </ButtonPrimary>
      </StatusScreen>
    );
  }

  // missing-params
  return (
    <StatusScreen
      icon={XCircle}
      iconColor="#dc2626"
      iconBg="rgba(239,68,68,0.12)"
      title="Invalid link"
      description="Invalid unsubscribe link. Required parameters are missing."
    >
      <ButtonPrimary href="/" style={{ marginTop: 8 }}>
        Go to homepage
      </ButtonPrimary>
    </StatusScreen>
  );
}

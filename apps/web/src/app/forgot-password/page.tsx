"use client";

import { useRouter } from "@bprogress/next/app";
import { YStack } from "tamagui";

import { useTranslations } from "@th/ui";

import { ForgotPasswordCard } from "@/components/auth/ForgotPasswordCard";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

const ForgotPasswordPage = () => {
  const router = useRouter();
  const t = useTranslations();

  useDocumentTitle(String(t("auth.fpTitle")));

  return (
    <YStack
      flex={1}
      alignItems="center"
      justifyContent="center"
      // v2 §5: side padding is `$6` on desktop and `$4` on mobile. Pinned at
      // `$6` this page gave the card 224px at a 320 viewport — 72px narrower
      // than the same card gets on /sign-in, which is what pushed a long email
      // address in the "sent" panel past the card's edge.
      padding="$4"
      $gtSm={{ padding: "$6" }}
      minHeight="60vh"
    >
      <ForgotPasswordCard
        onRequestSignInAction={() => router.push("/sign-in")}
      />
    </YStack>
  );
};

export default ForgotPasswordPage;

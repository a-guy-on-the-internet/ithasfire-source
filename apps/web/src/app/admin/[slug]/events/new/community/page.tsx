"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { YStack } from "tamagui";

import { Spinner } from "@th/ui";

import { trpc } from "@/trpc";

import { CommunityQuickCreateForm } from "./_components/CommunityQuickCreateForm";

/**
 * /admin/:slug/events/new/community — QUICK-CREATE for a community listing,
 * the exact counterpart of `/admin/:slug/events/new` for a ticketed event:
 * mint the DRAFT, then route to the real `EventBuilder` at
 * `/admin/:slug/events/:id/edit`, which is where the listing is actually
 * authored (same fields, same live preview, same publish control).
 *
 * This page used to BE the authoring experience — a standalone long form with
 * no preview and no way back into an editor. See `CommunityQuickCreateForm`
 * for what moved and what had to stay.
 *
 * Moderator-gated (FR-005): mirrors ModerateShell — loading → spinner,
 * denied/error → redirect to /access-denied before rendering anything.
 */
export default function CommunityListingCreatePage() {
  const params = useParams();
  const router = useRouter();
  const slug = typeof params?.slug === "string" ? params.slug : "";

  const accessQuery = trpc.community.checkModeratorAccess.useQuery(undefined, {
    retry: false,
    staleTime: 5 * 60_000,
  });
  const allowed = accessQuery.data?.allowed === true;

  useEffect(() => {
    if (!accessQuery.isLoading && (accessQuery.isError || !allowed)) {
      router.replace("/access-denied");
    }
  }, [accessQuery.isLoading, accessQuery.isError, allowed, router]);

  if (accessQuery.isLoading) {
    return (
      <YStack
        minHeight="60vh"
        alignItems="center"
        justifyContent="center"
        padding="$6"
        aria-busy
      >
        <Spinner size="large" />
      </YStack>
    );
  }

  if (accessQuery.isError || !allowed) {
    // Redirect effect is in flight — render nothing.
    return null;
  }

  return <CommunityQuickCreateForm slug={slug} />;
}

"use client";

import { use } from "react";
import { YStack } from "tamagui";
import { Text, Spinner, useTranslations } from "@th/ui";

import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";
import { trpc } from "@/trpc";
import { PlaceProfileEditor } from "./_components/PlaceProfileEditor";

// ─────────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────────

type PageProps = {
  params: Promise<{ slug: string; placeId: string }>;
};

function PlacePageEditorInner({ params }: PageProps) {
  const { slug, placeId } = use(params);
  const t = useTranslations();

  // Fetch place data to get verification status
  const {
    data: placeData,
    isLoading,
    error,
  } = trpc.places.getPlaceForEdit.useQuery(
    { placeId },
    { staleTime: 10_000, retry: 2, enabled: Boolean(placeId) },
  );

  if (!placeId) {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$3"
      >
        <Text variant="h3" tone="muted">
          Place not found
        </Text>
        <Text variant="body" tone="muted">
          No place ID provided.
        </Text>
      </YStack>
    );
  }

  if (isLoading) {
    return (
      <YStack
        padding="$5"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$3"
      >
        <Spinner size="lg" />
        <Text variant="body" tone="muted">
          Loading...
        </Text>
      </YStack>
    );
  }

  // ── Access / error state ───────────────────────────────────────────────
  // The [placeId] layout gates on `getPlaceTitle`, which any org member
  // passes — so a SCANNER/VIEWER/FINANCE reaches this route and then fails
  // THIS read, which sits at `canManagePlace`. Without this branch the page
  // fell through to the editor with every value defaulted: an UNVERIFIED chip
  // for a verified venue, and a page editor whose own payload had already been
  // refused. A reader who cannot have the venue deserves to be told so, not
  // handed a shell built out of fallbacks.
  if (error || !placeData?.place) {
    const isForbidden = error?.data?.code === "FORBIDDEN";
    return (
      <YStack
        padding="$6"
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$2"
        maxWidth={480}
        marginHorizontal="auto"
      >
        <Text variant="h3" textAlign="center">
          {String(
            t(
              isForbidden
                ? "admin.placeEditAccessDenied"
                : "admin.placeEditGenericError",
            ),
          )}
        </Text>
        <Text variant="body" tone="muted" textAlign="center">
          {isForbidden
            ? String(t("admin.placeEditAccessDeniedDescription"))
            : // Non-auth failures keep the server's message, exactly as
              // `layout.tsx` and `settings/page.tsx` do — it is the only
              // diagnostic a reader can quote back. FORBIDDEN never reaches
              // here, which is the point: `fail()` sets `message` to the CODE
              // (packages/errors/src/app-error.ts), so that arm used to print
              // the literal string "NOT_RESOURCE_OWNER".
              (error?.message ??
              String(t("admin.placeEditGenericErrorDescription")))}
        </Text>
      </YStack>
    );
  }

  const verificationStatus =
    placeData?.place?.verificationStatus ?? "UNVERIFIED";

  // The review switches and the rest of the page settings moved to the venue
  // settings page (FR-401); this route renders the block canvas only, so the
  // only thing it still reads off the place is the verification gate.
  return (
    <PlaceProfileEditor
      placeId={placeId}
      slug={slug}
      verificationStatus={verificationStatus}
    />
  );
}

export default function AdminPlacePageEditor({ params }: PageProps) {
  return (
    <AdminEmailVerificationGate mode="block">
      <PlacePageEditorInner params={params} />
    </AdminEmailVerificationGate>
  );
}

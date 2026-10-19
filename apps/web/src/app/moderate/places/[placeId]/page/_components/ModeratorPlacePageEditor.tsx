"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useRouter } from "@bprogress/next/app";
import { useQueryClient } from "@tanstack/react-query";
import { YStack } from "tamagui";
import {
  Alert,
  Badge,
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { PageEditorView } from "@/components/entity-pages";
import { buildEnrollTwoFactorUrl } from "@/components/community/use-second-factor-required-toast";
import { readRefusalReason } from "@/components/places/place-or-address.helpers";
import { useVenueEditorLink } from "@/app/p/[slug]/_components/useVenueEditorLink";
import { getAppErrorCode } from "@/lib/app-error";
import { formatErrorMessage } from "@/lib/format-error-message";
import {
  ArrivalAreasEditor,
  useArrivalAreasEditorEnabled,
} from "@/components/maps/ArrivalAreasEditor";
import {
  ModeratorPlaceFactsControl,
  usePlaceFactsEditable,
} from "./ModeratorPlaceFactsControl";

type Translate = ReturnType<typeof useTranslations>;

/** Why a save was refused after the editor opened (a claim or archive landed). */
type LostAccess = "OWNED" | "CLAIM_PENDING" | "ARCHIVED";

const LOST_COPY: Record<LostAccess, { title: string; body: string }> = {
  OWNED: {
    title: "communityPlacePage.lostOwnedTitle",
    body: "communityPlacePage.lostOwnedBody",
  },
  CLAIM_PENDING: {
    title: "communityPlacePage.lostClaimTitle",
    body: "communityPlacePage.lostClaimBody",
  },
  ARCHIVED: {
    title: "communityPlacePage.lostArchivedTitle",
    body: "communityPlacePage.lostArchivedBody",
  },
};

/** Probe refusal → copy. SECOND_FACTOR_REQUIRED renders its own state. */
const REFUSAL_COPY: Record<string, { title: string; body: string }> = {
  OWNED: {
    title: "communityPlacePage.refusedOwnedTitle",
    body: "communityPlacePage.refusedOwnedBody",
  },
  // The place-dialog wording already says this for place facts; the page
  // freezes for the same claim, so the same two sentences hold.
  CLAIM_PENDING: {
    title: "communityCreate.pfRefusedClaimTitle",
    body: "communityCreate.pfRefusedClaimBody",
  },
  ARCHIVED: {
    title: "communityPlacePage.refusedArchivedTitle",
    body: "communityPlacePage.refusedArchivedBody",
  },
  NOT_ACTIVE: {
    title: "communityCreate.pfRefusedNotActiveTitle",
    body: "communityCreate.pfRefusedNotActiveBody",
  },
  NOT_ALLOWED: {
    title: "communityPlacePage.refusedNotAllowedTitle",
    body: "communityPlacePage.refusedNotAllowedBody",
  },
};

/**
 * Classify a failed editor write as "the place stopped being editable", or
 * null for an ordinary failure (which the global toast already reports).
 */
export function toLostAccess(err: unknown): LostAccess | null {
  const code = getAppErrorCode(err);
  if (code === "PLACE_HAS_OWNER") {
    return readRefusalReason(err) === "CLAIM_PENDING"
      ? "CLAIM_PENDING"
      : "OWNED";
  }
  if (code === "PLACE_ARCHIVED" || code === "PLACE_NOT_ACTIVE") {
    return "ARCHIVED";
  }
  return null;
}

/**
 * Watches every `entityPages.*` write the editor makes. The editor's own
 * forms toast the refusal, but a toast fades and the next save fails the same
 * way; a claim landing mid-edit needs a standing sentence saying why.
 */
function useLostAccess(): LostAccess | null {
  const queryClient = useQueryClient();
  const [lost, setLost] = useState<LostAccess | null>(null);

  useEffect(() => {
    return queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") return;
      const key = event.mutation.options.mutationKey as unknown;
      const path = Array.isArray(key) && Array.isArray(key[0]) ? key[0] : null;
      if (path?.[0] !== "entityPages") return;
      const next = toLostAccess(event.action.error);
      if (next) setLost(next);
    });
  }, [queryClient]);

  return lost;
}

function StateBlock({
  title,
  body,
  children,
  testId,
}: {
  title: string;
  body?: string;
  children?: React.ReactNode;
  testId: string;
}) {
  return (
    <YStack
      paddingVertical="$6"
      alignItems="center"
      justifyContent="center"
      minHeight={240}
      gap="$3"
      maxWidth={480}
      width="100%"
      marginHorizontal="auto"
      data-testid={testId}
    >
      <Text variant="h3" tag="h1" textAlign="center">
        {title}
      </Text>
      {body ? (
        <Text variant="body" tone="muted" textAlign="center">
          {body}
        </Text>
      ) : null}
      {children}
    </YStack>
  );
}

/** An owner who lands here goes to their own editor under /admin. */
function OwnerRedirect({ placeId, t }: { placeId: string; t: Translate }) {
  const router = useRouter();
  const { href } = useVenueEditorLink(placeId);
  const ownerHref = href?.startsWith("/admin/") ? href : null;
  const [waited, setWaited] = useState(false);

  useEffect(() => {
    if (ownerHref) router.replace(ownerHref);
  }, [ownerHref, router]);

  // The admin slug comes from two chained reads; give them a moment before
  // offering the plain link instead.
  useEffect(() => {
    const id = window.setTimeout(() => setWaited(true), 4_000);
    return () => window.clearTimeout(id);
  }, []);

  if (ownerHref || !waited) {
    return (
      <StateBlock
        title={String(t("communityPlacePage.ownerRedirect"))}
        testId="moderator-place-page-owner-redirect"
      >
        <Spinner size="lg" />
      </StateBlock>
    );
  }
  return (
    <StateBlock
      title={String(t("communityPlacePage.ownerNoSlug"))}
      testId="moderator-place-page-owner-no-slug"
    >
      <NextLinkAnchor
        href="/admin"
        aria-label={String(t("communityPlacePage.ownerOpenAdmin"))}
      >
        {/* Decoration only: the anchor is the control (see PlaceProfileEditor). */}
        <Button
          tag="span"
          variant="secondary"
          size="$3"
          aria-hidden
          tabIndex={-1}
        >
          {String(t("communityPlacePage.ownerOpenAdmin"))}
        </Button>
      </NextLinkAnchor>
    </StateBlock>
  );
}

export function ModeratorPlacePageEditor({ placeId }: { placeId: string }) {
  const t = useTranslations();
  const pathname = usePathname();
  const lost = useLostAccess();
  // Hooks run before the gate's early returns.
  const factsEditable = usePlaceFactsEditable(placeId);
  const arrivalAreasEnabled = useArrivalAreasEditorEnabled();

  const accessQuery = trpc.entityPages.placePageEditAccess.useQuery(
    { placeId },
    { retry: false, staleTime: 10_000, meta: { silent: true } },
  );
  const access = accessQuery.data;

  if (accessQuery.isLoading) {
    return (
      <YStack padding="$6" alignItems="center" minHeight={240} aria-busy>
        <Spinner size="lg" />
      </YStack>
    );
  }

  // Only with no answer at all: a failed background refetch keeps the last
  // answer, so it must not unmount an editor with unsaved work in it.
  if (!access) {
    return (
      <StateBlock
        title={String(t("communityPlacePage.checkFailed"))}
        body={
          accessQuery.error
            ? formatErrorMessage(accessQuery.error, t)
            : undefined
        }
        testId="moderator-place-page-check-failed"
      >
        <Button
          variant="secondary"
          size="$3"
          onPress={() => void accessQuery.refetch()}
        >
          {String(t("communityPlacePage.tryAgain"))}
        </Button>
      </StateBlock>
    );
  }

  if (access.editorKind === "owner") {
    return <OwnerRedirect placeId={placeId} t={t} />;
  }

  if (!access.canEditPage || access.editorKind !== "community_moderator") {
    if (access.reason === "SECOND_FACTOR_REQUIRED") {
      return (
        <StateBlock
          title={String(t("communityCreate.pfSecondFactorTitle"))}
          body={String(t("communityPlacePage.secondFactorBody"))}
          testId="moderator-place-page-second-factor"
        >
          <NextLinkAnchor
            href={buildEnrollTwoFactorUrl(pathname)}
            aria-label={String(t("communityPlacePage.secondFactorLink"))}
          >
            <Button
              tag="span"
              variant="primary"
              size="$3"
              aria-hidden
              tabIndex={-1}
            >
              {String(t("communityPlacePage.secondFactorLink"))}
            </Button>
          </NextLinkAnchor>
        </StateBlock>
      );
    }
    const copy =
      REFUSAL_COPY[access.reason ?? "NOT_ALLOWED"] ?? REFUSAL_COPY.NOT_ALLOWED!;
    return (
      <StateBlock
        title={String(t(copy.title))}
        body={String(t(copy.body))}
        testId={`moderator-place-page-refused-${(access.reason ?? "NOT_ALLOWED").toLowerCase()}`}
      />
    );
  }

  return (
    <YStack gap="$4" width="100%">
      {lost ? (
        <Alert
          tone="warning"
          role="alert"
          title={String(t(LOST_COPY[lost].title))}
          description={String(t(LOST_COPY[lost].body))}
          testID="moderator-place-page-lost-access"
        />
      ) : null}
      {/* `showSettings` stays on: bio, images, visibility and theme are page
          content a moderator has parity on (D2). Place facts (name, address,
          pin) stay outside the page draft; for a PLACE the profile form drops
          the display name, and the header's "Edit place details" opens the
          community place edit for them. */}
      <PageEditorView
        ownerType="PLACE"
        ownerId={placeId}
        title={String(t("communityPlacePage.editorTitle"))}
        headerBadge={
          <Badge tone="neutral" size="sm">
            {String(t("communityPlacePage.editorBadge"))}
          </Badge>
        }
        headerActions={<ModeratorPlaceFactsControl placeId={placeId} />}
        // No sentence while the check loads: none beats a wrong one.
        placeNameHint={
          factsEditable === "loading"
            ? ""
            : String(
                t(
                  factsEditable === "editable"
                    ? "communityPlacePage.nameHintFacts"
                    : "communityPlacePage.nameHintLocked",
                ),
              )
        }
      />
      {arrivalAreasEnabled ? <ModeratorArrivalAreas placeId={placeId} /> : null}
    </YStack>
  );
}

/**
 * Getting there on an unowned place (arrival-areas FR-016): the same editor
 * the place settings page mounts. Core answers who may write (an unowned
 * place admits community moderators) and which pin this editor measures from
 * (`listForEditor.pin`: the true pin where the place publishes its address,
 * none where it hides it).
 */
function ModeratorArrivalAreas({ placeId }: { placeId: string }) {
  const t = useTranslations();
  const headingId = `moderator-getting-there-${placeId}`;
  return (
    <YStack
      tag="section"
      aria-labelledby={headingId}
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surface"
      borderRadius={0}
      padding="$4"
      gap="$3"
      data-testid="moderator-place-getting-there"
    >
      <Text variant="overline" weight="bold" tag="h2" id={headingId}>
        {String(t("arrivalAreasEditor.heading"))}
      </Text>
      <ArrivalAreasEditor parent={{ placeId }} formHeadingLevel={3} />
    </YStack>
  );
}

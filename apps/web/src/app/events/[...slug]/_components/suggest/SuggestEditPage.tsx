"use client";

import { XStack, YStack } from "tamagui";
import { PenLine } from "lucide-react";

import {
  Button,
  NextLinkAnchor,
  Spinner,
  Text,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";

import { ProposeEditsForm, type SuggestionBaseData } from "./ProposeEditsForm";

/**
 * Public propose-mode page body (/events/<slug>/suggest —
 * community-managed-event-listings spec FR-006). Hydrates the whitelisted
 * base via the PUBLIC `eventSuggestions.getBaseForEvent` query (anonymous
 * viewers included) and renders the propose form.
 *
 * Error collapse mirrors the query's contract:
 * - FORBIDDEN — password/application-gated event: this surface never leaks
 *   gated details, so it shows a "doesn't accept public suggestions" band.
 * - NOT_FOUND — unpublished/private/unknown: an unavailable band (the server
 *   deliberately collapses those cases so we can't tell them apart).
 */
export function SuggestEditPage({ slug }: { slug: string }) {
  const t = useTranslations();

  const baseQuery = trpc.eventSuggestions.getBaseForEvent.useQuery(
    { slug },
    { retry: false, staleTime: 30_000 },
  );

  const eventHref = `/events/${slug}`;

  let content: React.ReactNode;
  if (baseQuery.isLoading) {
    content = (
      <YStack alignItems="center" justifyContent="center" padding="$6" aria-busy>
        <Spinner size="large" />
      </YStack>
    );
  } else if (baseQuery.isError) {
    const trpcCode = (baseQuery.error as { data?: { code?: string } }).data
      ?.code;
    if (trpcCode === "FORBIDDEN") {
      content = (
        <NoticeBand
          title={String(t("suggestEdit.gatedTitle"))}
          body={String(t("suggestEdit.gatedBody"))}
          backHref={eventHref}
          backLabel={String(t("suggestEdit.backToEvent"))}
        />
      );
    } else if (trpcCode === "NOT_FOUND") {
      content = (
        <NoticeBand
          title={String(t("suggestEdit.notFoundTitle"))}
          body={String(t("suggestEdit.notFoundBody"))}
          backHref="/"
          backLabel={String(t("suggestEdit.backHome"))}
        />
      );
    } else {
      content = (
        <YStack
          gap="$3"
          padding="$4"
          borderWidth={2}
          borderColor="$borderColor"
          backgroundColor="$surface"
        >
          <Text variant="body" tone="error" role="alert">
            {String(t("suggestEdit.loadError"))}
          </Text>
          <YStack alignItems="flex-start">
            <Button
              variant="secondary"
              size="$3"
              onPress={() => void baseQuery.refetch()}
            >
              {String(t("suggestEdit.retry"))}
            </Button>
          </YStack>
        </YStack>
      );
    }
  } else if (baseQuery.data) {
    // No cast: the query output IS SuggestionBaseData (derived from the
    // router in ProposeEditsForm), so schema drift fails compilation here.
    const data: SuggestionBaseData = baseQuery.data;
    content = (
      <YStack gap="$5">
        <YStack
          gap="$2"
          borderBottomWidth={2}
          borderBottomColor="$borderColor"
          paddingBottom="$4"
        >
          <YStack gap="$1">
            <XStack gap="$2" alignItems="center">
              <PenLine size={18} aria-hidden />
              <Text
                variant="h3"
                weight="bold"
                textTransform="uppercase"
                letterSpacing={1}
                tag="h1"
              >
                {String(t("suggestEdit.pageTitle"))}
              </Text>
            </XStack>
            <NextLinkAnchor href={eventHref} textDecorationLine="none">
              <Text variant="body" weight="bold" tone="accent">
                {data.base.title}
              </Text>
            </NextLinkAnchor>
          </YStack>
          <Text variant="bodySmall" tone="muted">
            {String(t("suggestEdit.pageSubtitle"))}
          </Text>
        </YStack>
        <ProposeEditsForm data={data} />
      </YStack>
    );
  } else {
    content = null;
  }

  return (
    <YStack
      width="100%"
      maxWidth={760}
      alignSelf="center"
      marginHorizontal="auto"
      paddingHorizontal="$4"
      paddingVertical="$5"
    >
      {content}
    </YStack>
  );
}

function NoticeBand({
  title,
  body,
  backHref,
  backLabel,
}: {
  title: string;
  body: string;
  backHref: string;
  backLabel: string;
}) {
  return (
    <YStack
      alignItems="center"
      gap="$3"
      padding="$6"
      borderWidth={2}
      borderColor="$borderColor"
      backgroundColor="$surface"
    >
      <Text variant="h3" weight="bold" textAlign="center" tag="h1">
        {title}
      </Text>
      <Text variant="body" tone="muted" textAlign="center" maxWidth={460}>
        {body}
      </Text>
      <NextLinkAnchor href={backHref} textDecorationLine="none">
        <Text variant="body" tone="accent" weight="bold">
          {backLabel}
        </Text>
      </NextLinkAnchor>
    </YStack>
  );
}

SuggestEditPage.displayName = "SuggestEditPage";

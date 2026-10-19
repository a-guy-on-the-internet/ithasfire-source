"use client";

import { useState } from "react";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";
import { YStack, XStack } from "tamagui";
import {
  Button,
  Text,
  Spinner,
  Switch,
  LabeledTextInput,
  NextLinkAnchor,
  useTranslations,
  useNotify,
} from "@th/ui";
import { FOLLOW_NEARBY_DEFAULT_RADIUS_KM } from "@th/core/use-cases/follows/schemas";
import { trpc } from "@/trpc";
import { SectionCard } from "./settings-primitives";

type Follow =
  inferRouterOutputs<AppRouter>["follows"]["listFollowedEntities"]["items"][number];

function FollowingRow({ follow }: { follow: Follow }) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();
  const [draft, setDraft] = useState<{
    notifyNewEvents: boolean;
    notifyNearby: boolean;
    radius: string;
  } | null>(null);
  const prefs = draft ?? {
    notifyNewEvents: follow.notifyNewEvents,
    notifyNearby: follow.notifyNearby,
    radius: String(follow.radiusKm ?? FOLLOW_NEARBY_DEFAULT_RADIUS_KM),
  };
  const [error, setError] = useState<string | null>(null);
  const [radiusError, setRadiusError] = useState(false);
  const update = trpc.follows.updateFollowPrefs.useMutation();
  const unfollow = trpc.follows.unfollowEntity.useMutation();
  const busy = update.isPending || unfollow.isPending;
  const radius = Number(prefs.radius);
  const validRadius = Number.isInteger(radius) && radius >= 1 && radius <= 500;
  const save = () => {
    setError(null);
    if (prefs.notifyNewEvents && prefs.notifyNearby && !validRadius) {
      setRadiusError(true);
      return;
    }
    update.mutate(
      {
        entityPageId: follow.entityPageId,
        notifyNewEvents: prefs.notifyNewEvents,
        notifyNearby: prefs.notifyNearby,
        // An omitted radius keeps the stored one, so a hidden field holding
        // an invalid value never overwrites it.
        ...(validRadius ? { radiusKm: radius } : {}),
      },
      {
        onSuccess: () => {
          void utils.follows.listFollowedEntities.invalidate().then(() => {
            // A new edit may have happened while the list refreshed.
            setDraft((current) => (current === prefs ? null : current));
          });
          toast.success({ title: String(t("account.sFollowingSaved")) });
        },
        onError: () => setError(String(t("account.sFollowingSaveError"))),
      },
    );
  };
  const remove = () => {
    setError(null);
    unfollow.mutate(
      { entityPageId: follow.entityPageId },
      {
        onSuccess: () => {
          void Promise.all([
            utils.follows.listFollowedEntities.invalidate(),
            utils.follows.isFollowing.invalidate({
              entityPageId: follow.entityPageId,
            }),
            utils.follows.getFollowerCount.invalidate({
              entityPageId: follow.entityPageId,
            }),
          ]);
        },
        onError: () => setError(String(t("account.sFollowingUnfollowError"))),
      },
    );
  };
  return (
    <YStack
      gap="$3"
      paddingVertical="$4"
      borderTopWidth={2}
      borderTopColor="$borderColor"
    >
      <NextLinkAnchor href={`/p/${follow.slug}`}>
        <Text variant="body" weight="bold">
          {follow.displayName}
        </Text>
      </NextLinkAnchor>
      <XStack gap="$3" alignItems="center" justifyContent="space-between">
        <Text variant="bodySmall" flexShrink={1}>
          {String(t("account.sFollowingEvents"))}
        </Text>
        <Switch
          checked={prefs.notifyNewEvents}
          disabled={busy}
          onCheckedChange={(value: boolean) =>
            setDraft({ ...prefs, notifyNewEvents: value })
          }
          aria-label={String(
            t("account.sFollowingEventsAria", { name: follow.displayName }),
          )}
        />
      </XStack>
      <XStack gap="$3" alignItems="center" justifyContent="space-between">
        <Text variant="bodySmall" flexShrink={1}>
          {String(t("account.sFollowingNearby"))}
        </Text>
        <Switch
          checked={prefs.notifyNearby}
          disabled={busy || !prefs.notifyNewEvents}
          onCheckedChange={(value: boolean) =>
            setDraft({ ...prefs, notifyNearby: value })
          }
          aria-label={String(
            t("account.sFollowingNearbyAria", { name: follow.displayName }),
          )}
        />
      </XStack>
      {prefs.notifyNearby && prefs.notifyNewEvents ? (
        <LabeledTextInput
          label={String(t("account.sFollowingRadius"))}
          aria-label={`${String(t("account.sFollowingRadius"))}: ${follow.displayName}`}
          name={`follow-radius-${follow.followId}`}
          value={prefs.radius}
          keyboardType="numeric"
          disabled={busy}
          onChangeText={(value: string) => {
            setDraft({ ...prefs, radius: value });
            setRadiusError(false);
          }}
          onBlur={() => setRadiusError(!validRadius)}
          labelVariant="overline"
          status={radiusError ? "error" : undefined}
          helperText={
            radiusError ? String(t("account.sFollowingRadiusError")) : undefined
          }
        />
      ) : null}
      {error ? (
        <Text role="alert" variant="bodySmall">
          {error}
        </Text>
      ) : null}
      <XStack gap="$3" flexWrap="wrap">
        <Button
          variant="outlined"
          disabled={busy || draft === null}
          onPress={save}
          aria-label={`${String(t("account.sFollowingSave"))}: ${follow.displayName}`}
        >
          {String(t("account.sFollowingSave"))}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onPress={remove}
          aria-label={`${String(t("account.sFollowingUnfollow"))}: ${follow.displayName}`}
        >
          {String(t("account.sFollowingUnfollow"))}
        </Button>
        {busy ? <Spinner size="sm" /> : null}
      </XStack>
    </YStack>
  );
}

export function FollowingSection() {
  const t = useTranslations();
  const query = trpc.follows.listFollowedEntities.useInfiniteQuery(
    { limit: 20 },
    { getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined },
  );
  const follows = query.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <SectionCard>
      <Text variant="h4" weight="bold">
        {String(t("account.sFollowingTitle"))}
      </Text>
      <Text variant="bodySmall" tone="muted">
        {String(t("account.sFollowingDesc"))}
      </Text>
      <Text variant="caption" tone="muted">
        {String(t("account.sFollowingLocation"))}
      </Text>
      {query.isLoading ? <Spinner size="sm" /> : null}
      {query.isError ? (
        <YStack gap="$2">
          <Text role="alert">{String(t("account.sFollowingLoadError"))}</Text>
          <Button
            variant="outlined"
            disabled={query.isFetching}
            onPress={() => void query.refetch()}
          >
            {String(t("account.sFollowingRetry"))}
          </Button>
        </YStack>
      ) : null}
      {!query.isLoading && !query.isError && follows.length === 0 ? (
        <Text tone="muted">{String(t("account.sFollowingEmpty"))}</Text>
      ) : null}
      {follows.map((follow) => (
        <FollowingRow key={follow.followId} follow={follow} />
      ))}
      {query.hasNextPage ? (
        <Button
          variant="outlined"
          disabled={query.isFetching}
          onPress={() => void query.fetchNextPage()}
        >
          {String(t("account.sFollowingMore"))}
        </Button>
      ) : null}
    </SectionCard>
  );
}

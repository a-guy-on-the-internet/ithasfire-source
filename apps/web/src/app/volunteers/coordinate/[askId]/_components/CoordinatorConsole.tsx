"use client";

import { useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Button,
  NextLinkAnchor,
  StyledSelect,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Megaphone, ShieldAlert, UserPlus } from "lucide-react";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { formatErrorMessage } from "@/lib/format-error-message";
import { EmailVerificationRequired } from "@/components/auth/EmailVerificationRequired";
import { isEmailVerificationRequired } from "@/lib/email-verification-required";
import { VolunteerGroupCard } from "@/components/volunteering/VolunteerGroupCard";
import {
  BroadcastComposer,
  type BroadcastScopeOption,
} from "@/components/volunteering/BroadcastComposer";
import {
  volunteerConflictMessageKey,
  type RewardBadgeStatus,
  type SignupStatus,
} from "@/components/volunteering/volunteering-helpers";

export type CoordinatorConsoleProps = {
  askId: string;
};

function trpcErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: { code?: unknown } }).data;
  return typeof data?.code === "string" ? data.code : null;
}

/**
 * Coordinator console (/volunteers/coordinate/[askId] — the URL emailed by
 * coordinator-assigned notifications). Powered by `roster.coordinator`,
 * which returns ONLY the actor's group(s) with their members (NFR-003) —
 * a coordinator needs zero org roles for this page to work.
 *
 * The general pool panel reads `signups.listByAsk` POOL scope — the
 * coordinator-safe pool view (unassigned APPROVED only) — so coordinators
 * can pull volunteers straight into a group they coordinate (FR-005).
 */
export function CoordinatorConsole({ askId }: CoordinatorConsoleProps) {
  const t = useTranslations();
  const session = authClient.useSession();
  const isSignedIn = Boolean(session.data?.user);
  const sessionPending = session.isPending;

  // Cursor-paginated roster (sequential across the actor's groups): a group
  // whose members span a page boundary reappears on the next page carrying
  // the continuation, so pages are merged by group id with signups
  // concatenated (deduped — a member can shift across a boundary when
  // rosters change mid-scroll).
  const rosterQuery = trpc.volunteer.roster.coordinator.useInfiniteQuery(
    { askId },
    {
      enabled: isSignedIn,
      staleTime: 15_000,
      retry: false,
      meta: { silent: true },
      getNextPageParam: (last) => last.nextCursor ?? undefined,
    },
  );

  type RosterPage = NonNullable<
    typeof rosterQuery.data
  >["pages"][number];
  type RosterGroup = RosterPage["groups"][number];

  const groups = useMemo<RosterGroup[]>(() => {
    const byId = new Map<string, RosterGroup>();
    const seenSignupIds = new Set<string>();
    for (const page of rosterQuery.data?.pages ?? []) {
      for (const group of page.groups) {
        const freshSignups = group.signups.filter(
          (s) => !seenSignupIds.has(s.id),
        );
        for (const s of freshSignups) seenSignupIds.add(s.id);
        const existing = byId.get(group.id);
        if (existing) {
          byId.set(group.id, {
            ...existing,
            signups: [...existing.signups, ...freshSignups],
          });
        } else {
          byId.set(group.id, { ...group, signups: freshSignups });
        }
      }
    }
    return [...byId.values()];
  }, [rosterQuery.data]);

  // Coordinator-scoped pool read: available once we know the actor
  // coordinates at least one group here.
  const poolQuery = trpc.volunteer.signups.listByAsk.useQuery(
    { askId, scope: { kind: "POOL" } },
    {
      enabled: isSignedIn && groups.length > 0,
      staleTime: 15_000,
      retry: false,
      meta: { silent: true },
    },
  );

  const [broadcastScopeId, setBroadcastScopeId] = useState<string | null>(
    null,
  );

  const utils = trpc.useUtils();
  const invalidate = () =>
    Promise.all([
      utils.volunteer.roster.coordinator.invalidate({ askId }),
      utils.volunteer.signups.listByAsk.invalidate(),
    ]);

  const ownGroupOptions = useMemo(
    () => groups.map((g) => ({ id: g.id, name: g.name })),
    [groups],
  );

  const broadcastScopes = useMemo<BroadcastScopeOption[]>(
    () =>
      groups.map((group) => ({
        id: `group:${group.id}`,
        label: String(
          t("volunteering.broadcastScopeGroup", { name: group.name }),
        ),
        scope: { kind: "GROUP" as const, groupId: group.id },
      })),
    [groups, t],
  );

  // ── Auth / error states ─────────────────────────────────────────────────

  if (sessionPending) {
    return (
      <YStack paddingVertical="$8" alignItems="center" role="status">
        <Text color="$colorMuted">{String(t("common.loading"))}</Text>
      </YStack>
    );
  }

  if (!isSignedIn) {
    return (
      <YStack gap="$3" alignItems="center" paddingVertical="$8">
        <Text variant="h3" weight="bold" textAlign="center">
          {String(t("volunteering.coordinateSignInTitle"))}
        </Text>
        <Text variant="body" tone="muted" textAlign="center" maxWidth={420}>
          {String(t("volunteering.coordinateSignInBody"))}
        </Text>
        <Button variant="primary" size="$3" minHeight={44} asChild>
          <NextLinkAnchor
            href={`/sign-in?redirect=${encodeURIComponent(
              `/volunteers/coordinate/${askId}`,
            )}`}
          >
            {String(t("volunteering.coordinateSignInCta"))}
          </NextLinkAnchor>
        </Button>
      </YStack>
    );
  }

  if (rosterQuery.isLoading) {
    return (
      <YStack paddingVertical="$8" alignItems="center" role="status">
        <Text color="$colorMuted">{String(t("common.loading"))}</Text>
      </YStack>
    );
  }

  // B2: an unverified coordinator still holds the seat; it opens once the
  // email is verified. Checked before FORBIDDEN, which would read "you don't
  // coordinate a group here".
  if (isEmailVerificationRequired(rosterQuery.error)) {
    return (
      <YStack paddingVertical="$8" alignItems="center" width="100%">
        <EmailVerificationRequired
          context="coordinator"
          headingTag="h1"
          testId="coordinator-verify-email"
        />
      </YStack>
    );
  }

  if (rosterQuery.isError) {
    const code = trpcErrorCode(rosterQuery.error);
    if (code === "FORBIDDEN") {
      return (
        <YStack
          gap="$3"
          alignItems="center"
          paddingVertical="$8"
          data-testid="coordinator-forbidden"
        >
          <ShieldAlert size={32} color="var(--colorMuted)" />
          <Text variant="h3" weight="bold" textAlign="center">
            {String(t("volunteering.coordinateForbiddenTitle"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center" maxWidth={420}>
            {String(t("volunteering.coordinateForbiddenBody"))}
          </Text>
        </YStack>
      );
    }
    if (code === "NOT_FOUND") {
      return (
        <YStack gap="$3" alignItems="center" paddingVertical="$8">
          <Text variant="h3" weight="bold" textAlign="center">
            {String(t("volunteering.publicNotFoundTitle"))}
          </Text>
          <Text variant="body" tone="muted" textAlign="center" maxWidth={420}>
            {String(t("volunteering.publicNotFoundBody"))}
          </Text>
        </YStack>
      );
    }
    return (
      <YStack gap="$3" alignItems="center" paddingVertical="$8">
        <Text variant="body" tone="muted" textAlign="center">
          {formatErrorMessage(rosterQuery.error)}
        </Text>
        <Button
          variant="outlined"
          size="$3"
          minHeight={44}
          onPress={() => {
            void rosterQuery.refetch();
          }}
        >
          {String(t("volunteering.retryCta"))}
        </Button>
      </YStack>
    );
  }

  // POOL is coordinator-readable now; a FORBIDDEN here shouldn't happen
  // for anyone who got this far, but degrade by hiding the panel.
  const poolForbidden =
    poolQuery.isError && trpcErrorCode(poolQuery.error) === "FORBIDDEN";
  const showPoolPanel = groups.length > 0 && !poolForbidden;
  const poolItems = poolQuery.data?.items ?? [];

  // ── Console ─────────────────────────────────────────────────────────────

  return (
    <YStack gap="$4" data-testid="coordinator-console">
      <XStack
        gap="$3"
        alignItems="flex-start"
        justifyContent="space-between"
        flexWrap="wrap"
      >
        <YStack gap="$1" flex={1} minWidth={240}>
          <Text tag="h1" variant="h2" weight="bold">
            {String(t("volunteering.coordinateTitle"))}
          </Text>
          <Text variant="body" tone="muted">
            {String(t("volunteering.coordinateSubtitle"))}
          </Text>
        </YStack>
        {broadcastScopes.length > 0 ? (
          <Button
            variant="primary"
            size="$2"
            minHeight={44}
            onPress={() =>
              setBroadcastScopeId(broadcastScopes[0]?.id ?? null)
            }
            data-testid="coordinator-broadcast"
          >
            <XStack gap="$2" alignItems="center">
              <Megaphone size={14} />
              <Text tone="inherit" variant="bodySmall">
                {String(t("volunteering.broadcastCta"))}
              </Text>
            </XStack>
          </Button>
        ) : null}
      </XStack>

      {groups.map((group) => (
        <VolunteerGroupCard
          key={group.id}
          group={{
            id: group.id,
            name: group.name,
            description: group.description,
            capacity: group.capacity,
            memberCount: group.memberCount,
            coordinator: group.coordinator,
          }}
          signups={group.signups.map((s) => ({
            id: s.id,
            contactName: s.contactName,
            contactEmail: s.contactEmail,
            status: s.status as SignupStatus,
            groupId: s.groupId,
            roleId: s.roleId,
            createdAt: s.createdAt,
            // Read-only comp-reward status (coordinators SEE, never configure).
            // Surfaced the moment the coordinator roster read carries it; the
            // field is optional so the badge is silent until then.
            rewardStatus:
              (s as { rewardStatus?: RewardBadgeStatus | null }).rewardStatus ??
              null,
          }))}
          assignableGroups={ownGroupOptions}
          onBroadcast={() => setBroadcastScopeId(`group:${group.id}`)}
          onChanged={() => {
            void invalidate();
          }}
        />
      ))}

      {rosterQuery.hasNextPage ? (
        <XStack>
          <Button
            variant="outlined"
            size="$2"
            minHeight={44}
            disabled={rosterQuery.isFetchingNextPage}
            onPress={() => {
              void rosterQuery.fetchNextPage();
            }}
            data-testid="coordinator-roster-load-more"
          >
            {String(
              t(
                rosterQuery.isFetchingNextPage
                  ? "common.loading"
                  : "volunteering.loadMoreCta",
              ),
            )}
          </Button>
        </XStack>
      ) : null}

      {showPoolPanel ? (
        <YStack
          gap="$3"
          borderTopWidth={1}
          borderTopColor="$borderColor"
          paddingTop="$4"
          data-testid="coordinator-pool"
        >
          <Text tag="h2" variant="h4" weight="bold" style={{ textTransform: "uppercase" }}>
            {String(t("volunteering.poolSection"))}
          </Text>
          <Text variant="caption" tone="muted">
            {String(t("volunteering.coordinatePoolHint"))}
          </Text>
          {poolQuery.isLoading ? (
            <Text variant="bodySmall" tone="muted" role="status">
              {String(t("common.loading"))}
            </Text>
          ) : poolQuery.isError ? (
            <XStack gap="$2" alignItems="center" flexWrap="wrap">
              <Text variant="bodySmall" tone="muted">
                {formatErrorMessage(poolQuery.error)}
              </Text>
              <Button
                variant="outlined"
                size="$2"
                minHeight={44}
                onPress={() => {
                  void poolQuery.refetch();
                }}
              >
                {String(t("volunteering.retryCta"))}
              </Button>
            </XStack>
          ) : poolItems.length === 0 ? (
            <Text variant="bodySmall" tone="muted">
              {String(t("volunteering.poolEmpty"))}
            </Text>
          ) : (
            poolItems.map((signup) => (
              <PoolPullRow
                key={signup.id}
                signup={{
                  id: signup.id,
                  contactName: signup.contactName,
                  contactEmail: signup.contactEmail,
                  createdAt: signup.createdAt,
                }}
                groups={ownGroupOptions}
                onPulled={() => {
                  void invalidate();
                }}
              />
            ))
          )}
        </YStack>
      ) : null}

      <BroadcastComposer
        askId={askId}
        open={broadcastScopeId !== null}
        scopes={broadcastScopes}
        initialScopeId={broadcastScopeId ?? undefined}
        onClose={() => setBroadcastScopeId(null)}
      />
    </YStack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool pull row
// ─────────────────────────────────────────────────────────────────────────────

/** Sentinel for the multi-group picker's unselected state. */
const PULL_PLACEHOLDER_VALUE = "";

/**
 * One general-pool volunteer with a "pull into my group" action backed by
 * `signups.assignToGroup` (coordinator scope: pool → own group). A single
 * coordinated group gets a one-tap button; multiple groups get a picker.
 */
function PoolPullRow({
  signup,
  groups,
  onPulled,
}: {
  signup: {
    id: string;
    contactName: string | null;
    contactEmail: string;
    createdAt: Date | string;
  };
  groups: { id: string; name: string }[];
  onPulled: () => void;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  const notify = useNotify();

  const assignMutation = trpc.volunteer.signups.assignToGroup.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: (_data, variables) => {
      const groupName =
        groups.find((g) => g.id === variables.groupId)?.name ?? "";
      notify.toast.success({
        id: "volunteer-pool-pulled",
        title: String(t("volunteering.pulledIntoGroup", { name: groupName })),
      });
      onPulled();
    },
    onError: (err) => {
      const conflictKey = volunteerConflictMessageKey(err);
      notify.toast.danger({
        id: "volunteer-pool-pull-failed",
        title: String(t("volunteering.groupAssignFailed")),
        message: conflictKey
          ? String(t(conflictKey))
          : formatErrorMessage(err, t),
      });
    },
  });

  const created = new Date(signup.createdAt);
  const singleGroup = groups.length === 1 ? groups[0] : null;

  return (
    <XStack
      gap="$3"
      alignItems="center"
      justifyContent="space-between"
      flexWrap="wrap"
      borderWidth={1}
      borderColor="$borderColor"
      padding="$3"
      data-testid={`coordinator-pool-row-${signup.id}`}
    >
      <YStack gap="$1" flex={1} minWidth={200}>
        <Text variant="body" style={{ fontWeight: 600 }}>
          {signup.contactName ?? signup.contactEmail}
        </Text>
        <Text variant="caption" tone="muted">
          {signup.contactName ? `${signup.contactEmail} · ` : ""}
          {Number.isNaN(created.getTime()) ? "" : fmt.dateTime(created)}
        </Text>
      </YStack>

      {singleGroup ? (
        <Button
          variant="primary"
          size="$2"
          minHeight={44}
          disabled={assignMutation.isPending}
          onPress={() =>
            assignMutation.mutate({
              signupId: signup.id,
              groupId: singleGroup.id,
            })
          }
          data-testid={`coordinator-pool-pull-${signup.id}`}
        >
          <XStack gap="$2" alignItems="center">
            <UserPlus size={14} />
            <Text tone="inherit" variant="bodySmall">
              {String(
                t("volunteering.pullIntoGroup", { name: singleGroup.name }),
              )}
            </Text>
          </XStack>
        </Button>
      ) : (
        <StyledSelect
          value={PULL_PLACEHOLDER_VALUE}
          placeholder={String(t("volunteering.pullIntoGroupSelect"))}
          options={groups.map((group) => ({
            value: group.id,
            label: group.name,
          }))}
          disabled={assignMutation.isPending}
          aria-label={String(t("volunteering.pullIntoGroupSelect"))}
          testId={`coordinator-pool-pull-${signup.id}`}
          onChange={(groupId) => {
            if (!groupId) return;
            assignMutation.mutate({ signupId: signup.id, groupId });
          }}
        />
      )}
    </XStack>
  );
}

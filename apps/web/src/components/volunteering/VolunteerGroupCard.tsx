"use client";

import { XStack, YStack, styled } from "tamagui";
import { Badge, Button, Text, useTranslations } from "@th/ui";
import { ChevronDown, ChevronUp, Megaphone } from "lucide-react";

import { CoordinatorPicker, type CoordinatorInfo } from "./CoordinatorPicker";
import { SignupReviewRow, type SignupRowData } from "./SignupReviewRow";
import type { GroupOption } from "./GroupAssignmentMenu";

const GroupFrame = styled(YStack, {
  name: "VolunteerGroupCard",
  borderWidth: 1,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  padding: "$4",
  gap: "$3",
});

export type VolunteerGroupData = {
  id: string;
  name: string;
  description: string | null;
  capacity: number | null;
  memberCount: number;
  coordinator: CoordinatorInfo | null;
};

export type VolunteerGroupCardProps = {
  group: VolunteerGroupData;
  /**
   * Member rows, when the caller has them: the coordinator console passes
   * them eagerly; the owner manage page fetches lazily behind `members`.
   */
  signups?: SignupRowData[];
  /**
   * Owner-side lazy member list: renders a show/hide toggle and defers the
   * fetch to the caller (`volunteer.signups.listByAsk` GROUP scope). When
   * omitted, `signups` (if provided) render unconditionally.
   */
  members?: {
    expanded: boolean;
    loading: boolean;
    error?: boolean;
    onToggle: () => void;
    onRetry?: () => void;
  };
  /** Groups member rows may be moved into (incl. this one). */
  assignableGroups: GroupOption[];
  /** Owner-only coordinator management. */
  canManageCoordinator?: boolean;
  /** Opens the broadcast composer pre-scoped to this group. */
  onBroadcast?: () => void;
  onChanged: () => void;
};

/**
 * A volunteer group: name, coordinator, fill count, and (when provided)
 * the member list. Shared between the owner ask-manage page and the
 * coordinator console.
 */
export function VolunteerGroupCard({
  group,
  signups,
  members,
  assignableGroups,
  canManageCoordinator = false,
  onBroadcast,
  onChanged,
}: VolunteerGroupCardProps) {
  const t = useTranslations();

  const fillLabel =
    group.capacity !== null
      ? String(
          t("volunteering.groupFill", {
            count: group.memberCount,
            cap: group.capacity,
          }),
        )
      : String(t("volunteering.groupFillOpen", { count: group.memberCount }));

  const full = group.capacity !== null && group.memberCount >= group.capacity;

  return (
    <GroupFrame data-testid={`volunteer-group-${group.id}`}>
      <XStack
        gap="$3"
        alignItems="flex-start"
        justifyContent="space-between"
        flexWrap="wrap"
      >
        {/* Basis + shrink, not a minWidth floor: at 320px the floor and a
            non-shrinking action group ran past the card. */}
        <YStack
          gap="$1"
          flexGrow={1}
          flexShrink={1}
          flexBasis={200}
          minWidth={0}
        >
          <Text variant="h4" style={{ textTransform: "uppercase" }}>
            {group.name}
          </Text>
          {group.description ? (
            <Text variant="bodySmall" tone="muted">
              {group.description}
            </Text>
          ) : null}
        </YStack>
        <XStack
          gap="$2"
          alignItems="center"
          flexWrap="wrap"
          flexShrink={1}
          minWidth={0}
        >
          <Badge tone={full ? "warning" : "neutral"} size="sm">
            {fillLabel}
          </Badge>
          {onBroadcast ? (
            <Button
              variant="outlined"
              size="$2"
              minHeight={44}
              onPress={onBroadcast}
              data-testid={`volunteer-group-broadcast-${group.id}`}
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
      </XStack>

      {canManageCoordinator ? (
        <CoordinatorPicker
          groupId={group.id}
          coordinator={group.coordinator}
          onChanged={onChanged}
        />
      ) : group.coordinator ? (
        <Text variant="caption" tone="muted">
          {String(t("volunteering.coordinatorLabel"))}:{" "}
          {group.coordinator.name ??
            String(t("volunteering.coordinatorUnnamed"))}
        </Text>
      ) : null}

      {members ? (
        <YStack gap="$2">
          <XStack>
            <Button
              variant="ghost"
              size="$2"
              minHeight={44}
              onPress={members.onToggle}
              aria-expanded={members.expanded}
              data-testid={`volunteer-group-members-toggle-${group.id}`}
            >
              <XStack gap="$2" alignItems="center">
                {members.expanded ? (
                  <ChevronUp size={14} />
                ) : (
                  <ChevronDown size={14} />
                )}
                <Text variant="bodySmall">
                  {String(
                    t(
                      members.expanded
                        ? "volunteering.hideMembers"
                        : "volunteering.showMembers",
                    ),
                  )}
                </Text>
              </XStack>
            </Button>
          </XStack>
          {members.expanded ? (
            members.loading ? (
              <Text variant="bodySmall" tone="muted" role="status">
                {String(t("common.loading"))}
              </Text>
            ) : members.error ? (
              <XStack gap="$2" alignItems="center" flexWrap="wrap">
                <Text variant="bodySmall" tone="muted">
                  {String(t("volunteering.membersLoadFailed"))}
                </Text>
                {members.onRetry ? (
                  <Button
                    variant="outlined"
                    size="$2"
                    minHeight={44}
                    onPress={members.onRetry}
                  >
                    {String(t("volunteering.retryCta"))}
                  </Button>
                ) : null}
              </XStack>
            ) : (
              <MemberList
                signups={signups ?? []}
                assignableGroups={assignableGroups}
                onChanged={onChanged}
                emptyLabel={String(t("volunteering.groupEmpty"))}
              />
            )
          ) : null}
        </YStack>
      ) : signups ? (
        <MemberList
          signups={signups}
          assignableGroups={assignableGroups}
          onChanged={onChanged}
          emptyLabel={String(t("volunteering.groupEmpty"))}
        />
      ) : null}
    </GroupFrame>
  );
}

function MemberList({
  signups,
  assignableGroups,
  onChanged,
  emptyLabel,
}: {
  signups: SignupRowData[];
  assignableGroups: GroupOption[];
  onChanged: () => void;
  emptyLabel: string;
}) {
  if (signups.length === 0) {
    return (
      <Text variant="bodySmall" tone="muted">
        {emptyLabel}
      </Text>
    );
  }
  return (
    <YStack gap="$2">
      {signups.map((signup) => (
        <SignupReviewRow
          key={signup.id}
          signup={signup}
          assignableGroups={assignableGroups}
          onChanged={onChanged}
        />
      ))}
    </YStack>
  );
}

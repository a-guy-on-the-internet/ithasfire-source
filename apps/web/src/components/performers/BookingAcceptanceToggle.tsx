"use client";

import { useCallback } from "react";
import { XStack, YStack } from "tamagui";
import { Text, Switch, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import type { PerformerModeOwner } from "@/components/performers/PerformerModeToggle";

export interface BookingAcceptanceToggleProps {
  owner: PerformerModeOwner;
  /** Label rendered next to the switch. */
  label: string;
  /** Help copy when the acceptance gate is ON (what it unlocks). */
  onHelp: string;
  /** Help copy when the acceptance gate is OFF. */
  offHelp: string;
  testId?: string;
}

/**
 * "Open to booking requests" opt-in (organizer-booking-requests FR-002),
 * driven by `performers.getMyStatus` / `performers.setBookingAcceptance`.
 * Rendered directly under {@link PerformerModeToggle} — callers only mount it
 * while performer mode is enabled, since enabling acceptance requires it
 * server-side (disabling is always allowed). Authorization (self for humans,
 * org admins for orgs) is enforced by the use case; failures surface as a
 * toast after the optimistic flip rolls back.
 */
export function BookingAcceptanceToggle({
  owner,
  label,
  onHelp,
  offHelp,
  testId,
}: BookingAcceptanceToggleProps) {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const statusQuery = trpc.performers.getMyStatus.useQuery(undefined, {
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
  });

  const entry =
    owner.type === "human"
      ? statusQuery.data?.human
      : statusQuery.data?.orgs.find((o) => o.ownerId === owner.orgId);

  const setAcceptanceMutation = trpc.performers.setBookingAcceptance.useMutation(
    {
      retry: false,
      meta: { silent: true },
      onMutate: (variables) => {
        // Optimistic flip in the shared getMyStatus cache; rolled back on error.
        const previous = utils.performers.getMyStatus.getData();
        if (previous) {
          utils.performers.getMyStatus.setData(undefined, {
            ...previous,
            human:
              variables.ownerType === "human"
                ? {
                    ...previous.human,
                    acceptsBookingRequests: variables.accepts,
                  }
                : previous.human,
            orgs: previous.orgs.map((o) =>
              variables.ownerType === "org" && o.ownerId === variables.ownerId
                ? { ...o, acceptsBookingRequests: variables.accepts }
                : o,
            ),
          });
        }
        return { previous };
      },
      onError: (err, _vars, context) => {
        if (context?.previous) {
          utils.performers.getMyStatus.setData(undefined, context.previous);
        }
        toast.danger({
          id: "booking-acceptance-failed",
          title: String(t("admin.bkAcceptUpdateFailed")),
          message: formatErrorMessage(err, t),
        });
      },
      onSettled: () => {
        void utils.performers.getMyStatus.invalidate();
      },
    },
  );

  const handleChange = useCallback(
    (next: boolean) => {
      const ownerId =
        owner.type === "human" ? statusQuery.data?.human.ownerId : owner.orgId;
      if (!ownerId) return;
      setAcceptanceMutation.mutate({
        ownerType: owner.type === "human" ? "human" : "org",
        ownerId,
        accepts: next,
      });
    },
    [owner, setAcceptanceMutation, statusQuery.data?.human.ownerId],
  );

  const accepts = entry?.acceptsBookingRequests ?? false;

  return (
    <YStack
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      padding="$4"
      gap="$2"
    >
      <XStack justifyContent="space-between" alignItems="center" gap="$3">
        <Text variant="body" weight="bold">
          {label}
        </Text>
        <Switch
          checked={accepts}
          onCheckedChange={handleChange}
          disabled={statusQuery.isLoading || !entry}
          saving={setAcceptanceMutation.isPending}
          aria-label={label}
          testId={testId}
        />
      </XStack>
      <Text variant="caption" color="$colorMuted">
        {statusQuery.isError
          ? String(t("admin.performerModeStatusUnavailable"))
          : accepts
            ? onHelp
            : offHelp}
      </Text>
    </YStack>
  );
}

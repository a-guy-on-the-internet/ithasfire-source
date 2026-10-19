"use client";

import { useCallback } from "react";
import { XStack, YStack } from "tamagui";
import { Text, Switch, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

export type PerformerModeOwner =
  | { type: "human" }
  | { type: "org"; orgId: string };

export interface PerformerModeToggleProps {
  owner: PerformerModeOwner;
  /** Label rendered next to the switch. */
  label: string;
  /** Help copy when performer mode is ON; receives the enabled-since date. */
  onHelp: (enabledAt: Date | null) => string;
  /** Help copy when performer mode is OFF (mentions data retention). */
  offHelp: string;
  testId?: string;
}

/**
 * Performer-mode switch driven by `performers.getMyStatus` /
 * `performers.setMode`. Used by both the account settings (human owner) and
 * org settings (org owner). The backend enforces authorization (self for
 * humans, org admins for orgs); failures surface as a toast.
 */
export function PerformerModeToggle({
  owner,
  label,
  onHelp,
  offHelp,
  testId,
}: PerformerModeToggleProps) {
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

  const setModeMutation = trpc.performers.setMode.useMutation({
    retry: false,
    meta: { silent: true },
    onMutate: (variables) => {
      // Optimistic flip; rolled back on error.
      const previous = utils.performers.getMyStatus.getData();
      if (previous) {
        utils.performers.getMyStatus.setData(undefined, {
          ...previous,
          human:
            variables.ownerType === "human"
              ? { ...previous.human, enabled: variables.enabled }
              : previous.human,
          orgs: previous.orgs.map((o) =>
            variables.ownerType === "org" && o.ownerId === variables.ownerId
              ? { ...o, enabled: variables.enabled }
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
      const code = (err as { data?: { code?: string } | null })?.data?.code;
      toast.danger({
        id: "performer-mode-failed",
        title: String(t("admin.performerModeUpdateFailed")),
        message:
          code === "FORBIDDEN"
            ? String(t("admin.performerModeForbidden"))
            : formatErrorMessage(err, t),
      });
    },
    onSettled: () => {
      void utils.performers.getMyStatus.invalidate();
    },
  });

  const handleChange = useCallback(
    (next: boolean) => {
      const ownerId =
        owner.type === "human"
          ? statusQuery.data?.human.ownerId
          : owner.orgId;
      if (!ownerId) return;
      setModeMutation.mutate({
        ownerType: owner.type === "human" ? "human" : "org",
        ownerId,
        enabled: next,
      });
    },
    [owner, setModeMutation, statusQuery.data?.human.ownerId],
  );

  const enabled = entry?.enabled ?? false;
  const enabledAt = entry?.enabledAt ? new Date(entry.enabledAt) : null;

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
          checked={enabled}
          onCheckedChange={handleChange}
          disabled={statusQuery.isLoading || !entry}
          saving={setModeMutation.isPending}
          aria-label={label}
          testId={testId}
        />
      </XStack>
      <Text variant="caption" color="$colorMuted">
        {statusQuery.isError
          ? String(t("admin.performerModeStatusUnavailable"))
          : enabled
            ? onHelp(enabledAt)
            : offHelp}
      </Text>
    </YStack>
  );
}

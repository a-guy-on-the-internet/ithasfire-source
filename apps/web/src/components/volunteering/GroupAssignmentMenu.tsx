"use client";

import { useMemo } from "react";
import { StyledSelect, useNotify, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";

import { volunteerConflictMessageKey } from "./volunteering-helpers";

/** Sentinel select value for "no group" (the ask's general pool). */
const POOL_VALUE = "__pool__";

export type GroupOption = { id: string; name: string };

export type GroupAssignmentMenuProps = {
  signupId: string;
  /** The signup's current group; null = general pool. */
  currentGroupId: string | null;
  /**
   * Groups the actor may move this signup into. Owners pass every group;
   * a coordinator passes only their own group(s) — the server enforces the
   * same scope (pool ↔ own group only), this just keeps the menu honest.
   */
  groups: GroupOption[];
  onChanged: () => void;
};

/**
 * Move a signup into / between / out of a group (FR-005). Backed by
 * `volunteer.signups.assignToGroup`; `null` releases to the general pool.
 */
export function GroupAssignmentMenu({
  signupId,
  currentGroupId,
  groups,
  onChanged,
}: GroupAssignmentMenuProps) {
  const t = useTranslations();
  const notify = useNotify();

  const assignMutation = trpc.volunteer.signups.assignToGroup.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      onChanged();
    },
    onError: (err) => {
      const conflictKey = volunteerConflictMessageKey(err);
      notify.toast.danger({
        id: "volunteer-group-assign-failed",
        title: String(t("volunteering.groupAssignFailed")),
        message: conflictKey
          ? String(t(conflictKey))
          : formatErrorMessage(err, t),
      });
    },
  });

  const options = useMemo(() => {
    const base = [
      { value: POOL_VALUE, label: String(t("volunteering.generalPool")) },
      ...groups.map((g) => ({ value: g.id, label: g.name })),
    ];
    // The current group may not be movable-into by this actor (e.g. a
    // coordinator viewing a pool row) — but the select must still be able
    // to DISPLAY the current value.
    if (currentGroupId && !groups.some((g) => g.id === currentGroupId)) {
      base.push({
        value: currentGroupId,
        label: String(t("volunteering.otherGroup")),
      });
    }
    return base;
  }, [groups, currentGroupId, t]);

  return (
    <StyledSelect
      value={currentGroupId ?? POOL_VALUE}
      options={options}
      disabled={assignMutation.isPending}
      aria-label={String(t("volunteering.groupAssignLabel"))}
      testId={`volunteer-group-assign-${signupId}`}
      onChange={(value) => {
        const groupId = value === POOL_VALUE ? null : value;
        if (groupId === currentGroupId) return;
        assignMutation.mutate({ signupId, groupId });
      }}
    />
  );
}

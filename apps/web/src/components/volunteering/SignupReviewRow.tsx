"use client";

import { useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  Text,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";
import { Check, UserCheck, X } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";

import { GroupAssignmentMenu, type GroupOption } from "./GroupAssignmentMenu";
import { RewardStatusBadge } from "./RewardStatusBadge";
import {
  SIGNUP_STATUS_LABEL_KEY,
  SIGNUP_STATUS_TONE,
  volunteerConflictMessageKey,
  type RewardBadgeStatus,
  type SignupStatus,
} from "./volunteering-helpers";

export type SignupRowData = {
  id: string;
  contactName: string | null;
  contactEmail: string;
  status: SignupStatus;
  groupId: string | null;
  roleId: string;
  createdAt: Date | string;
  /**
   * Read-only comp-reward status (volunteer-comp-tickets spec). Optional —
   * absent / null renders no reward badge. Coordinators SEE this but never
   * configure rewards (config is a separate finance-gated surface).
   */
  rewardStatus?: RewardBadgeStatus | null;
};

export type SignupReviewRowProps = {
  signup: SignupRowData;
  /** Role name lookup for the compact "role" caption (optional). */
  roleName?: string | null;
  /** Groups the actor may assign this signup into (see GroupAssignmentMenu). */
  assignableGroups: GroupOption[];
  /** Hide the group menu entirely (e.g. ask has no groups yet). */
  showGroupMenu?: boolean;
  onChanged: () => void;
};

/**
 * One roster row shared by the owner ask-manage page and the coordinator
 * console: identity, status badge, approve/reject (PENDING), check-in
 * (APPROVED), and the group-assignment menu. All authority checks live in
 * the core use cases — this row only offers actions that make sense for
 * the signup's current status.
 */
export function SignupReviewRow({
  signup,
  roleName,
  assignableGroups,
  showGroupMenu = true,
  onChanged,
}: SignupReviewRowProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const notify = useNotify();
  const [confirmReject, setConfirmReject] = useState(false);

  const onError = (err: unknown) => {
    const conflictKey = volunteerConflictMessageKey(err);
    notify.toast.danger({
      id: "volunteer-signup-action-failed",
      title: String(t("volunteering.signupActionFailed")),
      message: conflictKey
        ? String(t(conflictKey))
        : formatErrorMessage(err, t),
    });
  };

  const reviewMutation = trpc.volunteer.signups.review.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      setConfirmReject(false);
      onChanged();
    },
    onError,
  });

  const checkInMutation = trpc.volunteer.signups.checkIn.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-signup-checked-in",
        title: String(t("volunteering.signupCheckedIn")),
      });
      onChanged();
    },
    onError,
  });

  const pending = reviewMutation.isPending || checkInMutation.isPending;
  const created = new Date(signup.createdAt);

  return (
    <XStack
      gap="$3"
      alignItems="center"
      justifyContent="space-between"
      flexWrap="wrap"
      borderWidth={1}
      borderColor="$borderColor"
      padding="$3"
      data-testid={`volunteer-signup-row-${signup.id}`}
    >
      <YStack gap="$1" flex={1} minWidth={200}>
        <Text variant="body" style={{ fontWeight: 600 }}>
          {signup.contactName ?? signup.contactEmail}
        </Text>
        <Text variant="caption" tone="muted">
          {signup.contactName ? `${signup.contactEmail} · ` : ""}
          {roleName ? `${roleName} · ` : ""}
          {Number.isNaN(created.getTime()) ? "" : fmt.dateTime(created)}
        </Text>
      </YStack>

      <XStack
        gap="$2"
        alignItems="center"
        flexWrap="wrap"
        justifyContent="flex-end"
        flexShrink={1}
        minWidth={0}
      >
        <Badge tone={SIGNUP_STATUS_TONE[signup.status]} size="sm">
          {String(t(SIGNUP_STATUS_LABEL_KEY[signup.status]))}
        </Badge>

        <RewardStatusBadge
          status={signup.rewardStatus}
          testIdSuffix={signup.id}
        />

        {signup.status === "PENDING" ? (
          <>
            <Button
              variant="primary"
              size="$2"
              minHeight={44}
              disabled={pending}
              onPress={() =>
                reviewMutation.mutate({
                  signupId: signup.id,
                  decision: "APPROVED",
                })
              }
              data-testid={`volunteer-signup-approve-${signup.id}`}
            >
              <XStack gap="$2" alignItems="center">
                <Check size={14} />
                <Text tone="inherit" variant="bodySmall">
                  {String(t("volunteering.approveCta"))}
                </Text>
              </XStack>
            </Button>
            <Button
              variant="ghost"
              size="$2"
              minHeight={44}
              disabled={pending}
              onPress={() => setConfirmReject(true)}
              data-testid={`volunteer-signup-reject-${signup.id}`}
            >
              <XStack gap="$2" alignItems="center">
                <X size={14} />
                <Text variant="bodySmall">
                  {String(t("volunteering.rejectCta"))}
                </Text>
              </XStack>
            </Button>
          </>
        ) : null}

        {signup.status === "APPROVED" ? (
          <Button
            variant="outlined"
            size="$2"
            minHeight={44}
            disabled={pending}
            onPress={() => checkInMutation.mutate({ signupId: signup.id })}
            data-testid={`volunteer-signup-checkin-${signup.id}`}
          >
            <XStack gap="$2" alignItems="center">
              <UserCheck size={14} />
              <Text tone="inherit" variant="bodySmall">
                {String(t("volunteering.checkInCta"))}
              </Text>
            </XStack>
          </Button>
        ) : null}

        {showGroupMenu &&
        (signup.status === "APPROVED" || signup.status === "CHECKED_IN") ? (
          <GroupAssignmentMenu
            signupId={signup.id}
            currentGroupId={signup.groupId}
            groups={assignableGroups}
            onChanged={onChanged}
          />
        ) : null}
      </XStack>

      <ConfirmDialog
        open={confirmReject}
        tone="danger"
        title={String(t("volunteering.rejectConfirmTitle"))}
        description={String(
          t("volunteering.rejectConfirmBody", {
            name: signup.contactName ?? signup.contactEmail,
          }),
        )}
        confirmLabel={String(t("volunteering.rejectCta"))}
        cancelLabel={String(t("common.cancel"))}
        loading={reviewMutation.isPending}
        onConfirm={() =>
          reviewMutation.mutate({ signupId: signup.id, decision: "REJECTED" })
        }
        onCancel={() => setConfirmReject(false)}
      />
    </XStack>
  );
}

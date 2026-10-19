"use client";

import { useId, useMemo } from "react";
import { XStack, YStack } from "tamagui";
import { Button, Spinner, StyledSelect, Text, useTranslations } from "@th/ui";
import { UserCheck } from "lucide-react";

import { useEventOwnerEntities } from "@/hooks/useEventOwnerEntities";
import { useOrgMembers } from "./useOrgMembers";

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGNEE PICKER (booking-holds spec 2026-08-25, FR-015).
//
// A native <select> of the org's EDIT-ROLE members (owner / admin / editor —
// the roles that can act on a request) plus "Assign to me". A select, not a
// popover menu: it is a labelled option set, keyboard-native, announces its
// value, and fits a 320px card without a floating layer to manage.
//
// The picker is DUMB about persistence — `onChange` hands the caller the
// chosen id (or null for Unassigned) and the caller writes
// `bookingRequests.assign`. `isPending` disables the control while the write
// is in flight so a double-click cannot fire two assigns.
//
// A current assignee who is NO LONGER on the roster (left the org, lost the
// edit role) is still shown, as a disabled "former member" option, so the
// select does not silently display the wrong value — and clearing or
// re-assigning is the way out.
// ─────────────────────────────────────────────────────────────────────────────

const UNASSIGNED = "__unassigned__";

export function AssigneePicker({
  orgId,
  value,
  onChange,
  isPending = false,
  disabled = false,
  testIdBase = "booking-assignee",
}: {
  orgId: string;
  /** Current `assigneeHumanId`. */
  value: string | null;
  onChange: (assigneeHumanId: string | null) => void;
  isPending?: boolean;
  disabled?: boolean;
  testIdBase?: string;
}) {
  const t = useTranslations();
  const selectId = useId();
  const { editors, labelOf, isLoading, isError } = useOrgMembers(orgId);
  const owners = useEventOwnerEntities();
  const myHumanId = useMemo(
    () =>
      owners.ownersWithSlugs?.find((o) => o.kind === "human")?.humanId ?? null,
    [owners.ownersWithSlugs],
  );

  const options = useMemo(() => {
    const rows = editors.map((m) => ({
      value: m.humanId,
      label: m.name ?? m.email ?? String(t("admin.bkAssigneeUnnamed")),
    }));
    const known = new Set(rows.map((r) => r.value));
    if (value && !known.has(value)) {
      rows.push({
        value,
        label: labelOf(value) ?? String(t("admin.bkAssigneeFormerMember")),
      });
    }
    return [{ value: UNASSIGNED, label: String(t("admin.bkAssigneeUnassigned")) }, ...rows];
  }, [editors, labelOf, t, value]);

  const isMe = value !== null && value === myHumanId;
  const canAssignMe =
    myHumanId !== null && editors.some((m) => m.humanId === myHumanId) && !isMe;
  const locked = disabled || isPending;

  return (
    <YStack gap="$1" minWidth={0} data-testid={testIdBase}>
      <label htmlFor={selectId}>
        <Text
          variant="caption"
          weight="bold"
          tone="muted"
          textTransform="uppercase"
          letterSpacing={0.6}
        >
          {String(t("admin.bkAssigneeLabel"))}
        </Text>
      </label>
      <XStack gap="$2" alignItems="center" flexWrap="wrap" minWidth={0}>
        <XStack flexBasis={200} flexGrow={1} flexShrink={1} minWidth={0} maxWidth="100%">
          <StyledSelect
            selectId={selectId}
            value={value ?? UNASSIGNED}
            options={options}
            onChange={(next) => onChange(next === UNASSIGNED ? null : next)}
            disabled={locked || isLoading || isError}
            size="sm"
            fullWidth
            testId={`${testIdBase}-select`}
          />
        </XStack>
        {isPending ? (
          <Spinner size="sm" />
        ) : canAssignMe ? (
          <Button
            variant="ghost"
            size="$2"
            disabled={locked}
            onPress={() => onChange(myHumanId)}
            testID={`${testIdBase}-me`}
          >
            <UserCheck size={13} strokeWidth={2} aria-hidden />
            {String(t("admin.bkAssigneeAssignMe"))}
          </Button>
        ) : null}
      </XStack>
      {isError ? (
        <Text variant="caption" tone="error" role="alert">
          {String(t("admin.bkAssigneeRosterError"))}
        </Text>
      ) : null}
    </YStack>
  );
}

"use client";

import type { ReactNode } from "react";
import { XStack, YStack } from "tamagui";
import { Text } from "@th/ui";

import { truncateId } from "@/lib/format";
import { RoleBadgeList } from "./RoleBadgeList";
import type { HumanRoleValue } from "./roles-constants";

export interface RolesMobileCardRow {
  id: string;
  name: string | null;
  roles: string[];
  identity: { email: string } | null;
}

const ELLIPSIS_STYLE = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

/**
 * Card rendering for /platform/roles rows on phones (<600px, DataTable's
 * card-mode breakpoint). Mirrors HumanMobileCard's composition: name, then
 * email, then the role badges (+ revoke), then the grant control passed in
 * as `grantControl` (rendered in a plain "actions" column on desktop, which
 * card mode does not show).
 */
export function RolesMobileCard({
  row,
  isPlatformAdmin,
  onRevoke,
  revokeDisabled,
  grantControl,
  isOwnRow,
}: {
  row: RolesMobileCardRow;
  isPlatformAdmin: boolean;
  onRevoke: (role: HumanRoleValue) => void;
  revokeDisabled?: boolean;
  grantControl?: ReactNode;
  /** See `RoleBadgeList`'s `isOwnRow` — gates the self-ADMIN-revoke confirm. */
  isOwnRow?: boolean;
}) {
  return (
    <YStack gap="$2" minWidth={0}>
      <XStack gap="$2" alignItems="center" minWidth={0}>
        <Text
          variant="bodySmall"
          weight="bold"
          tone={row.name ? "default" : "muted"}
          flex={1}
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.name || "—"}
        </Text>
      </XStack>

      {row.identity?.email ? (
        <Text
          variant="caption"
          tone="muted"
          minWidth={0}
          style={ELLIPSIS_STYLE}
        >
          {row.identity.email}
        </Text>
      ) : null}

      <RoleBadgeList
        roles={row.roles}
        isPlatformAdmin={isPlatformAdmin}
        onRevoke={onRevoke}
        disabled={revokeDisabled}
        isOwnRow={isOwnRow}
      />

      {isPlatformAdmin && grantControl}

      <Text variant="code" fontSize={11} tone="muted">
        {truncateId(row.id)}
      </Text>
    </YStack>
  );
}

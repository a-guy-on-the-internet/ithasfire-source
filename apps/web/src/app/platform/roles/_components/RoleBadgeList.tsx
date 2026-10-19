"use client";

import { useState } from "react";
import { XStack } from "tamagui";
import { Badge, Button } from "@th/ui";
import { X } from "lucide-react";

import { ConfirmDialog } from "@/components/data-table/ConfirmDialog";
import type { HumanRoleValue } from "./roles-constants";

export interface RoleBadgeListProps {
  roles: string[];
  /**
   * Whether the current staff actor is a platform ADMIN. `revokeRole` is
   * ADMIN-only server-side, so non-admin staff see plain badges with no
   * revoke affordance — mirrors HumanActions' `isPlatformAdmin` gate.
   */
  isPlatformAdmin: boolean;
  /** Called when the revoke "x" is pressed for a given role. */
  onRevoke: (role: HumanRoleValue) => void;
  /** Disables all revoke buttons while a mutation is in flight. */
  disabled?: boolean;
  /**
   * Whether this row belongs to the acting admin themselves. Revoking one's
   * own ADMIN role is the highest-leverage self-lockout risk on this page
   * (potentially the last ADMIN — the server-side `adminRevokeHumanRole`
   * guard is authoritative there), so that specific combination gets a
   * confirmation step; every other revoke keeps the immediate-fire behavior.
   */
  isOwnRow?: boolean;
}

/**
 * Renders a human's held platform roles as a wrapping row of badges. When
 * `isPlatformAdmin`, each badge gets a small "x" button that fires `onRevoke`
 * for that role — no confirmation dialog for most cases, mirroring the
 * immediate-fire pattern org team management uses for role reassignment
 * (revoking a role here is low-stakes and reversible: re-grant it from
 * `GrantRoleSelect`). The one exception is revoking ADMIN from `isOwnRow`,
 * which routes through a `ConfirmDialog` first — defense-in-depth against an
 * accidental self-lockout (the server rejects it outright if this would drop
 * the last platform ADMIN, but a confirm is cheap and catches the mistake
 * before the round-trip).
 */
export function RoleBadgeList({
  roles,
  isPlatformAdmin,
  onRevoke,
  disabled,
  isOwnRow,
}: RoleBadgeListProps) {
  const [pendingSelfAdminRevoke, setPendingSelfAdminRevoke] = useState(false);

  if (roles.length === 0) {
    return (
      <Badge tone="neutral" size="sm">
        {"—"}
      </Badge>
    );
  }

  const requestRevoke = (role: string) => {
    if (isOwnRow && role === "ADMIN") {
      setPendingSelfAdminRevoke(true);
      return;
    }
    onRevoke(role as HumanRoleValue);
  };

  return (
    <>
      <XStack gap="$1" flexWrap="wrap" alignItems="center">
        {roles.map((role) => (
          <XStack key={role} gap={2} alignItems="center">
            <Badge tone={role === "ADMIN" ? "info" : "neutral"} size="sm">
              {role}
            </Badge>
            {isPlatformAdmin && (
              <Button
                variant="ghost"
                size="$1"
                disabled={disabled}
                onPress={() => requestRevoke(role)}
                aria-label={`Revoke ${role}`}
                paddingHorizontal={2}
                minWidth={20}
                minHeight={20}
              >
                <X size={11} />
              </Button>
            )}
          </XStack>
        ))}
      </XStack>

      <ConfirmDialog
        open={pendingSelfAdminRevoke}
        onConfirm={() => {
          setPendingSelfAdminRevoke(false);
          onRevoke("ADMIN");
        }}
        onCancel={() => setPendingSelfAdminRevoke(false)}
        title="Revoke your own ADMIN role?"
        description="You're about to remove your own ADMIN role. If you're the only remaining ADMIN, the server will reject this — but if you hold ADMIN alongside other admins, this takes effect immediately and you'll lose platform-admin access."
        confirmLabel="Revoke ADMIN"
        tone="danger"
      />
    </>
  );
}

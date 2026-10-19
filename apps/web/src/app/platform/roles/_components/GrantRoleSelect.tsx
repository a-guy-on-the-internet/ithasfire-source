"use client";

import { useMemo } from "react";
import { StyledSelect, type StyledSelectOption } from "@th/ui";

import { ALL_HUMAN_ROLES, type HumanRoleValue } from "./roles-constants";

export interface GrantRoleSelectProps {
  /** Roles the target human already holds — excluded from the option list. */
  heldRoles: string[];
  /**
   * Fires immediately on selection (no separate "confirm" step) — mirrors
   * the org team management role-select, which fires its mutation directly
   * on `onChange`.
   */
  onGrant: (role: HumanRoleValue) => void;
  disabled?: boolean;
}

const PLACEHOLDER = "+ add role" as const;

/**
 * Dropdown of grantable roles (every {@link HumanRoleValue} the target human
 * doesn't already hold). Selecting an option calls `onGrant` immediately;
 * the parent resets the control back to the placeholder once the mutation
 * settles (grant is idempotent server-side, so a stray double-select is a
 * harmless no-op).
 */
export function GrantRoleSelect({
  heldRoles,
  onGrant,
  disabled,
}: GrantRoleSelectProps) {
  const options: StyledSelectOption<string>[] = useMemo(() => {
    const grantable = ALL_HUMAN_ROLES.filter(
      (role) => !heldRoles.includes(role),
    );
    return grantable.map((role) => ({ value: role, label: role }));
  }, [heldRoles]);

  if (options.length === 0) {
    return null;
  }

  return (
    <StyledSelect<string>
      value={PLACEHOLDER}
      options={[{ value: PLACEHOLDER, label: PLACEHOLDER }, ...options]}
      onChange={(next) => {
        if (next === PLACEHOLDER) return;
        onGrant(next as HumanRoleValue);
      }}
      size="sm"
      disabled={disabled}
      testId="grant-role-select"
    />
  );
}

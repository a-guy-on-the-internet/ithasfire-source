"use client";

import { useMemo } from "react";
import { ORG_EDIT_ROLES, ORG_ADMIN_ROLES, ORG_FINANCE_ROLES } from "@th/types";

import type { OwnerEntityWithSlug } from "./useEventOwnerEntities";

/**
 * Derives cosmetic write-capability flags for an admin owner entity.
 *
 * These are UX-only affordance gates that mirror the server-side use-case
 * checks (`ORG_EDIT_ROLES` / `ORG_ADMIN_ROLES` in `packages/core/src/lib/rbac.ts`).
 * The server remains the real authorization boundary — hiding a button never
 * grants access, and a rejected mutation still 403s.
 *
 * Profile-owner humans (`kind === "human"`) always manage their own content, so
 * they get both capabilities. For orgs, the actor's role is checked against the
 * canonical role sets from `@th/types`.
 *
 * @param currentOwner The resolved owner entity (from `useCurrentAdminOwner`).
 *   Pass the already-fetched entity — this hook does not fetch.
 */
export function useAdminOwnerCapabilities(
  currentOwner: OwnerEntityWithSlug | null | undefined,
): { canEdit: boolean; canManage: boolean; canFinance: boolean } {
  // Content-edit capability (create/edit/import/delete content). Mirrors
  // ORG_EDIT_ROLES (OWNER/ADMIN/EDITOR) plus profile-owner humans.
  const canEdit = useMemo(() => {
    if (!currentOwner) return false;
    return (
      currentOwner.kind === "human" ||
      ORG_EDIT_ROLES.includes(currentOwner.role)
    );
  }, [currentOwner]);

  // Management capability (create/update/archive templates, place verification).
  // Narrower than canEdit: mirrors ORG_ADMIN_ROLES (OWNER/ADMIN only) so an
  // EDITOR does not see ADMIN-only affordances the server would 403.
  const canManage = useMemo(() => {
    if (!currentOwner) return false;
    return (
      currentOwner.kind === "human" ||
      ORG_ADMIN_ROLES.includes(currentOwner.role)
    );
  }, [currentOwner]);

  // Money capability (create/edit/revoke promos, initiate Stripe onboarding,
  // request order exports). Mirrors ORG_FINANCE_ROLES (OWNER/ADMIN/FINANCE)
  // plus profile-owner humans. Deliberately excludes EDITOR/VIEWER/SCANNER so
  // they do not see finance affordances the server would 403.
  const canFinance = useMemo(() => {
    if (!currentOwner) return false;
    return (
      currentOwner.kind === "human" ||
      ORG_FINANCE_ROLES.includes(currentOwner.role)
    );
  }, [currentOwner]);

  return { canEdit, canManage, canFinance };
}

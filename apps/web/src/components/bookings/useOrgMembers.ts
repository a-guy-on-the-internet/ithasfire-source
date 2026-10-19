"use client";

import { useCallback, useMemo } from "react";

import { trpc } from "@/trpc";

// ─────────────────────────────────────────────────────────────────────────────
// The org's roster, read ONCE per org and shared by every assignee surface
// (booking-holds FR-015): the inbox "Assigned to" column resolves ids to
// names from it, the Unassigned filter counts against it, and the picker in
// each expanded row lists its edit-role members from it. React Query dedupes
// on the key, so an inbox with forty rows costs one request, and a five-minute
// `staleTime` keeps a scroll through the list from re-reading a roster that
// changes a few times a year.
//
// `limit: 200` is the procedure's ceiling. An org past 200 members is not a
// case this product has; if it ever is, the picker would silently miss the
// tail — `total > items.length` is exposed so a caller can say so.
// ─────────────────────────────────────────────────────────────────────────────

/** Roles that may be assigned a request (mirrors core `ORG_EDIT_ROLES`). */
const EDIT_ROLES: ReadonlySet<string> = new Set(["OWNER", "ADMIN", "EDITOR"]);

export type OrgMember = {
  humanId: string;
  /** Display name; null when the human never set one (falls back to email). */
  name: string | null;
  email: string | null;
  role: string;
};

export function useOrgMembers(orgId: string | null) {
  const query = trpc.orgs.listMembers.useQuery(
    { orgId: orgId ?? "", limit: 200, offset: 0 },
    { enabled: orgId !== null, staleTime: 5 * 60_000, retry: 1 },
  );

  const members = useMemo<OrgMember[]>(
    () =>
      (query.data?.items ?? []).map((m) => ({
        humanId: m.humanId,
        name: m.name,
        email: m.email,
        role: m.role,
      })),
    [query.data?.items],
  );

  const byId = useMemo(() => {
    const map = new Map<string, OrgMember>();
    for (const m of members) map.set(m.humanId, m);
    return map;
  }, [members]);

  /** Members the request may be assigned to. */
  const editors = useMemo(
    () => members.filter((m) => EDIT_ROLES.has(m.role)),
    [members],
  );

  /**
   * A member's display label, or null when the id is not on the roster (a
   * former member, or the roster read failed). Callers render a fallback —
   * never the raw uuid.
   */
  const labelOf = useCallback(
    (humanId: string | null): string | null => {
      if (!humanId) return null;
      const m = byId.get(humanId);
      if (!m) return null;
      return m.name ?? m.email ?? null;
    },
    [byId],
  );

  return {
    members,
    editors,
    labelOf,
    isLoading: query.isLoading,
    isError: query.isError,
    truncated: (query.data?.total ?? 0) > members.length,
  };
}

"use client";

import { trpc } from "@/trpc";

/**
 * Three-valued answer to "is performer mode ON for this org?".
 *
 * `unknown` is NOT a synonym for `off`. `getMyStatus.orgs` carries only the
 * orgs the actor ADMINISTERS (OWNER / ADMIN — see the schema field), so for a
 * FINANCE or VIEWER member of the org the entry is simply ABSENT, which on the
 * wire is indistinguishable from "performer mode off". Any caller that hides
 * CONTENT on this signal must hide on `off` only, never on `unknown`.
 */
export type OrgPerformerModeSignal = "on" | "off" | "unknown";

/**
 * Is performer mode ON for this org?
 *
 * Both the Performer route (which shows the booking-acceptance switch) and the
 * Booking-defaults route (which mounts the editor) need this answer, and they
 * are now separate routes that can each be the first to mount. `getMyStatus` is
 * a single react-query key, so ONE hook owns the options: react-query dedupes
 * identical keys but keeps whichever options mounted first, and divergent
 * `retry` / `staleTime` copies would silently change behaviour depending on
 * which route the user opened first. The org Bookings workspace reads it too,
 * for the same reason — it gates a tab on the answer.
 *
 * `PerformerModeToggle` drives the same query (including its optimistic flip),
 * so the dependent surfaces track the switch without a refetch.
 */
export function useOrgPerformerEnabled(orgId: string | null, enabled: boolean) {
  const statusQuery = trpc.performers.getMyStatus.useQuery(undefined, {
    enabled: Boolean(orgId) && enabled,
    staleTime: 30_000,
    retry: false,
    meta: { silent: true },
  });

  const entry = statusQuery.data?.orgs.find((o) => o.ownerId === orgId);

  /**
   * `off` ONLY on positive knowledge: the read landed AND this org is in the
   * administered set AND its flag is false. An absent org (non-admin reader),
   * an in-flight read and a failed read are all `unknown`.
   */
  const signal: OrgPerformerModeSignal =
    statusQuery.data === undefined || entry === undefined
      ? "unknown"
      : entry.enabled
        ? "on"
        : "off";

  return {
    isEnabled: entry?.enabled === true,
    isLoading: statusQuery.isLoading,
    signal,
    /** The read has landed one way or the other — resolved OR failed. */
    isSettled: statusQuery.data !== undefined || statusQuery.isError,
  };
}

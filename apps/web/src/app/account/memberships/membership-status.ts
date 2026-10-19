// ─────────────────────────────────────────────────────────────────────────────
// /account/memberships — pure helpers shared between the page and the
// presentable status card. `MyMembership` is derived from the router output
// so the shape can never silently drift from `memberships.mine.list`.
// ─────────────────────────────────────────────────────────────────────────────

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@th/trpc";

import {
  MEMBERSHIP_BENEFIT_GRANTING_STATUSES,
  MEMBERSHIP_STATUS_PAST_DUE,
} from "@th/core/use-cases/memberships";

export type MyMembership =
  inferRouterOutputs<AppRouter>["memberships"]["mine"]["list"]["items"][number];

const GRANTING = MEMBERSHIP_BENEFIT_GRANTING_STATUSES as readonly string[];

export function isGrantingStatus(status: string): boolean {
  return GRANTING.includes(status);
}

export function statusKey(status: string): string {
  if (GRANTING.includes(status)) return "accountMemberships.statusActive";
  if (status === MEMBERSHIP_STATUS_PAST_DUE || status === "unpaid")
    return "accountMemberships.statusPastDue";
  if (status === "canceled" || status === "incomplete_expired")
    return "accountMemberships.statusCanceled";
  return "accountMemberships.statusIncomplete";
}

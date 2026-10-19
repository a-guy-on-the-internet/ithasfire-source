import type { DealChangeNoticeDeps } from "@th/core/use-cases/deals";

import type { Ctx } from "./context";

// ─────────────────────────────────────────────────────────────────────────────
// The notice deps every fenced deal write takes (freeze-the-deal FR-006).
//
// A save with `frozenChange: true` on a frozen deal records one DealChange and,
// after commit, tells every payee on either side of it by email AND in-app
// (F7). Deps assembly only, no business logic:
//   - `notify`: the mailer-bound `notifyWithEmail` (plain `notify` skips the
//     email leg), falling back to `notify` where the root binds no mailer;
//   - `reportError`: the notice is a deliberate swallow, so each failure is
//     reported (CLAUDE.md, Sentry); the API root wires it to Sentry;
//   - `dealUrlFor`: the notice's link, built from `publicAppUrl`.
// Every procedure whose input carries `frozenChange` spreads this into its
// deps, so a frozen change never takes core's `not_wired` branch.
// ─────────────────────────────────────────────────────────────────────────────

/** The web path of an event's deal page (the notice's "View the deal" link). */
export function dealPagePath(eventId: string): string {
  return `/deals/${encodeURIComponent(eventId)}`;
}

export function dealChangeNoticeDeps(
  ctx: Pick<Ctx, "notify" | "notifyWithEmail" | "reportError" | "publicAppUrl">,
): Required<Pick<DealChangeNoticeDeps, "notify" | "dealUrlFor">> &
  Pick<DealChangeNoticeDeps, "reportError"> {
  const base = ctx.publicAppUrl ? ctx.publicAppUrl.replace(/\/+$/, "") : null;
  return {
    notify: ctx.notifyWithEmail ?? ctx.notify,
    ...(ctx.reportError ? { reportError: ctx.reportError } : {}),
    dealUrlFor: (eventId) => (base ? `${base}${dealPagePath(eventId)}` : null),
  };
}

"use client";

import { usePathname } from "next/navigation";

import { isPrintDocumentRoute } from "@/lib/print-route";

import { AdminShell, type AdminShellProps } from "./AdminShell";

/**
 * Chrome selector for `/admin/[slug]/**` — the admin half of the print layer's
 * bypass.
 *
 * `AppChrome` already drops the consumer shell for a `…/print` route, but Next
 * layouts NEST: an admin-nested document still renders inside
 * `/admin/[slug]/layout.tsx`, which wraps everything in `AdminShell`. Without
 * this, the volunteer badge sheet would preview inside the admin rail and —
 * far worse — the entire rail, top bar and bottom bar would land on the
 * printed page, since none of that chrome carries `[data-print-hide]`.
 *
 * ── Why the branch lives in its own component ─────────────────────────────
 *
 * An early return inside `AdminShell` itself would break the rules of hooks.
 * `AdminShell` calls upwards of thirty hooks, and client-navigating from an
 * admin page INTO the print route changes `usePathname()` while the component
 * stays mounted — so the early return would change the hook count between
 * renders of the same instance and React would throw. Branching one level up
 * makes it an ordinary unmount/mount instead: this component calls exactly one
 * hook and then decides which subtree to render.
 *
 * ── What this does NOT remove ─────────────────────────────────────────────
 *
 * The layout's server-side session check runs first and is untouched, so an
 * anonymous request is still redirected to sign-in before any admin HTML
 * ships. What is skipped is `AdminShell`'s CLIENT-side slug-ownership redirect
 * — which was never an authorization boundary. The document's own reads are
 * org-edit-gated server-side and answer with an error, not a page, for an
 * operator with no claim on the workspace. That is the same posture, and the
 * same reasoning, as the SECURITY NOTE in `src/lib/print-route.ts`.
 */
export const AdminShellFrame = (props: AdminShellProps) => {
  const pathname = usePathname();

  if (isPrintDocumentRoute(pathname)) {
    return <>{props.children}</>;
  }

  return <AdminShell {...props} />;
};

AdminShellFrame.displayName = "AdminShellFrame";

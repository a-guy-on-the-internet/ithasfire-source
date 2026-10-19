import { Suspense } from "react";
import { redirect } from "next/navigation";

import { SettingsSurface } from "../_components/SettingsSurface";
import {
  isSettingsSectionSlug,
  SETTINGS_BASE_PATH,
} from "../_lib/settings-routes";

/**
 * `/account/settings/[section]` — one route per settings section.
 *
 * One dynamic segment with an explicit whitelist, not twelve hand-written
 * folders: the whitelist is the same constant the nav and the entitlement
 * builder read (`_lib/settings-routes.ts`), so a section can never exist as a
 * URL without existing in the nav, or vice versa.
 *
 * This is a Server Component ON PURPOSE. An unknown slug is answered with a
 * real redirect before any HTML is produced — no 404, no client-side flash of a
 * settings shell that is about to navigate away. That is also why the slug
 * vocabulary lives in a plain `.ts` module with no `"use client"`: a Server
 * Component cannot call a function exported across a client boundary.
 *
 * PER-USER entitlement (venue claims, contributions, the work group) cannot be
 * decided here — it needs the authed `humans.getMyWorkSummary` query — so it is
 * enforced client-side in `SettingsSurface`, and only once that query has
 * resolved. Redirecting while it is still loading would bounce legitimate users.
 */
export default async function SettingsSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;

  if (!isSettingsSectionSlug(section)) {
    redirect(SETTINGS_BASE_PATH);
  }

  // `SettingsSurface` reads `?redirect_url=` via `useSearchParams()`, which
  // needs a Suspense boundary at static-build time.
  return (
    <Suspense fallback={null}>
      <SettingsSurface section={section} />
    </Suspense>
  );
}

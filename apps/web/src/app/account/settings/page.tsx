"use client";

import { Suspense, useEffect, useRef } from "react";
import { useRouter } from "@bprogress/next/app";
import { useSearchParams } from "next/navigation";

import { SettingsSurface } from "./_components/SettingsSurface";
import {
  DEFAULT_SETTINGS_SECTION,
  resolveLegacyHashTarget,
  settingsSectionHref,
} from "./_lib/settings-routes";

/**
 * `/account/settings` — the settings INDEX.
 *
 * Desktop: the grouped rail plus the default (Profile) section, so the bare URL
 * is still a usable settings page. Mobile: the rail IS the index, and the
 * section body is suppressed — see `SettingsSurface`'s `isIndexRoute`.
 *
 * Also the compatibility shim for everything that still points at the old
 * single-scroll page:
 *  - `#email` / `#notifications` / `#profile` / `#phone-number-section` and the
 *    old camelCase rail ids → replace-navigate to the owning section route.
 *  - `?redirect_url=…` (only `/enroll-2fa` sends it) → Security, where the
 *    "finish setting up your second factor" return banner lives.
 *
 * In-repo sources were pointed at the real routes; this stays for bookmarks and
 * for any link outside the repo.
 *
 * `useSearchParams()` requires a `<Suspense>` boundary at static-build time, so
 * the body lives in an inner component.
 */
export default function AccountSettingsPage() {
  return (
    <Suspense fallback={null}>
      <AccountSettingsIndexRoute />
    </Suspense>
  );
}

function AccountSettingsIndexRoute() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // One-shot: a replace() re-runs this component, and re-firing would fight
  // any navigation the user has since made.
  const shimmedRef = useRef(false);

  useEffect(() => {
    if (shimmedRef.current) return;
    shimmedRef.current = true;

    // `location` is the only source for the hash — Next's router does not
    // expose it, and it never reaches the server.
    const search = window.location.search;

    const hashTarget = resolveLegacyHashTarget(window.location.hash, search);
    if (hashTarget) {
      router.replace(hashTarget);
      return;
    }

    // Presence check only; the Security route re-reads the param through
    // `readRedirectParam`, which rejects off-site and `javascript:` targets.
    if (searchParams.get("redirect_url")) {
      router.replace(`${settingsSectionHref("security")}${search}`);
    }
  }, [router, searchParams]);

  return <SettingsSurface section={DEFAULT_SETTINGS_SECTION} isIndexRoute />;
}

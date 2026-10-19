"use client";

import { UnifiedScanView } from "./_components/UnifiedScanView";

/**
 * FR-011 — the admin scan page, with one implementation.
 *
 * This route used to fork on the `unifiedScanResolver` feature gate, and the
 * gate is not set in the database anywhere, so the code default (`false`) won
 * and **production was serving `LegacyScanView`**. That branch admitted a
 * camera-decoded ticket IMMEDIATELY, with no confirmation step: a QR in frame
 * was an admission. Deleting the fork retires it, and after this change no
 * surface anywhere admits a ticket without an explicit operator action (the
 * app's opt-in express mode is the single, deliberate exception, and the web
 * does not get it).
 *
 * The gate read, the web-side gate type and the web fallback snapshot went with
 * it. The `unifiedScanResolver` slug REMAINS in
 * `packages/types/src/repos/platform-settings.ts` — that list is shared with
 * the platform-admin settings surface and dropping a slug there is a separate,
 * cross-surface change.
 *
 * The page component is deliberately a thin shell: the view is where the
 * behaviour lives, so it can be exercised without a route.
 */
export default function ScanPage() {
  return <UnifiedScanView />;
}

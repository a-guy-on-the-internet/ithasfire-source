import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { OrgSettingsView } from "./_components/OrgSettingsView";
import { DEFAULT_ORG_SETTINGS_SECTION } from "./_lib/org-settings-routes";

/**
 * `/admin/[slug]/settings` — the org settings INDEX.
 *
 * Desktop: the grouped rail plus the default (General) section, so the bare URL
 * is still a usable settings page. Mobile: the rail IS the index and the section
 * body is suppressed — see `OrgSettingsView`'s `isIndexRoute`.
 */
export default function AdminSettingsPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <OrgSettingsView section={DEFAULT_ORG_SETTINGS_SECTION} isIndexRoute />
    </AdminEmailVerificationGate>
  );
}

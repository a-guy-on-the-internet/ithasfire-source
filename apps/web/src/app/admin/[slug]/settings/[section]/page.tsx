import { redirect } from "next/navigation";

import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";

import { OrgSettingsView } from "../_components/OrgSettingsView";
import {
  isOrgSettingsDynamicSlug,
  orgSettingsLegacyRedirect,
} from "../_lib/org-settings-routes";

/**
 * `/admin/[slug]/settings/[section]` — one route per org-settings section.
 *
 * One dynamic segment with an explicit whitelist, not eight hand-written
 * folders: the whitelist is the same constant the nav model reads
 * (`_lib/org-settings-routes.ts`), so a section can never exist as a URL
 * without existing in the nav, or vice versa. It replaces the previous
 * `contact/` and `danger/` folders, which were three near-identical
 * `OrgSettingsView` wrappers.
 *
 * A section that needs its own server gate keeps a hand-written folder
 * instead (`ORG_SETTINGS_STANDALONE_SLUGS`, none today);
 * `isOrgSettingsDynamicSlug` excludes those so a gate can never be routed
 * around.
 *
 * This is a Server Component ON PURPOSE. An unknown slug is answered with a real
 * redirect before any HTML is produced — no 404, no client-side flash of a
 * settings shell that is about to navigate away.
 *
 * MOVED sections are answered FIRST, from `ORG_SETTINGS_LEGACY_REDIRECTS`, so a
 * retired slug goes to where its surface actually lives instead of silently
 * riding the unknown-slug fallback down to the settings index. The two branches
 * are deliberately separate: "this moved, follow it" and "no idea what that is,
 * here's the index" are different answers and should read as different code.
 *
 * PER-MEMBER entitlement (OWNER-only danger zone, editor-only booking sections)
 * cannot be decided here — it needs the authed owner lookup — so it is enforced
 * client-side in `OrgSettingsView`, and only once that lookup resolves.
 */
export default async function AdminSettingsSectionPage({
  params,
}: {
  params: Promise<{ slug: string; section: string }>;
}) {
  const { slug, section } = await params;

  const movedTo = orgSettingsLegacyRedirect(section, slug);
  if (movedTo) {
    redirect(movedTo);
  }

  if (!isOrgSettingsDynamicSlug(section)) {
    redirect(`/admin/${slug}/settings`);
  }

  return (
    <AdminEmailVerificationGate mode="block">
      <OrgSettingsView section={section} />
    </AdminEmailVerificationGate>
  );
}

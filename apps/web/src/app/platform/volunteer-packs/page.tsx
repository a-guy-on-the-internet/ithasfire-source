import { PackCatalogueView } from "./_components/PackCatalogueView";

/**
 * `/platform/volunteer-packs` — the staff catalogue (FR-014).
 *
 * Every `volunteerPacks.admin.*` procedure is STAFF_TECH-gated inside its use
 * case, so this route's real boundary is the server; the nav entry's
 * `rbac: STAFF_TECH` only keeps a REVIEWER or SUPPORT member from being shown
 * a door that would 403.
 */
export default function PlatformVolunteerPacksPage() {
  return <PackCatalogueView />;
}

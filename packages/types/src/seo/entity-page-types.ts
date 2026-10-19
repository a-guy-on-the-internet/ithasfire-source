import type { PageOwnerType, EntitySummary } from "../repos/entity-pages";

// ── Entity Page SEO types ────────────────────────────────────────────────

export interface SeoEntityPage {
  url: string;
  ownerType: PageOwnerType;
  displayName: string;
  bio?: string | null;
  avatarUrl?: string | null;
  bannerUrl?: string | null;
  entity: EntitySummary;
}

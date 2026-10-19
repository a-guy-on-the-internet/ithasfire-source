import type { SeoEntityPage } from "@th/types/seo/entity-page-types";
import type { loadEntityPageBySlug } from "@/server/entity-pages";
import { resolveEntityDisplayName } from "./resolve-entity-display-name";

/**
 * Map the public-page data to the shape the SEO helpers expect.
 * Shared across `/p/[slug]`, `/humans/[slug]`, `/places/[slug]`, `/orgs/[slug]`.
 */
export function toSeoEntityPage(
  data: NonNullable<Awaited<ReturnType<typeof loadEntityPageBySlug>>>["data"],
  url: string,
): SeoEntityPage {
  return {
    url,
    ownerType: data.page.ownerType,
    displayName: resolveEntityDisplayName(data.page, data.entity),
    bio: data.page.bio,
    avatarUrl: data.page.avatarUrl,
    bannerUrl: data.page.bannerUrl,
    entity: data.entity,
  };
}

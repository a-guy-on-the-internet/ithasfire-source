export interface FeaturedItemRecord {
  id: string;
  itemType: "EVENT" | "HUMAN" | "ORGANIZATION" | "PLACE";
  itemId: string;
  title: string | null;
  subtitle: string | null;
  heroImageUrl: string | null;
  ctaUrl: string | null;
  ctaLabel: string | null;
  sortOrder: number;
  active: boolean;
  curatedByHumanId: string | null;
  curatedAt: Date;
  curatedUntil: Date | null;
  notes: string | null;
}

export type FeaturedItemType = FeaturedItemRecord["itemType"];

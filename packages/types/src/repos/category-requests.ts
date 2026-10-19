export type EventCategoryRequestKind = "CATEGORY";

export type EventCategoryRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface EventCategoryRequestRecord {
  id: string;
  kind: EventCategoryRequestKind;
  status: EventCategoryRequestStatus;
  name: string;
  slug: string;
  categoryId: string | null;
  categorySlug: string | null;
  categoryName: string | null;
  eventId: string | null;
  requesterHumanId: string;
  reviewedByHumanId: string | null;
  reviewNote: string | null;
  resolvedCategoryId: string | null;
  /**
   * The requester's UI locale when they asked ("en" | "es"). Null = English
   * (and every request older than category translations).
   */
  locale: string | null;
  createdAt: Date;
  updatedAt: Date;
  reviewedAt: Date | null;
}

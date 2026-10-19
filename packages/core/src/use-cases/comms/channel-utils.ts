import type { NotificationPreferenceScope } from "@th/ports/repos/notification-preferences";

import { categoryMetricsTag, type NotificationCategory } from "./categories";

type MetadataInput = Record<string, unknown>;

type TagsInput = readonly string[];

type NotificationAction = {
  label: string;
  href?: string | null;
  route?: string | null;
} | null;

export function sanitizeMetadata(
  metadata: MetadataInput,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      result[key] = String(value);
    } else if (value instanceof Date) {
      result[key] = value.toISOString();
    } else if (value != null) {
      try {
        result[key] = JSON.stringify(value);
      } catch {
        // ignore non-serializable entries
      }
    }
  }
  return result;
}

export function buildTags(
  base: TagsInput,
  category: NotificationCategory,
  variant: string,
): string[] {
  const tags = new Set<string>(base);
  tags.add(category);
  tags.add(variant);
  tags.add(categoryMetricsTag(category));
  return Array.from(tags);
}

export function normalizeAction(
  action: NotificationAction,
): { label: string; href?: string; route?: string } | undefined {
  if (!action) return undefined;

  const normalized: { label: string; href?: string; route?: string } = {
    label: action.label,
  };

  if (typeof action.href === "string" && action.href.length > 0) {
    normalized.href = action.href;
  }

  if (typeof action.route === "string" && action.route.length > 0) {
    normalized.route = action.route;
  }

  return normalized;
}

export function scopeKey(scope: NotificationPreferenceScope): string {
  switch (scope.kind) {
    case "GLOBAL":
      return "global";
    case "ORG":
      return `org:${scope.orgId}`;
    case "EVENT":
      return `event:${scope.eventId}`;
    default:
      return "global";
  }
}

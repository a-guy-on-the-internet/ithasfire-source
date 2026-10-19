"use client";

import { XStack, YStack } from "tamagui";
import { Badge, Text, useFormatters, useTranslations } from "@th/ui";

import { extractSuggestionBodyPreview } from "./suggestion-body-preview";

/**
 * Per-field before/after diff for an EventEditSuggestion — shared by the
 * community moderator queue (/moderate/suggestions) and the owner-side
 * suggestion inboxes (FR-016). Purely presentational: the caller supplies
 * the raw before/after values (from the suggestion's `baseVersion` /
 * `fields` Json) plus the conflict/material flags; no data fetching here.
 *
 * Rendering rules per field kind:
 * - `content` (EventBody Json): plain-text preview truncated to ~300 chars —
 *   never mounts ProseMirror. Falls back to a "structured content · N chars"
 *   note when no text can be extracted.
 * - `startsAt` / `endsAt`: formatted via the locale formatters.
 * - image thumbnails render ONLY from the explicit `imageUrls` prop
 *   (server-resolved URLs supplied by the caller). Field VALUES are
 *   anonymous-submittable text and are NEVER interpreted as URLs — an
 *   <img> sourced from a submitted string (e.g. a URL-shaped title) would
 *   make the reviewer's browser GET an attacker-controlled URL on open
 *   (IP/UA deanonymization of moderators).
 * - null: muted "Not set".
 */
export type SuggestionDiffCardProps = {
  fieldKey: string;
  /** Human label for the field (caller translates). */
  label: string;
  before: unknown;
  after: unknown;
  /** FR-009: the event drifted since the suggestion was drafted. */
  conflicted?: boolean;
  /** FR-013: schedule/venue fields that materially affect attendees. */
  material?: boolean;
  /**
   * OPT-IN thumbnails for image fields. Only ever pass SERVER-RESOLVED
   * URLs (e.g. a heroImageId → CDN URL hydration done by the caller);
   * NEVER derive these from suggestion field values.
   */
  imageUrls?: { before?: string; after?: string };
};

const DATE_FIELD_KEYS = new Set(["startsAt", "endsAt"]);
const ID_FIELD_KEYS = new Set(["heroImageId", "categoryId"]);

export function SuggestionDiffCard({
  fieldKey,
  label,
  before,
  after,
  conflicted = false,
  material = false,
  imageUrls,
}: SuggestionDiffCardProps) {
  const t = useTranslations();

  return (
    <YStack
      borderWidth={conflicted ? 3 : 2}
      borderColor={conflicted ? "$danger" : "$borderColor"}
      backgroundColor="$surface"
      padding="$3"
      gap="$2"
    >
      <XStack
        justifyContent="space-between"
        alignItems="center"
        gap="$2"
        flexWrap="wrap"
      >
        <XStack gap="$2" alignItems="center">
          <Text
            variant="caption"
            weight="bold"
            textTransform="uppercase"
            letterSpacing={0.5}
          >
            {label}
          </Text>
          {material ? (
            <Text
              variant="caption"
              tone="muted"
              textTransform="uppercase"
              letterSpacing={0.5}
            >
              {String(t("moderation.material"))}
            </Text>
          ) : null}
        </XStack>
        {conflicted ? (
          <Badge tone="danger" size="sm">
            {String(t("moderation.conflict")).toUpperCase()}
          </Badge>
        ) : null}
      </XStack>

      {/* Before/after two-column; stacks on narrow screens via wrap. */}
      <XStack gap="$3" flexWrap="wrap">
        <YStack flex={1} minWidth={200} gap="$1">
          <Text variant="caption" tone="muted" textTransform="uppercase">
            {String(t("moderation.before"))}
          </Text>
          <FieldValue
            fieldKey={fieldKey}
            value={before}
            imageUrl={imageUrls?.before}
          />
        </YStack>
        <YStack flex={1} minWidth={200} gap="$1">
          <Text variant="caption" tone="muted" textTransform="uppercase">
            {String(t("moderation.after"))}
          </Text>
          <FieldValue
            fieldKey={fieldKey}
            value={after}
            imageUrl={imageUrls?.after}
          />
        </YStack>
      </XStack>
    </YStack>
  );
}

function FieldValue({
  fieldKey,
  value,
  imageUrl,
}: {
  fieldKey: string;
  value: unknown;
  /** Explicit server-resolved thumbnail URL — see SuggestionDiffCardProps. */
  imageUrl?: string;
}) {
  const t = useTranslations();
  const fmt = useFormatters();

  // Thumbnail ONLY when the caller explicitly supplied a resolved URL.
  // Never sourced from `value` (anonymous-submittable text).
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt=""
        aria-hidden
        loading="lazy"
        style={{
          width: 96,
          height: 64,
          objectFit: "cover",
          display: "block",
        }}
      />
    );
  }

  if (value === null || value === undefined) {
    return (
      <Text variant="bodySmall" tone="muted">
        {String(t("moderation.emptyValue"))}
      </Text>
    );
  }

  // Event body Json → plain-text preview (never mounts ProseMirror).
  if (fieldKey === "content") {
    const preview = extractSuggestionBodyPreview(value);
    if (preview) {
      return <Text variant="bodySmall">{preview}</Text>;
    }
    let chars = 0;
    try {
      chars = JSON.stringify(value)?.length ?? 0;
    } catch {
      chars = 0;
    }
    return (
      <Text variant="bodySmall" tone="muted">
        {String(t("moderation.bodyPreviewFallback", { chars }))}
      </Text>
    );
  }

  // Instants (stored as ISO strings in the suggestion Json).
  if (DATE_FIELD_KEYS.has(fieldKey)) {
    const date =
      value instanceof Date ? value : new Date(Date.parse(String(value)));
    if (!Number.isNaN(date.getTime())) {
      return (
        <Text variant="bodySmall">
          {fmt.dateTime(date, {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </Text>
      );
    }
  }

  if (typeof value === "string") {
    // Reference ids render code-like (no name hydration in the contract).
    if (ID_FIELD_KEYS.has(fieldKey)) {
      return (
        <Text
          variant="caption"
          tone="muted"
          style={{ fontFamily: "var(--font-mono, monospace)" }}
        >
          {value}
        </Text>
      );
    }
    return <Text variant="bodySmall">{value}</Text>;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return <Text variant="bodySmall">{String(value)}</Text>;
  }

  // Unknown structured value — safe stringification, never a crash.
  let fallback: string;
  try {
    fallback = JSON.stringify(value) ?? String(value);
  } catch {
    fallback = String(value);
  }
  return (
    <Text variant="bodySmall" tone="muted">
      {fallback}
    </Text>
  );
}

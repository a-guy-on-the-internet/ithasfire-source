"use client";

/**
 * The one place a pack's DRAFT/LIVE state is drawn.
 *
 * Status has to read at a glance across a list, so it is encoded three ways —
 * TEXT, COLOUR and FORM. A LIVE pack is a filled success chip with a dot; a
 * DRAFT one is a hollow warning chip. Fill-vs-outline survives a monochrome
 * screenshot and a red/green colour-blind reader, which colour alone does not.
 *
 * Both tones are semantic (`$success` / `$warning`), deliberately NOT the brand
 * accent: `$accent` means "Ithas Fire" on these surfaces (the catalogue tag),
 * and a status that borrowed it would read as provenance.
 *
 * `Badge` is `radius: 0` — content, strict Swiss. The border is 1px on the
 * outline variant and 0 on solid (`feedback/Badge.tsx`); the fill/hollow contrast,
 * not border weight, is what carries the distinction.
 */

import { Badge, useTranslations } from "@th/ui";

export type VolunteerPackStatus = "DRAFT" | "LIVE";

export function PackStatusPill({
  status,
  size = "sm",
  testId,
}: {
  status: VolunteerPackStatus;
  size?: "xs" | "sm" | "md";
  testId?: string;
}) {
  const t = useTranslations();
  const isLive = status === "LIVE";
  return (
    <Badge
      tone={isLive ? "success" : "warning"}
      variant={isLive ? "solid" : "outline"}
      size={size}
      dot
      {...(testId ? { "data-testid": testId } : {})}
    >
      {String(
        t(
          isLive
            ? "admin.volunteerPackStatusLive"
            : "admin.volunteerPackStatusDraft",
        ),
      )}
    </Badge>
  );
}

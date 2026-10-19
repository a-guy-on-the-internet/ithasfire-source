"use client";

/**
 * PackRoleCatalogue — the pack cards an organizer sees, rendered from data.
 *
 * ONE renderer, two callers, on purpose (FR-016): `PackPickerGrid` fetches the
 * org-scoped LIVE catalogue and hands it here; the staff pack editor hands it a
 * single DRAFT pack straight off `volunteerPacks.admin.get`. "Preview as an
 * organizer" is only a preview if it is the organizer's own component — a
 * second implementation would drift, and the drift would only ever be visible
 * after the pack was already published.
 *
 * Presentational and data-free: no queries, no mutations, no i18n decisions the
 * caller can't override. The per-role trailing action is a render prop, so the
 * organizer gets "Customise" and the staff preview gets nothing at all — the
 * one honest difference between the two surfaces.
 *
 * Blurbs and role descriptions are staff-authored free text rendered as TEXT
 * children — never HTML (NFR-004).
 */

import type { ReactNode } from "react";
import { XStack, YStack } from "tamagui";
import { Text, useTranslations } from "@th/ui";

import { CatalogueTag } from "@/components/volunteering/PlatformTemplateTag";

export interface CatalogueRoleView {
  id: string;
  name: string;
  description?: string | null;
  defaultCapacity?: number | null;
  packId?: string | null;
  shifts: ReadonlyArray<unknown>;
}

export interface CataloguePackView {
  id: string;
  key: string;
  name: string;
  blurb: string | null;
  /**
   * Ranking signal, currently always false — an Organization has no category
   * column, so nothing honest feeds it. Kept wired: it is a server field away.
   */
  categoryMatch?: boolean;
  roles: ReadonlyArray<CatalogueRoleView>;
}

export interface PackRoleCatalogueProps {
  packs: ReadonlyArray<CataloguePackView>;
  /** Trailing control per role. Omitted = read-only (the staff preview). */
  renderRoleAction?: (role: CatalogueRoleView) => ReactNode;
  /** Shown above the grid. Omitted = no lede. */
  helpText?: string;
  testId?: string;
}

export function PackRoleCatalogue({
  packs,
  renderRoleAction,
  helpText,
  testId = "volunteer-pack-catalogue",
}: PackRoleCatalogueProps) {
  const t = useTranslations();

  return (
    <YStack gap="$3" width="100%" data-testid={testId}>
      {helpText ? (
        <Text variant="caption" tone="muted">
          {helpText}
        </Text>
      ) : null}

      {/* Card collection → grid: the pack cards must line up column-wise
          across rows, and auto-fill keeps that true without media queries. */}
      <YStack
        width="100%"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: 16,
        }}
      >
        {packs.map((pack) => (
          <YStack
            key={pack.id}
            gap="$3"
            borderWidth={1}
            borderColor="$borderColor"
            backgroundColor="$surface"
            padding="$4"
            data-testid={`volunteer-pack-${pack.key}`}
          >
            <YStack gap="$2">
              <XStack gap="$2" alignItems="center" flexWrap="wrap">
                <Text
                  variant="h4"
                  weight="bold"
                  style={{ textTransform: "uppercase" }}
                >
                  {pack.name}
                </Text>
                {/*
                  Same chip component as the "From Ithas Fire" mark — see
                  `CatalogueTag` for why one accent treatment carries both
                  meanings. Re-typing it inline is what dropped `flexShrink` and
                  `nowrap`, letting a long pack name wrap the chip out of its
                  own border in a `minmax(320px, 1fr)` column.
                */}
                {pack.categoryMatch ? (
                  <CatalogueTag
                    label={String(t("admin.volunteerPackRecommendedTag"))}
                    testId={`volunteer-pack-${pack.key}-recommended`}
                  />
                ) : null}
              </XStack>
              {pack.blurb ? (
                <Text variant="caption" tone="muted">
                  {pack.blurb}
                </Text>
              ) : null}
            </YStack>

            <YStack gap="$2">
              {pack.roles.map((role) => (
                <XStack
                  key={role.id}
                  gap="$3"
                  alignItems="center"
                  justifyContent="space-between"
                  borderTopWidth={1}
                  borderTopColor="$borderColorSoft"
                  paddingTop="$2"
                  flexWrap="wrap"
                >
                  <YStack flex={1} minWidth={160} gap="$1">
                    <Text variant="body" style={{ fontWeight: 700 }}>
                      {role.name}
                    </Text>
                    <Text variant="caption" tone="muted">
                      {role.shifts.length > 0
                        ? String(
                            t("admin.volunteerShiftCount", {
                              count: role.shifts.length,
                            }),
                          )
                        : String(t("admin.volunteerShiftEmpty"))}
                    </Text>
                  </YStack>
                  {renderRoleAction?.(role) ?? null}
                </XStack>
              ))}
            </YStack>
          </YStack>
        ))}
      </YStack>
    </YStack>
  );
}

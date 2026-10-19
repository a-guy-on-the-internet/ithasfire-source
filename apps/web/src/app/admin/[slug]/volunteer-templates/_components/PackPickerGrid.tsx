"use client";

/**
 * PackPickerGrid — the organizer-facing catalogue browser (FR-013).
 *
 * This file owns the QUERY and the fork affordance; the cards themselves are
 * {@link PackRoleCatalogue}, shared verbatim with the staff "preview as an
 * organizer" surface (FR-016) so the preview cannot drift from the thing it
 * claims to preview.
 *
 * Ranking, not filtering: the server returns EVERY live pack and only ORDERS
 * them (pinned → category match → curation order → name). The "recommended"
 * tag reflects that ordering signal and nothing else — it pre-selects nothing
 * and creates nothing. Every role listed here is already usable on an event
 * as-is; "Customise" only forks it into an editable org-owned copy.
 */

import { YStack } from "tamagui";
import { Button, Text, useTranslations } from "@th/ui";
import { Copy } from "lucide-react";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { PackRoleCatalogue } from "@/components/volunteering/PackRoleCatalogue";

export interface PackPickerRole {
  id: string;
  name: string;
}

interface PackPickerGridProps {
  orgId: string;
  /** OWNER/ADMIN gate — forking writes an org-owned template. UX only; server 403s. */
  canManage: boolean;
  onCustomise: (role: PackPickerRole) => void;
  /** Template id currently being forked, so its button can show progress. */
  busyTemplateId?: string | null;
  /**
   * Catalogue roles this org has already forked, keyed by
   * `${packId}::${name.toLowerCase()}` — the same (pack, name) identity the
   * server shadows on. A fork gets a NEW template id, so the id is not the
   * link between a catalogue row and the org's copy; the pair is.
   */
  forkedRoleKeys?: ReadonlySet<string>;
}

/** The (pack, name) identity shared by a catalogue role and its org fork. */
export function packRoleShadowKey(role: {
  packId: string | null;
  name: string;
}): string | null {
  if (!role.packId) return null;
  return `${role.packId}::${role.name.toLowerCase()}`;
}

export function PackPickerGrid({
  orgId,
  canManage,
  onCustomise,
  busyTemplateId,
  forkedRoleKeys,
}: PackPickerGridProps) {
  const t = useTranslations();

  const { data, isLoading, error, refetch } = trpc.volunteerPacks.list.useQuery(
    // No `categoryId`: an Organization has no category column, so there is
    // nothing honest to rank against from this surface. The server treats it as
    // optional and falls back to pinned → curation order → name. When an org
    // category exists, passing it here is the only change needed.
    { orgId },
    { staleTime: 60_000 },
  );

  if (isLoading) {
    return (
      <YStack paddingVertical="$4" alignItems="center">
        <Text variant="caption" tone="muted">
          {String(t("admin.loading"))}
        </Text>
      </YStack>
    );
  }

  if (error) {
    return (
      <YStack gap="$2" paddingVertical="$4" alignItems="center">
        <Text variant="caption" tone="error">
          {formatErrorMessage(error)}
        </Text>
        <Button variant="secondary" size="$2" onPress={() => void refetch()}>
          {String(t("admin.retry"))}
        </Button>
      </YStack>
    );
  }

  const packs = (data ?? []).filter((pack) => pack.roles.length > 0);

  if (packs.length === 0) {
    return (
      <YStack paddingVertical="$4" alignItems="center">
        <Text variant="caption" tone="muted" textAlign="center" maxWidth={420}>
          {String(t("admin.volunteerPackPickerEmpty"))}
        </Text>
      </YStack>
    );
  }

  return (
    <PackRoleCatalogue
      packs={packs}
      helpText={String(t("admin.volunteerPackPickerHelp"))}
      testId="volunteer-pack-picker"
      renderRoleAction={(role) => {
        if (!canManage) return null;
        const shadowKey = packRoleShadowKey({
          packId: role.packId ?? null,
          name: role.name,
        });
        const alreadyForked =
          shadowKey !== null && (forkedRoleKeys?.has(shadowKey) ?? false);
        return (
          <Button
            variant="secondary"
            size="$2"
            onPress={() => onCustomise({ id: role.id, name: role.name })}
            disabled={alreadyForked || busyTemplateId === role.id}
            data-testid={`volunteer-pack-role-customise-${role.id}`}
          >
            <Copy size={14} aria-hidden />
            {String(
              t(
                alreadyForked
                  ? "admin.volunteerTemplateCustomised"
                  : "admin.volunteerTemplateCustomiseCta",
              ),
            )}
          </Button>
        );
      }}
    />
  );
}

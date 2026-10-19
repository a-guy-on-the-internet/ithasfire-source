"use client";

import { Text, useTranslations } from "@th/ui";

/**
 * The one line a viewer who cannot route payouts sees where the splits
 * editor would be. PAYOUT ROUTING — splits, payout schedule — is owner-only on a human-owned event (owner ruling
 * 2026-09-28), so an edit-role delegate managing the principal's event is
 * told why the control is missing rather than shown a control the server
 * refuses.
 */
export function PayoutsOwnerOnlyNote() {
  const t = useTranslations();
  return (
    <Text variant="caption" tone="muted" data-testid="payouts-owner-only-note">
      {String(t("admin.ebPayoutsOwnerOnly"))}
    </Text>
  );
}

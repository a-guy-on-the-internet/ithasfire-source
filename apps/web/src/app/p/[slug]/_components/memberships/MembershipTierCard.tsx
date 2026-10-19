import type { ReactNode } from "react";

import styles from "./memberships.module.css";

/**
 * ONE presentational tier card — name, price/interval row, description, tax
 * note, and an `action` slot for whatever CTA the surface needs.
 *
 * Shared by the entity-page Membership tab (`MembershipsPanel`, where the
 * action is the in-page join form/button) and the membership embed widget
 * (`/embed/memberships/[embedId]`, where the action is a link-out to
 * `/p/<slug>?tab=memberships` — subscriptions never run inside a third-party
 * iframe). Extracted rather than forked so the two surfaces can't drift.
 *
 * Styling rides the same CSS module in both places; the embed remaps the
 * module's app vars (`--color`, `--surface`, `--brandSecondaryHover`, …) onto
 * its forced-light `--hf-*` theme via a wrapper, so host `brandColor`/`bg`
 * query overrides keep working without this component knowing about them.
 */
export type MembershipTierCardTier = {
  id: string;
  name: string;
  description: string | null;
  /**
   * What members get, in the OWNER'S words (`MembershipTier.benefitsDescription`).
   * Additive to `description`, not a replacement: the description is the pitch,
   * this is the promise. Plain text, rendered as text — never as markup, and
   * never accompanied by any deductibility framing of ours (AB 488).
   */
  benefitsDescription: string | null;
};

export function MembershipTierCard({
  tier,
  priceLabel,
  intervalLabel,
  taxNote,
  action,
}: {
  tier: MembershipTierCardTier;
  /** Formatted price, e.g. "$10.00" (formatting stays with the caller's locale tools). */
  priceLabel: string;
  /** "per month" / "per year". */
  intervalLabel: string;
  taxNote: string;
  /** CTA area — join form/button (entity page) or link-out anchor (embed). */
  action?: ReactNode;
}) {
  return (
    <li className={styles.tierCard}>
      <span className={styles.tierName}>{tier.name}</span>
      <span className={styles.tierPriceRow}>
        <span className={styles.tierPrice}>{priceLabel}</span>
        <span className={styles.tierInterval}>{intervalLabel}</span>
      </span>
      {tier.description && (
        <span className={styles.tierDescription}>{tier.description}</span>
      )}
      {tier.benefitsDescription && (
        <span className={styles.tierBenefits}>{tier.benefitsDescription}</span>
      )}
      <span className={styles.taxNote}>{taxNote}</span>
      {action}
    </li>
  );
}

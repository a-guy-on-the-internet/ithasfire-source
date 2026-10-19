"use client";

import { useParams } from "next/navigation";
import { Spinner, useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { getSiteUrl } from "@/config/site";
import { formatCurrency } from "@/lib/format";
import { getEmbedHostOrigin } from "@/lib/embed-host-origin";
import { DEFAULT_SUPPORT_EMAIL } from "@/app/embed/[embedId]/_components/embed-helpers";
import { EmbedErrorScreen } from "@/app/embed/[embedId]/_components/EmbedErrorScreen";
import { useEmbedBridge } from "@/app/embed/[embedId]/_components/useEmbedBridge";
import { useEmbedThemeOverrides } from "@/app/embed/[embedId]/_components/useEmbedThemeOverrides";
import {
  BORDER,
  TEXT,
  TEXT_CAPTION,
  TEXT_MUTED,
  embedThemeBridgeStyle,
  sectionLabelStyle,
  type EmbedThemeOverrides,
} from "@/app/embed/[embedId]/_components/embed-theme";
import {
  MembershipTierCard,
} from "@/app/p/[slug]/_components/memberships/MembershipTierCard";
import panelStyles from "@/app/p/[slug]/_components/memberships/memberships.module.css";

/**
 * Membership-tiers embed widget iframe (recurring-memberships owner flow
 * step 3: "a shareable join link plus an embed widget").
 *
 * Read-only pitch: the owner's ACTIVE tiers (via the origin-allowlisted
 * `embeds.getMembershipWidget`) with a Join CTA that opens
 * `/p/<slug>?tab=memberships` in a NEW TOP-LEVEL TAB — the same target the
 * admin join-link dialog copies. There is deliberately no in-frame join:
 * subscriptions need an authed session, a platform-owned Stripe Customer and
 * an Elements confirm, none of which belong in a third-party iframe (and the
 * guest-checkout path doesn't fit them — saved card + portal management need
 * the first-party context). Link-out mirrors the events widget's `linkOut`
 * convention (`target="_blank" rel="noopener noreferrer"`).
 */

/**
 * The tier cards are the SHARED entity-page card (`MembershipTierCard` +
 * memberships.module.css), which styles itself from the platform theme vars —
 * on /embed/* always the light theme (Stub + the active preset, see
 * lib/route-context.ts), so by default the cards need nothing.
 *
 * Host knobs arrive through the shared bridge (text, background incl. the
 * `--surface` card panel, and the Join CTA's `--brandSecondary*` ladder), plus
 * the one this card reads that the widget-wide bridge deliberately leaves
 * alone — as the old EMBED_TIER_CARD_VARS map routed it:
 * - accentColor → `--accent` (the card's accent rules).
 * Only ACTIVE overrides are emitted.
 */
function tierCardBridgeStyle(o: EmbedThemeOverrides): React.CSSProperties {
  const style: Record<string, string> = {};
  if (o.accentColor) {
    style["--accent"] = "var(--hf-accent)";
  }
  return { ...embedThemeBridgeStyle(o), ...style } as React.CSSProperties;
}

export default function EmbedMembershipsWidgetPage() {
  const { embedId } = useParams<{ embedId: string }>();
  const t = useTranslations();

  // Apply URL-based theme overrides (same brandColor/bg/fontColor/accentColor
  // query params as the ticket + booking widgets).
  const themeOverrides = useEmbedThemeOverrides();

  // hf:ready + hf:resize so the SDK's inline iframe sizes correctly. One
  // static screen — the pitch grid — so it maps onto the bridge's "grid".
  useEmbedBridge(embedId, "grid");

  const { data, isLoading, error, refetch } =
    trpc.embeds.getMembershipWidget.useQuery(
      { embedId, hostOrigin: getEmbedHostOrigin() },
      {
        staleTime: 60_000,
        // An origin-allowlist rejection is deterministic — retrying can't
        // succeed, so don't burn two extra round-trips on FORBIDDEN.
        retry: (failureCount, err) =>
          err.data?.code !== "FORBIDDEN" && failureCount < 2,
        retryDelay: 1500,
        // Failures render the calm branded EmbedErrorScreen below — opt out
        // of the global error toast inside the iframe.
        meta: { silent: true },
      },
    );

  const { data: platformSettings } =
    trpc.embeds.getPlatformPublicSettings.useQuery(undefined, {
      staleTime: 300_000,
      retry: 1,
    });
  const supportEmail = platformSettings?.supportEmail ?? DEFAULT_SUPPORT_EMAIL;

  // ── Loading ─────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div
        className="th-embed-fade-in"
        style={{
          display: "flex",
          minHeight: 200,
          alignItems: "center",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <Spinner size="md" indicatorColor={TEXT_CAPTION} />
      </div>
    );
  }

  // ── Error (incl. blocked origin — EmbedErrorScreen maps FORBIDDEN) ──
  if (error || !data) {
    return (
      <EmbedErrorScreen
        error={error}
        onRetry={() => {
          void refetch();
        }}
        supportEmail={supportEmail}
      />
    );
  }

  const { owner, tiers } = data;

  // ── Quiet empty state (no ACTIVE tiers, or a suspended owner) ───────
  // Deliberately NOT an error: an owner who pauses their program (or is
  // suspended) never shows a broken widget on their own website — the same
  // calm-state rule as the booking widget's "not accepting" screen.
  if (tiers.length === 0) {
    return (
      <div
        className="th-embed-fade-in"
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          padding: "48px 24px",
          textAlign: "center",
        }}
      >
        <p style={sectionLabelStyle}>{String(t("embedMemberships.kicker"))}</p>
        <h1
          style={{
            margin: 0,
            fontSize: 18,
            fontWeight: 800,
            lineHeight: 1.3,
            color: TEXT,
          }}
        >
          {String(t("embedMemberships.emptyTitle"))}
        </h1>
        <p style={{ margin: 0, fontSize: 13, color: TEXT_MUTED, maxWidth: 420 }}>
          {String(t("embedMemberships.emptyBody", { name: owner.name }))}
        </p>
      </div>
    );
  }

  const joinHref = owner.joinSlug
    ? `${getSiteUrl()}/p/${owner.joinSlug}?tab=memberships`
    : null;

  // Same display order as the entity-page pitch (MembershipsPanel).
  const sortedTiers = [...tiers].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.priceCents - b.priceCents,
  );

  // ── Pitch grid ──────────────────────────────────────────────────────
  return (
    <div
      className="th-embed-fade-in"
      style={{ display: "flex", flexDirection: "column" }}
    >
      <header
        style={{
          borderBottom: `2px solid ${BORDER}`,
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <p style={sectionLabelStyle}>{String(t("embedMemberships.kicker"))}</p>
        <h1
          style={{
            margin: 0,
            fontSize: 20,
            fontWeight: 800,
            lineHeight: 1.25,
            color: TEXT,
          }}
        >
          {owner.name}
        </h1>
      </header>

      <div style={{ padding: 20, ...tierCardBridgeStyle(themeOverrides) }}>
        <ul className={panelStyles.tierGrid} role="list">
          {sortedTiers.map((tier) => (
            <MembershipTierCard
              key={tier.id}
              tier={tier}
              priceLabel={formatCurrency(tier.priceCents, tier.currency)}
              intervalLabel={String(
                t(
                  tier.interval === "YEAR"
                    ? "embedMemberships.perYear"
                    : "embedMemberships.perMonth",
                ),
              )}
              taxNote={String(t("embedMemberships.taxNote"))}
              action={
                joinHref ? (
                  <a
                    href={joinHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={panelStyles.joinButton}
                    style={{ textDecoration: "none" }}
                    // Tier-qualified accessible name — several tiers each
                    // render a visually identical "Join" CTA, and the new-tab
                    // behaviour is announced.
                    aria-label={String(
                      t("embedMemberships.joinAria", { tier: tier.name }),
                    )}
                  >
                    {String(t("embedMemberships.join"))}
                  </a>
                ) : undefined
              }
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

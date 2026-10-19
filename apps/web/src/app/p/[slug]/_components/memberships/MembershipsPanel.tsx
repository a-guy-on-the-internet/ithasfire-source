"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";

import type { ListPublicTiersOutput } from "@th/core/use-cases/memberships";
import { MEMBERSHIP_BENEFIT_GRANTING_STATUSES } from "@th/core/use-cases/memberships";
// NOT NextLinkAnchor: its inline base style (`color:inherit`) outranks the
// CSS-module rules and would break .secondaryButton's colour-inversion hover
// (ink-on-ink text).
// eslint-disable-next-line no-restricted-imports
import Link from "next/link";
import { useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { authClient } from "@/lib/auth/auth-client";
import { getAppErrorCode } from "@/lib/app-error";
import { formatCurrency, formatDateShort } from "@/lib/format";
import { useAppOverlay } from "@/components/layout/AppOverlayProvider";
import { BlockRenderer } from "../blocks";
import { BlockPageOwnerProvider } from "../blocks/block-page-owner-context";
import { MembershipPaymentStep } from "./MembershipPaymentStep";
import { MembershipTierCard } from "./MembershipTierCard";
import styles from "./memberships.module.css";
import { lookupOwn } from "@/lib/lookup-own";

type PublicTier = ListPublicTiersOutput["items"][number];

type Props = {
  entityName: string;
  ownerType: "HUMAN" | "ORGANIZATION";
  ownerId: string;
  /** ACTIVE public tiers, server-loaded (non-empty — the tab only renders then). */
  tiers: PublicTier[];
};

const GRANTING = MEMBERSHIP_BENEFIT_GRANTING_STATUSES as readonly string[];

/** Codes with join-flow-specific copy; everything else gets the generic line. */
const JOIN_ERROR_KEYS: Record<string, string> = {
  TAX_JURISDICTION_UNSUPPORTED: "entityMemberships.errorRegionUnsupported",
  TAX_JURISDICTION_UNAVAILABLE: "entityMemberships.errorTaxUnavailable",
  MEMBERSHIPS_SUSPENDED: "entityMemberships.errorSuspended",
  MEMBERSHIP_TIER_NOT_ACTIVE: "entityMemberships.errorTierClosed",
  PAYEE_NOT_READY: "entityMemberships.errorTierClosed",
};

/**
 * The Membership tab body (`/p/[slug]?tab=memberships`).
 *
 * Block-level gating, as specified: a viewer with a benefit-granting
 * membership on one of this owner's tiers sees the member content
 * (`section == "memberships"` blocks); everyone else sees the pitch — tier
 * cards with a join flow. Signed-out join CTAs open the standard sign-in
 * overlay (same path as Follow / booking CTAs).
 *
 * The join flow collects the member's billing postal code because membership
 * tax is DESTINATION-sourced (the member's address, never the owner's) and
 * fails closed: `TAX_JURISDICTION_UNSUPPORTED` / `_UNAVAILABLE` surface as
 * clear copy instead of a subscription at a guessed rate. US-only at launch.
 */
export function MembershipsPanel({
  entityName,
  ownerType,
  ownerId,
  tiers,
}: Props) {
  const t = useTranslations();
  const pathname = usePathname();
  const { showSignInOverlay } = useAppOverlay();
  const utils = trpc.useUtils();

  // Hydration guard: `authClient.useSession()` resolves SYNCHRONOUSLY from
  // its client-side cache for a signed-in user, so without this gate the
  // server renders the signed-out pitch while the client's first paint takes
  // the signed-in branch — a hydration mismatch (verified live on /p/demo).
  // First client render matches SSR (signed-out), then flips after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const sessionQuery = authClient.useSession();
  const signedIn = mounted && Boolean(sessionQuery.data?.user);

  const mineQuery = trpc.memberships.mine.list.useQuery(undefined, {
    enabled: signedIn,
    staleTime: 30_000,
  });

  // Member = a benefit-granting membership on ANY of this owner's tiers
  // (including a tier that has since been archived — their standing survives
  // the catalog changing underneath them).
  const myMembership = useMemo(
    () =>
      mineQuery.data?.items.find(
        (m) =>
          m.owner.type === ownerType &&
          m.owner.id === ownerId &&
          GRANTING.includes(m.status),
      ) ?? null,
    [mineQuery.data, ownerType, ownerId],
  );

  // Member-only content (`section == "memberships"` blocks) is NEVER part of
  // the page payload — the public loader drops those sections so they can't
  // land in anonymously-cached HTML/RSC flight. Fetched here, lazily, ONLY
  // once the member gate above has passed; the server re-verifies membership
  // regardless (a forged client state just gets an empty list back).
  const memberBlocksQuery = trpc.memberships.memberBlocks.useQuery(
    { ownerType, ownerId },
    { enabled: signedIn && myMembership != null, staleTime: 30_000 },
  );
  const memberBlocks = memberBlocksQuery.data?.blocks ?? [];

  const sortedTiers = useMemo(
    () =>
      [...tiers].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.priceCents - b.priceCents,
      ),
    [tiers],
  );

  // ── Join flow state ──────────────────────────────────────────────────
  const [joiningTierId, setJoiningTierId] = useState<string | null>(null);
  const [postalCode, setPostalCode] = useState("");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // Payment step: `start` created the subscription default_incomplete and
  // returned the first invoice's PI client secret for Elements to confirm.
  const [paying, setPaying] = useState<{
    membershipId: string;
    tierName: string;
    clientSecret: string;
  } | null>(null);
  const [joined, setJoined] = useState<{
    membershipId: string;
    tierName: string;
    active: boolean;
    /** Payment confirmed in-browser; webhook activation still in flight. */
    processing?: boolean;
  } | null>(null);

  const startMutation = trpc.memberships.start.useMutation();
  const portalMutation = trpc.memberships.portalSession.useMutation();

  const membershipsPath = `${pathname}?tab=memberships`;

  const openJoinForm = useCallback(
    (tierId: string) => {
      if (!signedIn) {
        showSignInOverlay({ redirect: membershipsPath });
        return;
      }
      setErrorKey(null);
      setJoiningTierId(tierId);
    },
    [signedIn, showSignInOverlay, membershipsPath],
  );

  const confirmJoin = useCallback(
    (tier: PublicTier) => {
      const zip = postalCode.trim();
      if (zip.length === 0) {
        setErrorKey("entityMemberships.errorPostalRequired");
        return;
      }
      setErrorKey(null);
      startMutation.mutate(
        {
          tierId: tier.id,
          billingCountryCode: "US",
          billingPostalCode: zip,
        },
        {
          onSuccess: (membership) => {
            setJoiningTierId(null);
            if (membership.paymentIntentClientSecret) {
              // Subscription created `incomplete` — collect the card now.
              setPaying({
                membershipId: membership.id,
                tierName: tier.name,
                clientSecret: membership.paymentIntentClientSecret,
              });
              return;
            }
            // Nothing to pay (already live, or a fully-discounted first
            // invoice) — straight to the success state.
            setJoined({
              membershipId: membership.id,
              tierName: tier.name,
              active: GRANTING.includes(membership.status),
            });
            void utils.memberships.mine.list.invalidate();
          },
          onError: (err) => {
            if (err.data?.code === "UNAUTHORIZED") {
              showSignInOverlay({ redirect: membershipsPath });
              return;
            }
            const code = getAppErrorCode(err);
            setErrorKey(
              lookupOwn(JOIN_ERROR_KEYS, code) ??
                "entityMemberships.errorGeneric",
            );
          },
        },
      );
    },
    [
      postalCode,
      startMutation,
      utils,
      showSignInOverlay,
      membershipsPath,
    ],
  );

  // Payment confirmed in the browser. Activation itself rides the Stripe
  // webhooks (`customer.subscription.updated` + `invoice.payment_succeeded`),
  // so this shows an honest "finishing up" state and refetches: once the row
  // flips to a granting status, the member view above takes over.
  const onPaymentSuccess = useCallback(() => {
    if (!paying) return;
    setJoined({
      membershipId: paying.membershipId,
      tierName: paying.tierName,
      active: false,
      processing: true,
    });
    setPaying(null);
    void utils.memberships.mine.list.invalidate();
    window.setTimeout(() => {
      void utils.memberships.mine.list.invalidate();
    }, 4000);
  }, [paying, utils]);

  // Backed out of the payment step. The membership row exists in Stripe's
  // `incomplete` status (it auto-expires unpaid after ~23h and grants
  // nothing), so land on the existing "finish payment" fallback.
  const onPaymentCancel = useCallback(() => {
    if (!paying) return;
    setJoined({
      membershipId: paying.membershipId,
      tierName: paying.tierName,
      active: false,
    });
    setPaying(null);
    void utils.memberships.mine.list.invalidate();
  }, [paying, utils]);

  const openPortal = useCallback(
    (membershipId: string) => {
      portalMutation.mutate(
        { membershipId, returnPath: membershipsPath },
        {
          onSuccess: ({ url }) => {
            window.location.assign(url);
          },
          onError: () => {
            setErrorKey("entityMemberships.errorPortal");
          },
        },
      );
    },
    [portalMutation, membershipsPath],
  );

  // ── Render ───────────────────────────────────────────────────────────

  const header = (
    <header className={styles.panelHeader}>
      <p className={styles.kicker} aria-hidden>
        {String(t("entityMemberships.kicker"))}
      </p>
      <h2 className={styles.heading}>
        {String(t("entityMemberships.title"))}
      </h2>
      <p className={styles.subheading}>
        {String(t("entityMemberships.subtitle", { name: entityName }))}
      </p>
    </header>
  );

  // Signed-in viewers wait for the member check before pitch/member fork so
  // the wrong state never flashes.
  if (signedIn && (mineQuery.isPending || sessionQuery.isPending)) {
    return (
      <section className={styles.panel} aria-label={String(t("entityMemberships.title"))}>
        {header}
        <p className={styles.centerNote} role="status">
          {String(t("common.loading"))}
        </p>
      </section>
    );
  }

  // ── Member view ──────────────────────────────────────────────────────
  if (myMembership) {
    return (
      <section className={styles.panel} aria-label={String(t("entityMemberships.title"))}>
        {header}
        <div className={styles.memberCard}>
          <span className={styles.memberBadge}>
            {String(t("entityMemberships.memberBadge"))}
          </span>
          <span className={styles.memberTierName}>
            {myMembership.tier.name}
          </span>
          <span className={styles.memberMeta}>
            {String(
              t(
                myMembership.cancelAtPeriodEnd
                  ? "entityMemberships.endsOn"
                  : "entityMemberships.renewsOn",
                { date: formatDateShort(myMembership.currentPeriodEnd) },
              ),
            )}
          </span>
          <div className={styles.memberActions}>
            <Link href="/account/memberships" className={styles.secondaryButton}>
                {String(t("entityMemberships.manageMembership"))}
              </Link>
          </div>
        </div>
        {memberBlocksQuery.isPending ? (
          <p className={styles.centerNote} role="status">
            {String(t("common.loading"))}
          </p>
        ) : memberBlocks.length > 0 ? (
          <BlockPageOwnerProvider owner={{ place: null }}>
            <div className={styles.memberBlocks}>
              {memberBlocks.map((block) => (
                <BlockRenderer key={block.id} block={block} />
              ))}
            </div>
          </BlockPageOwnerProvider>
        ) : (
          <p className={styles.centerNote}>
            {String(t("entityMemberships.memberContentEmpty", { name: entityName }))}
          </p>
        )}
      </section>
    );
  }

  // ── Payment step (subscription is `incomplete` until Elements confirms) ─
  if (paying) {
    return (
      <section
        className={styles.panel}
        aria-label={String(t("entityMemberships.title"))}
      >
        {header}
        <MembershipPaymentStep
          clientSecret={paying.clientSecret}
          tierName={paying.tierName}
          onSuccess={onPaymentSuccess}
          onCancel={onPaymentCancel}
        />
      </section>
    );
  }

  // ── Just-joined success (subscription may still be completing) ───────
  if (joined) {
    return (
      <section className={styles.panel} aria-label={String(t("entityMemberships.title"))}>
        {header}
        <div className={styles.memberCard} role="status">
          <span className={styles.memberBadge}>
            {String(t("entityMemberships.memberBadge"))}
          </span>
          <span className={styles.memberTierName}>{joined.tierName}</span>
          <span className={styles.memberMeta}>
            {String(
              t(
                joined.active
                  ? "entityMemberships.joinSuccessActive"
                  : joined.processing
                    ? "entityMemberships.joinSuccessProcessing"
                    : "entityMemberships.joinSuccessIncomplete",
              ),
            )}
          </span>
          <div className={styles.memberActions}>
            {!joined.active && !joined.processing && (
              <button
                type="button"
                className={styles.joinButton}
                onClick={() => openPortal(joined.membershipId)}
                disabled={portalMutation.isPending}
                aria-busy={portalMutation.isPending}
              >
                {String(t("entityMemberships.finishPayment"))}
              </button>
            )}
            <Link href="/account/memberships" className={styles.secondaryButton}>
                {String(t("entityMemberships.manageMembership"))}
              </Link>
          </div>
          {errorKey && (
            <p className={styles.errorText} role="alert">
              {String(t(errorKey))}
            </p>
          )}
        </div>
      </section>
    );
  }

  // ── Pitch (signed-out or non-member) ─────────────────────────────────
  return (
    <section className={styles.panel} aria-label={String(t("entityMemberships.title"))}>
      {header}
      <ul className={styles.tierGrid} role="list">
        {sortedTiers.map((tier) => {
          const isJoining = joiningTierId === tier.id;
          const priceLabel = String(
            t(
              tier.interval === "YEAR"
                ? "entityMemberships.perYear"
                : "entityMemberships.perMonth",
            ),
          );
          return (
            <MembershipTierCard
              key={tier.id}
              tier={tier}
              priceLabel={formatCurrency(tier.priceCents, tier.currency)}
              intervalLabel={priceLabel}
              taxNote={String(t("entityMemberships.taxNote"))}
              action={isJoining ? (
                <form
                  className={styles.joinForm}
                  onSubmit={(event) => {
                    event.preventDefault();
                    confirmJoin(tier);
                  }}
                >
                  <label
                    className={styles.fieldLabel}
                    htmlFor={`membership-zip-${tier.id}`}
                  >
                    {String(t("entityMemberships.postalLabel"))}
                  </label>
                  <input
                    id={`membership-zip-${tier.id}`}
                    className={styles.fieldInput}
                    type="text"
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={16}
                    value={postalCode}
                    onChange={(event) => setPostalCode(event.target.value)}
                    autoFocus
                  />
                  <span className={styles.fieldHint}>
                    {String(t("entityMemberships.usOnlyNote"))}
                  </span>
                  {errorKey && (
                    <p className={styles.errorText} role="alert">
                      {String(t(errorKey))}
                    </p>
                  )}
                  <div className={styles.formActions}>
                    <button
                      type="submit"
                      className={styles.joinButton}
                      disabled={startMutation.isPending}
                      aria-busy={startMutation.isPending}
                    >
                      {String(
                        t(
                          startMutation.isPending
                            ? "entityMemberships.joining"
                            : "entityMemberships.confirmJoin",
                        ),
                      )}
                    </button>
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      onClick={() => {
                        setJoiningTierId(null);
                        setErrorKey(null);
                      }}
                      disabled={startMutation.isPending}
                    >
                      {String(t("entityMemberships.cancelJoin"))}
                    </button>
                  </div>
                </form>
              ) : (
                <button
                  type="button"
                  className={styles.joinButton}
                  onClick={() => openJoinForm(tier.id)}
                  // Tier-qualified accessible name — several tiers each render
                  // a visually identical "Join" CTA.
                  aria-label={String(
                    t("entityMemberships.joinAria", { tier: tier.name }),
                  )}
                >
                  {String(t("entityMemberships.join"))}
                </button>
              )}
            />
          );
        })}
      </ul>
    </section>
  );
}

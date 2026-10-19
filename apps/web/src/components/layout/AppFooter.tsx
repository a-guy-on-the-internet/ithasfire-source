"use client";

import { memo, useCallback } from "react";
import { Link, Text, useTranslations } from "@th/ui";
import { YStack, styled } from "tamagui";

import { useConsentContext } from "@/components/gdpr/ConsentProvider";
import { SHELL_MAX_WIDTH } from "@/components/layout/shell-metrics";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import { usePublicLinks } from "@/i18n/use-public-links";
import { hasOptionalStorage } from "@/lib/consent-scope";
import { BuildInfo } from "./BuildInfo";

/**
 * The site footer — the DS v3 `FooterNav`
 * (`components/navigation/FooterNav.jsx` plus the `.if-footer*` rules in
 * `components/navigation/navigation.css` in the design-system folder).
 *
 * Everything visual lives in the `.th-footer*` block at the end of
 * `apps/web/src/app/globals.css`, which carries the full rationale: why the
 * layout is media queries rather than `useIsMobile()`, why the column heads sit
 * on the mono ladder's `sm` rung instead of the folder's `2xs`, why accent ink
 * is `$accentText` and never `$accent`, and why link colour has to be painted
 * on an inner span rather than the anchor. Read that comment before changing
 * anything here.
 *
 * This file keeps only semantic markup, the i18n copy, and the two genuinely
 * dynamic values (the year and the consent gate).
 */

// ── Styled containers ────────────────────────────────────────────────────────

const FooterOuter = styled(YStack, {
  name: "AppFooter",
  tag: "footer",
  width: "100%",
  // Swiss structural rule: the thick top border capping the page. AppShell
  // deliberately draws no border of its own above this — see the note there.
  borderTopWidth: 2,
  borderTopColor: "$borderColor",
  // Above AppShell's fixed `swiss-grid-pattern` layer, which sits at z-index 0.
  // (The `overflow: hidden` that used to sit here contained a dot-matrix
  // pseudo-element that no longer exists; it only stood to clip a focus ring.)
  position: "relative",
  zIndex: 1,
});

const FooterInner = styled(YStack, {
  name: "AppFooterInner",
  width: "100%",
  maxWidth: SHELL_MAX_WIDTH,
  alignSelf: "center",
  // 32px between the column grid and the base row.
  gap: "$6",
});

// ── Subcomponents ────────────────────────────────────────────────────────────

interface FooterLinkItem {
  href: string;
  label: string;
}

/**
 * One link column.
 *
 * A labelled `<nav>` rather than a heading plus a list, deliberately. The
 * footer is global chrome: it renders under every route and cannot know how
 * deep that route's heading tree runs — emitting three `<h2>`s at the end of
 * every page would corrupt every outline in the product, and a level that is
 * right on the home page is wrong inside the event builder. A navigation
 * landmark is level-free, gives screen-reader users the same "jump to this
 * group" affordance through the landmark list, and names itself from the same
 * string the sighted reader sees.
 */
const FooterColumn = ({
  head,
  links,
}: {
  head: string;
  links: readonly FooterLinkItem[];
}) => (
  <nav className="th-footer-colgroup" aria-label={head}>
    {/* `variant="overline"` IS the mono `sm` rung — 11px / 2px / 600 /
        uppercase — so the size and its paired tracking cannot travel apart.
        `$accentText` (#A8300F, 5.98:1 on cream), never `$accent`: #E2481D as
        small text fails AA in both polarities. */}
    <Text variant="overline" color="$accentText">
      {head}
    </Text>
    <div className="th-footer-col">
      {links.map((link) => (
        // The inner span carries the ink: `NextLinkAnchor` writes
        // `color: inherit` as INLINE style, which beats any class, so a
        // `:hover` colour on the anchor itself would never render.
        <Link key={link.href} href={link.href}>
          <span className="th-footer-link">{link.label}</span>
        </Link>
      ))}
    </div>
  </nav>
);

/** A base-row link. Same inner-span reason as `FooterColumn`. */
const BaseLink = ({ href, label }: FooterLinkItem) => (
  <Link href={href}>
    <span className="th-footer-base-link">{label}</span>
  </Link>
);

// ── Component ────────────────────────────────────────────────────────────────

export const AppFooter = memo(function AppFooter() {
  const t = useTranslations();
  const { resetConsent } = useConsentContext();
  // About and Contact have Spanish twins: an /es page links to them
  // (spanish-seo FR-006). Every other footer link has one URL.
  const links = usePublicLinks();

  const handleManageCookies = useCallback(() => {
    resetConsent();
    window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  }, [resetConsent]);

  const showManageCookies = hasOptionalStorage();
  const currentYear = new Date().getFullYear();
  const appTitle = String(t("common.appTitle"));

  // The whole /sell Seller Hub `notFound()`s while the `resale` gate is off, so
  // the footer must hide the entry exactly as AppNavbar does — an ungated link
  // here is a 404 sitting in global chrome on every page. Fail closed: gates
  // arrive SSR-seeded via context, but `undefined` while they load must not
  // flash a link that resolves to nothing.
  const { gates } = useFeatureGates();
  const resaleEnabled = gates?.resale === true;

  const organiserLinks: FooterLinkItem[] = [
    { href: "/admin", label: String(t("common.footerDashboard")) },
    // Literal, not i18n: there is no message key for this label.
    // `common.navSell` exists but lives in the `admin` namespace and names the
    // POS "Sell" screen, not this route. Left for the owner of the locale
    // files to add.
    ...(resaleEnabled ? [{ href: "/sell", label: "Seller Hub" }] : []),
  ];

  return (
    <FooterOuter>
      <FooterInner className="th-shell-band th-footer">
        <div className="th-footer-cols">
          {/* ── Brand block ─────────────────────────────────────────── */}
          <div className="th-footer-brand">
            {/* Global chrome renders on every page, so a fixed ordinal ("05 ·
                Close", as the DS example has it) lies the moment a page's own
                numbered sections reach that number. The unnumbered em-dash
                kicker keeps the mark without claiming a position. */}
            <Text variant="kicker" tone="muted">
              {`— ${String(t("common.footerConnect"))}`}
            </Text>
            <span className="th-footer-wordmark">{appTitle}</span>
            <span className="th-footer-tagline">
              {String(t("common.footerTagline"))}
            </span>
          </div>

          {/* ── Link columns ────────────────────────────────────────── */}
          <FooterColumn
            head={String(t("common.footerPlatform"))}
            links={[
              {
                href: "/events",
                label: String(t("common.footerBrowseEvents")),
              },
              {
                href: "/events/search",
                label: String(t("common.footerSearch")),
              },
              // Left the homepage hero's chip row (owner ruling 2026-10-14:
              // the chips offer only categories with something listed).
              {
                href: "/house-shows",
                label: String(t("common.footerHouseShows")),
              },
              { href: "/features", label: String(t("common.footerFeatures")) },
              // Was a hardcoded "Help Centre" while `common.footerHelpCentre`
              // sat right there — the Spanish footer shipped an English label.
              { href: "/help", label: String(t("common.footerHelpCentre")) },
            ]}
          />

          <FooterColumn
            head={String(t("common.footerCompany"))}
            links={[
              {
                href: links.path({ kind: "about" }),
                label: String(t("common.footerAbout")),
              },
              {
                href: links.path({ kind: "contact" }),
                label: String(t("common.footerContact")),
              },
              // `/support` is a real route. This pointed at `/contact`, so two
              // links in the same column resolved to the same destination.
              { href: "/support", label: String(t("common.footerSupport")) },
            ]}
          />

          {/* Last, deliberately. It is the shortest column — one link while the
              `resale` gate is off — and at the 900px breakpoint the grid drops
              to two tracks, so a short column in the MIDDLE leaves a hole in
              row 1 and strands Company alone in row 2. Shortest-last keeps the
              ragged edge at the end of the reading order, where it reads as
              the list finishing rather than as a gap. */}
          <FooterColumn
            head={String(t("common.footerForOrganisers"))}
            links={organiserLinks}
          />
        </div>

        {/* ── Base row ──────────────────────────────────────────────────
            Legal moved here from a fourth column: four link columns beside a
            2fr brand block left every column one or two items deep, and the
            legal set is the one group a reader looks for at the very bottom of
            the page rather than inside a named nav group. */}
        <div className="th-footer-base">
          <span>
            &copy; {currentYear}{" "}
            {String(t("common.footerCopyright", { appTitle }))}
          </span>

          <BaseLink href="/privacy" label={String(t("common.privacyPolicy"))} />
          <BaseLink
            href="/cookie-policy"
            label={String(t("common.cookiePolicy"))}
          />
          <BaseLink href="/terms" label={String(t("common.footerTerms"))} />
          <BaseLink
            href="/acceptable-use"
            label={String(t("common.footerAcceptableUse"))}
          />

          <BuildInfo />

          {/* Hidden when nothing optional is wired — resetting consent would
              re-show a banner that has nothing to ask, so the control would be
              a no-op. See `hasOptionalStorage`.

              A real <button>, not the `<span role="button" tabIndex={0}>` this
              replaced: that shape needed its own Enter/Space keydown handler,
              and it got no focus ring because the `:where(a, button, …)` floor
              in globals.css does not match a span. */}
          {showManageCookies ? (
            <button
              type="button"
              className="th-footer-base-btn"
              onClick={handleManageCookies}
            >
              {String(t("common.manageCookies"))}
            </button>
          ) : null}
        </div>
      </FooterInner>
    </FooterOuter>
  );
});

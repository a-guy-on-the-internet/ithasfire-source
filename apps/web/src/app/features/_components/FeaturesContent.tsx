"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  CircleDollarSign,
  Timer,
  Armchair,
  Wallet,
  ListChecks,
  Send,
  Gift,
  Receipt,
  RefreshCw,
  ArrowLeftRight,
  ShieldCheck,
  Shield,
  Layers,
  Repeat,
  Lock,
  ClipboardList,
  PieChart,
  Tags,
  BellRing,
  FileSignature,
  CalendarPlus,
  Banknote,
  UserRound,
  Link2,
  Code2,
  Building2,
  BadgeCheck,
  Scale,
  CalendarDays,
  LayoutPanelLeft,
  UserPlus,
  CreditCard,
  Clock,
  Undo2,
  ShieldAlert,
  Smartphone,
  Settings2,
  Star,
  Award,
  ThumbsUp,
  Search,
  Compass,
  Map as MapIcon,
  Flame,
  Shuffle,
  Globe,
  Megaphone,
  CalendarCheck,
  PencilLine,
  UserCog,
  Hand,
  UsersRound,
  Trophy,
  Radio,
  ScanLine,
  LayoutDashboard,
  TicketPercent,
  Download,
  Fingerprint,
  KeyRound,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "@th/ui";
import { ACCENT, STRUCTURAL } from "@/lib/design-tokens";
import { useFeatureGates } from "@/hooks/useFeatureGates";
import type { FeatureGatesSnapshot } from "@/lib/feature-gates/types";

import {
  PageContainer,
  AutoGrid,
  Card,
  IconCircle,
  MutedText,
  ButtonRow,
  ButtonPrimary,
  ButtonOutline,
  CardBody,
  NumberedSection,
  AsymmetricGrid,
  DisplayHeading,
  Overline,
  Stripe,
} from "@/components/layout/PagePrimitives";

/* ── Scroll-reveal animation ───────────────────────────────────────────── */

const REVEAL_STYLE = `
@keyframes th-reveal-up {
  from { opacity: 0; transform: translateY(32px); }
  to   { opacity: 1; transform: translateY(0); }
}
`;

/** Respect the user's reduced-motion preference. */
function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

function RevealSection({
  children,
  delay = 0,
  style,
}: {
  children: ReactNode;
  delay?: number;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reducedMotion = usePrefersReducedMotion();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // With reduced motion we never hide content — render it statically.
    if (reducedMotion) {
      setVisible(true);
      return;
    }
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [reducedMotion]);

  return (
    <div
      ref={ref}
      style={{
        opacity: reducedMotion ? 1 : visible ? 1 : 0,
        animation:
          !reducedMotion && visible
            ? `th-reveal-up 0.6s cubic-bezier(0.16,1,0.3,1) ${delay}ms both`
            : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ── Data ──────────────────────────────────────────────────────────────── */

// Translucent icon-tile fills derived from the brand palette (matches
// AboutContent / SupportContent).
const ACCENT_BG = "rgba(226,72,29,0.1)";
const STRUCTURAL_BG = "rgba(33,28,22,0.1)";

interface FeatureItem {
  icon: LucideIcon;
  /** i18n leaf key within the category namespace ("multiTier" → title/desc). */
  key: string;
  /**
   * Hide this entry unless the platform feature gate is explicitly ON.
   * FAIL-CLOSED while gates load,
   * so a dark feature is never advertised on the public showcase.
   */
  requiredFeatureGate?: keyof FeatureGatesSnapshot;
  /**
   * Swap the description for `descKeyWhenOff` (a leaf in the same namespace)
   * unless `gate` is explicitly ON — for an entry that stays true without the
   * gated part, e.g. messaging without SMS. Fail-closed while gates load.
   */
  descWhenGateOff?: {
    gate: keyof FeatureGatesSnapshot;
    descKeyWhenOff: string;
  };
}

interface FeatureCategory {
  /** i18n namespace under `featuresPage` (e.g. "ticketing"). */
  ns: string;
  /** Hide the whole category unless the gate is explicitly ON (fail-closed). */
  requiredFeatureGate?: keyof FeatureGatesSnapshot;
  items: readonly FeatureItem[];
}

const CATEGORIES: readonly FeatureCategory[] = [
  {
    ns: "ticketing",
    items: [
      { icon: Layers, key: "multiTier" },
      { icon: CircleDollarSign, key: "freePaid" },
      { icon: Timer, key: "holds" },
      // `seatingLayouts` defaults to FALSE with no env override — it can only
      // be switched on by a `PlatformSetting` row, so seating is dark for every
      // org today. Advertising it unconditionally was a false claim.
      { icon: Armchair, key: "seating", requiredFeatureGate: "seatingLayouts" },
      { icon: Wallet, key: "wallet" },
      { icon: ListChecks, key: "waitlist", requiredFeatureGate: "waitlists" },
      { icon: Send, key: "transfers" },
      { icon: Gift, key: "comps" },
      { icon: Receipt, key: "tax" },
    ],
  },
  {
    ns: "resale",
    requiredFeatureGate: "resale",
    items: [
      { icon: RefreshCw, key: "listings" },
      { icon: ArrowLeftRight, key: "flow" },
      { icon: Settings2, key: "policy" },
      { icon: ShieldAlert, key: "antiScalper" },
    ],
  },
  {
    ns: "events",
    items: [
      { icon: Layers, key: "lifecycle" },
      { icon: Repeat, key: "recurring" },
      { icon: Lock, key: "gated" },
      { icon: ClipboardList, key: "lineups" },
      { icon: PieChart, key: "splits" },
      { icon: Tags, key: "categories" },
      { icon: BellRing, key: "changeNotifs" },
    ],
  },
  {
    ns: "booking",
    items: [
      { icon: Send, key: "requests" },
      { icon: FileSignature, key: "agreements" },
      { icon: CalendarPlus, key: "toEvent" },
      { icon: Banknote, key: "payoutTerms" },
      { icon: UserRound, key: "performer" },
      { icon: Link2, key: "lineupLinks" },
      { icon: Code2, key: "embed" },
    ],
  },
  {
    ns: "venues",
    items: [
      { icon: Building2, key: "directory" },
      { icon: BadgeCheck, key: "claim" },
      { icon: Scale, key: "dispute" },
      { icon: CalendarDays, key: "availability" },
      { icon: LayoutPanelLeft, key: "miniSite" },
      { icon: UserPlus, key: "follow" },
    ],
  },
  {
    ns: "payments",
    items: [
      { icon: CreditCard, key: "onboarding" },
      { icon: Banknote, key: "settlements" },
      { icon: Clock, key: "scheduled" },
      { icon: Undo2, key: "refunds" },
      { icon: ShieldAlert, key: "disputes" },
      { icon: Smartphone, key: "pos" },
      { icon: Wallet, key: "credits" },
    ],
  },
  {
    ns: "reviews",
    items: [
      { icon: Star, key: "venueReviews" },
      { icon: ThumbsUp, key: "eventReviews" },
      { icon: Award, key: "trustProfiles" },
      { icon: BellRing, key: "feedbackPrompts" },
    ],
  },
  {
    ns: "discovery",
    items: [
      { icon: Search, key: "unifiedSearch" },
      { icon: Compass, key: "discover" },
      { icon: MapIcon, key: "map" },
      { icon: Flame, key: "featured" },
      { icon: Shuffle, key: "surprise" },
      { icon: Globe, key: "seo" },
    ],
  },
  {
    ns: "community",
    items: [
      { icon: Megaphone, key: "listings" },
      { icon: CalendarCheck, key: "rsvps" },
      { icon: PencilLine, key: "suggestions" },
      { icon: UserCog, key: "moderators" },
    ],
  },
  {
    ns: "volunteer",
    items: [
      { icon: Hand, key: "asks" },
      { icon: UsersRound, key: "signups" },
      { icon: Trophy, key: "hours" },
      { icon: FileSignature, key: "waivers" },
      // Volunteer ROSTER broadcasts (shipped, ungated) — distinct from the
      // org-CRM `broadcasts` feature gate, which does not cover this.
      { icon: Radio, key: "broadcasts" },
      { icon: CalendarDays, key: "ics" },
      { icon: ScanLine, key: "checkin" },
    ],
  },
  {
    ns: "scanning",
    items: [
      { icon: ScanLine, key: "fastScan" },
      { icon: ClipboardList, key: "manifests" },
      { icon: KeyRound, key: "passkey" },
      { icon: Smartphone, key: "scannerApp" },
    ],
  },
  {
    ns: "orgtools",
    items: [
      {
        icon: BellRing,
        key: "channels",
        descWhenGateOff: { gate: "sms", descKeyWhenOff: "channelsDescNoSms" },
      },
      {
        icon: Megaphone,
        key: "announcements",
        requiredFeatureGate: "broadcasts",
      },
      { icon: LayoutDashboard, key: "dashboards" },
      { icon: TicketPercent, key: "promo" },
      { icon: Code2, key: "widgets" },
      { icon: Download, key: "exports" },
      { icon: UsersRound, key: "team" },
    ],
  },
  {
    ns: "account",
    items: [
      { icon: Fingerprint, key: "passkey" },
      { icon: ShieldCheck, key: "twoFactor" },
      { icon: UserPlus, key: "delegates" },
      { icon: Shield, key: "consent" },
      { icon: Trash2, key: "deletion" },
    ],
  },
];

// Insert a decorative stripe break after these zero-based category indices to
// give the long page some breathing rhythm (mirrors AboutContent's Stripe use).
const STRIPE_AFTER = new Set([3, 7]);

/* ── Component ─────────────────────────────────────────────────────────── */

export const FeaturesContent = () => {
  const t = useTranslations();
  const { gates } = useFeatureGates();

  // Gate-aware view of the catalogue: entries/categories tagged with
  // `requiredFeatureGate` only render when the gate is explicitly ON
  // (`=== true` — fail-closed while gates load), and a
  // category whose entries are all gated off disappears entirely.
  const visibleCategories = useMemo(() => {
    const gateOn = (gate: keyof FeatureGatesSnapshot | undefined) =>
      gate === undefined || gates?.[gate] === true;
    return CATEGORIES.filter((category) => gateOn(category.requiredFeatureGate))
      .map((category) => ({
        ...category,
        items: category.items.filter((item) =>
          gateOn(item.requiredFeatureGate),
        ),
      }))
      .filter((category) => category.items.length > 0);
  }, [gates]);

  const ctaN = visibleCategories.length + 1;

  return (
    <PageContainer>
      <style>{REVEAL_STYLE}</style>

      {/* Hero — oversized display heading */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 24,
          paddingBottom: 40,
          borderBottom: "2px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
        }}
      >
        <Overline>{String(t("featuresPage.overline"))}</Overline>
        <DisplayHeading size="xl">
          {String(t("featuresPage.heroTitle"))}
        </DisplayHeading>
        <p
          style={{
            maxWidth: 672,
            fontSize: 18,
            lineHeight: 1.6,
            color: "var(--colorMuted, #5C544A)",
            textWrap: "balance",
          }}
        >
          {String(t("featuresPage.heroDescription"))}
        </p>
      </section>

      {/* Category sections */}
      {visibleCategories.map((category, index) => {
        const accent = index % 2 === 0;
        const iconColor = accent ? ACCENT : STRUCTURAL;
        const iconBg = accent ? ACCENT_BG : STRUCTURAL_BG;

        return (
          <div key={category.ns}>
            <RevealSection delay={index === 0 ? 0 : 80}>
              <NumberedSection
                n={index + 1}
                title={String(t(`featuresPage.${category.ns}.title`))}
                accent={accent}
              >
                <MutedText size={16} maxWidth={560}>
                  {String(t(`featuresPage.${category.ns}.lead`))}
                </MutedText>
                <AutoGrid>
                  {category.items.map(({ icon, key, descWhenGateOff }) => (
                    <Card key={key}>
                      <IconCircle icon={icon} color={iconColor} bg={iconBg} />
                      <CardBody
                        title={String(
                          t(`featuresPage.${category.ns}.${key}Title`),
                        )}
                        description={String(
                          t(
                            descWhenGateOff &&
                              gates?.[descWhenGateOff.gate] !== true
                              ? `featuresPage.${category.ns}.${descWhenGateOff.descKeyWhenOff}`
                              : `featuresPage.${category.ns}.${key}Desc`,
                          ),
                        )}
                      />
                    </Card>
                  ))}
                </AutoGrid>
              </NumberedSection>
            </RevealSection>
            {STRIPE_AFTER.has(index) && <Stripe />}
          </div>
        );
      })}

      {/* Final CTA */}
      <RevealSection delay={80}>
        <div
          className="swiss-diagonal"
          style={{ position: "relative", overflow: "hidden" }}
        >
          <NumberedSection
            n={ctaN}
            title={String(t("featuresPage.ctaTitle"))}
            accent
          >
            <AsymmetricGrid>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 16 }}
              >
                <MutedText size={16} maxWidth={448} balance>
                  {String(t("featuresPage.ctaDescription"))}
                </MutedText>
                <ButtonRow>
                  <ButtonPrimary href="/sign-up">
                    {String(t("featuresPage.ctaGetStarted"))}
                  </ButtonPrimary>
                  <ButtonOutline href="/events">
                    {String(t("featuresPage.ctaBrowseEvents"))}
                  </ButtonOutline>
                </ButtonRow>
              </div>
              <div
                aria-hidden
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "flex-end",
                }}
              >
                <span className="swiss-hanging-num">
                  {String(ctaN).padStart(2, "0")}
                </span>
              </div>
            </AsymmetricGrid>
          </NumberedSection>
        </div>
      </RevealSection>
    </PageContainer>
  );
};

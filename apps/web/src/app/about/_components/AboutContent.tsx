"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  Ticket,
  Shield,
  Zap,
  Heart,
  Users,
  Calendar,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "@th/ui";
import { ACCENT, STRUCTURAL } from "@/lib/design-tokens";
import { usePublicLinks } from "@/i18n/use-public-links";

import { trpc } from "@/trpc";
import {
  PageContainer,
  AutoGrid,
  Card,
  IconCircle,
  MutedText,
  ButtonRow,
  ButtonPrimary,
  ButtonOutline,
  BodyText,
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
  const [visible, setVisible] = useState(false);

  useEffect(() => {
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
  }, []);

  return (
    <div
      ref={ref}
      style={{
        opacity: visible ? 1 : 0,
        animation: visible
          ? `th-reveal-up 0.6s cubic-bezier(0.16,1,0.3,1) ${delay}ms both`
          : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ── Animated counter ──────────────────────────────────────────────────── */

function AnimatedStat({ end, label }: { end: string; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [display, setDisplay] = useState("0");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          // Parse the numeric portion and suffix (e.g. "12K+" → 12, "K+")
          const match = end.match(/^([\d,]+)(.*)/);
          if (!match) {
            setDisplay(end);
            observer.disconnect();
            return;
          }
          const target = parseInt(match[1].replace(/,/g, ""), 10);
          const suffix = match[2];
          const duration = 1200;
          const start = performance.now();

          const tick = (now: number) => {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            // ease-out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            const current = Math.round(target * eased);
            setDisplay(`${current.toLocaleString()}${suffix}`);
            if (progress < 1) requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
          observer.disconnect();
        }
      },
      { threshold: 0.3 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [end]);

  return (
    <div ref={ref} style={{ textAlign: "center" }}>
      <p
        style={{
          fontSize: 40,
          fontWeight: 700,
          color: "var(--foreground)",
          lineHeight: 1.1,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {display}
      </p>
      <p
        style={{
          fontSize: 14,
          color: "var(--colorMuted, #5C544A)",
          marginTop: 4,
        }}
      >
        {label}
      </p>
    </div>
  );
}

/* ── Data ──────────────────────────────────────────────────────────────── */

// Translucent icon-tile fills derived from the brand palette (see
// SupportContent for the same pair).
const ACCENT_BG = "rgba(226,72,29,0.1)";
const STRUCTURAL_BG = "rgba(33,28,22,0.1)";

const VALUES: readonly {
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
  accent: string;
  accentBg: string;
}[] = [
  {
    icon: Ticket,
    titleKey: "aboutPage.valueFairPricingTitle",
    descriptionKey: "aboutPage.valueFairPricingDescription",
    accent: ACCENT,
    accentBg: ACCENT_BG,
  },
  {
    icon: Zap,
    titleKey: "aboutPage.valueInstantPayoutsTitle",
    descriptionKey: "aboutPage.valueInstantPayoutsDescription",
    accent: STRUCTURAL,
    accentBg: STRUCTURAL_BG,
  },
  {
    icon: Shield,
    titleKey: "aboutPage.valueResaleProtectionTitle",
    descriptionKey: "aboutPage.valueResaleProtectionDescription",
    accent: ACCENT,
    accentBg: ACCENT_BG,
  },
  {
    icon: Heart,
    titleKey: "aboutPage.valuePrivacyFirstTitle",
    descriptionKey: "aboutPage.valuePrivacyFirstDescription",
    accent: STRUCTURAL,
    accentBg: STRUCTURAL_BG,
  },
];

const STAT_CONFIG: readonly {
  key: "totalEvents" | "totalTicketsSold" | "totalOrganizations";
  labelKey: string;
  icon: LucideIcon;
}[] = [
  {
    key: "totalEvents",
    labelKey: "aboutPage.statsEventsCreated",
    icon: Calendar,
  },
  {
    key: "totalTicketsSold",
    labelKey: "aboutPage.statsTicketsSold",
    icon: Ticket,
  },
  {
    key: "totalOrganizations",
    labelKey: "aboutPage.statsOrganisers",
    icon: Users,
  },
];

/* ── Styles ────────────────────────────────────────────────────────────── */

/* ── Component ─────────────────────────────────────────────────────────── */

export const AboutContent = () => {
  const t = useTranslations();
  // `/es/contacto` from the Spanish twin (spanish-seo FR-006).
  const contactPath = usePublicLinks().path({ kind: "contact" });
  const { data: stats } = trpc.platform.getPublicStats.useQuery(undefined, {
    staleTime: 5 * 60_000, // cache 5 min
  });

  // Only show stats that have a meaningful value (> 0)
  const visibleStats = stats
    ? STAT_CONFIG.filter(({ key }) => (stats[key] ?? 0) > 0)
    : [];
  const hasStats = visibleStats.length > 0;

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
        <Overline>{String(t("aboutPage.missionHeading"))}</Overline>
        <DisplayHeading size="xl">
          {String(t("aboutPage.heroTitle"))}
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
          {String(t("aboutPage.heroDescription"))}
        </p>
      </section>

      {/* 01 — Mission (asymmetric: wide text / narrow number) */}
      <RevealSection>
        <NumberedSection
          n={1}
          title={String(t("aboutPage.missionHeading"))}
          accent
        >
          <AsymmetricGrid>
            <div>
              <BodyText size={20}>
                {String(t("aboutPage.missionBody"))}
              </BodyText>
            </div>
            <div
              aria-hidden
              style={{
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "flex-end",
              }}
            >
              <span className="swiss-hanging-num">01</span>
            </div>
          </AsymmetricGrid>
        </NumberedSection>
      </RevealSection>

      {/* Stripe accent break */}
      <Stripe />

      {/* Stats — only rendered when we have real data */}
      {hasStats && (
        <RevealSection delay={100}>
          <div
            className="swiss-dots"
            style={{
              display: "grid",
              gridTemplateColumns: `repeat(${visibleStats.length}, 1fr)`,
              gap: 32,
              padding: "40px 0",
              borderTop: "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
              borderBottom:
                "1px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {visibleStats.map(({ key, labelKey }) => (
              <AnimatedStat
                key={key}
                end={String(stats![key].toLocaleString())}
                label={String(t(labelKey))}
              />
            ))}
          </div>
        </RevealSection>
      )}

      {/* 02 — Values grid */}
      <RevealSection delay={150}>
        <NumberedSection n={2} title={String(t("aboutPage.valuesHeading"))}>
          <AutoGrid>
            {VALUES.map(
              ({ icon, titleKey, descriptionKey, accent, accentBg }) => (
                <Card key={titleKey} center>
                  <IconCircle icon={icon} color={accent} bg={accentBg} />
                  <CardBody
                    title={String(t(titleKey))}
                    description={String(t(descriptionKey))}
                  />
                </Card>
              ),
            )}
          </AutoGrid>
        </NumberedSection>
      </RevealSection>

      {/* 03 — CTA */}
      <RevealSection delay={200}>
        <div
          className="swiss-diagonal"
          style={{ position: "relative", overflow: "hidden" }}
        >
          <NumberedSection n={3} title={String(t("aboutPage.ctaTitle"))} accent>
            <AsymmetricGrid>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 16 }}
              >
                <MutedText size={16} maxWidth={448} balance>
                  {String(t("aboutPage.ctaDescription"))}
                </MutedText>
                <ButtonRow>
                  <ButtonPrimary href="/events">
                    {String(t("aboutPage.ctaBrowseEvents"))}
                  </ButtonPrimary>
                  <ButtonOutline href={contactPath}>
                    {String(t("aboutPage.ctaGetInTouch"))}
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
                <span className="swiss-hanging-num">03</span>
              </div>
            </AsymmetricGrid>
          </NumberedSection>
        </div>
      </RevealSection>

      {/* Responsive overrides */}
      {hasStats && (
        <style>{`
          @media (max-width: 640px) {
            div[style*="repeat(${visibleStats.length}, 1fr)"] {
              grid-template-columns: repeat(2, 1fr) !important;
            }
          }
        `}</style>
      )}
    </PageContainer>
  );
};

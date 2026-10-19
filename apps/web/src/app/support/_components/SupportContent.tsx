"use client";

import type { CSSProperties } from "react";
import {
  Rocket,
  Ticket,
  Wrench,
  Search,
  Mail,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "@th/ui";

import {
  PageContainer,
  HeroSection,
  NumberedSection,
  SurfaceCard,
  IconCircle,
  CardBody,
  MutedText,
  BodyText,
  ButtonPrimary,
  ButtonOutline,
  ButtonRow,
  TextLink,
  Overline,
} from "@/components/layout/PagePrimitives";
import { ActionCard } from "@/app/help/_components/ActionCard";
import { ACCENT, STRUCTURAL } from "@/lib/design-tokens";

/* ── Local style helpers ───────────────────────────────────────────────── */

const ACCENT_BG = "rgba(226,72,29,0.1)";
const STRUCTURAL_BG = "rgba(33,28,22,0.1)";

const cardGrid: CSSProperties = {
  display: "grid",
  gap: 16,
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
};

type Step = {
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
};

const ORGANISER_STEPS: readonly Step[] = [
  {
    icon: Search,
    titleKey: "supportPage.organiserStepFindTitle",
    descriptionKey: "supportPage.organiserStepFindDescription",
  },
  {
    icon: Mail,
    titleKey: "supportPage.organiserStepContactTitle",
    descriptionKey: "supportPage.organiserStepContactDescription",
  },
];

/* ── Component ─────────────────────────────────────────────────────────── */

export function SupportContent({ supportEmail }: { supportEmail: string }) {
  const t = useTranslations();

  return (
    <PageContainer>
      <HeroSection
        badge={String(t("supportPage.overline"))}
        title={String(t("supportPage.heroTitle"))}
        description={String(t("supportPage.heroDescription"))}
      />

      {/* 01 — Help Centre (self-serve first) */}
      <NumberedSection n={1} title={String(t("supportPage.helpSectionTitle"))}>
        <MutedText size={16} maxWidth={620}>
          {String(t("supportPage.helpSectionLead"))}
        </MutedText>
        <ButtonRow>
          <ButtonPrimary href="/help">
            {String(t("supportPage.helpBrowseCta"))}
          </ButtonPrimary>
        </ButtonRow>
        <div style={cardGrid}>
          <ActionCard
            icon={Rocket}
            title={String(t("supportPage.helpCategoryGettingStartedTitle"))}
            description={String(
              t("supportPage.helpCategoryGettingStartedDescription"),
            )}
            href="/help/getting-started"
          />
          <ActionCard
            icon={Ticket}
            title={String(t("supportPage.helpCategoryBuyingTitle"))}
            description={String(t("supportPage.helpCategoryBuyingDescription"))}
            href="/help/buying-tickets"
          />
          <ActionCard
            icon={Wrench}
            title={String(t("supportPage.helpCategoryTroubleshootingTitle"))}
            description={String(
              t("supportPage.helpCategoryTroubleshootingDescription"),
            )}
            href="/help/troubleshooting"
          />
        </div>
      </NumberedSection>

      {/* 02 — Event & order questions → the organiser */}
      <NumberedSection
        n={2}
        title={String(t("supportPage.organiserSectionTitle"))}
      >
        <MutedText size={16} maxWidth={620}>
          {String(t("supportPage.organiserSectionLead"))}
        </MutedText>
        <div style={cardGrid}>
          {ORGANISER_STEPS.map((step) => (
            <div
              key={step.titleKey}
              style={{ display: "flex", flexDirection: "column", gap: 16 }}
            >
              <IconCircle
                icon={step.icon}
                color={STRUCTURAL}
                bg={STRUCTURAL_BG}
              />
              <CardBody
                title={String(t(step.titleKey))}
                description={String(t(step.descriptionKey))}
              />
            </div>
          ))}
        </div>
        <ButtonRow>
          <ButtonOutline href="/my-tickets">
            {String(t("supportPage.organiserViewTicketsCta"))}
          </ButtonOutline>
        </ButtonRow>
      </NumberedSection>

      {/* 03 — Refunds */}
      <NumberedSection
        n={3}
        title={String(t("supportPage.refundsSectionTitle"))}
      >
        <MutedText size={16} maxWidth={620}>
          {String(t("supportPage.refundsSectionLead"))}
        </MutedText>
        <SurfaceCard gap={12} padding="28px 24px">
          <Overline>{String(t("supportPage.refundsPolicyLabel"))}</Overline>
          <BodyText size={14}>
            {String(t("supportPage.refundsPolicyText"))}
          </BodyText>
        </SurfaceCard>
        <ButtonRow>
          <ButtonOutline href="/my-tickets">
            {String(t("supportPage.refundsRequestCta"))}
          </ButtonOutline>
        </ButtonRow>
      </NumberedSection>

      {/* 04 — Account & payment → contact the platform */}
      <NumberedSection
        n={4}
        accent
        title={String(t("supportPage.platformSectionTitle"))}
      >
        <MutedText size={16} maxWidth={620}>
          {String(t("supportPage.platformSectionLead"))}
        </MutedText>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <IconCircle icon={Mail} color={ACCENT} bg={ACCENT_BG} />
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <Overline>{String(t("supportPage.platformEmailLabel"))}</Overline>
              <TextLink
                href={`mailto:${encodeURIComponent(supportEmail)}`}
                size={16}
              >
                {supportEmail}
              </TextLink>
            </div>
          </div>
          <MutedText size={14} maxWidth={620}>
            {String(t("supportPage.platformContactFormDescription"))}
          </MutedText>
          <ButtonRow>
            <ButtonOutline href="/contact">
              <MessageCircle size={16} style={{ marginRight: 8 }} aria-hidden />
              {String(t("supportPage.platformContactFormCta"))}
            </ButtonOutline>
          </ButtonRow>
        </div>
      </NumberedSection>
    </PageContainer>
  );
}

SupportContent.displayName = "SupportContent";

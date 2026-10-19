"use client";

import {
  useState,
  useCallback,
  type FormEvent,
  type CSSProperties,
} from "react";
import {
  MessageCircle,
  Phone,
  Send,
  CheckCircle2,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "@th/ui";

import {
  contactFormSchema,
  validateForm,
  type FieldErrors,
} from "@/lib/validation";
import {
  PageContainer,
  IconCircle,
  SurfaceCard,
  MutedText,
  ButtonRow,
  ButtonPrimary,
  ButtonOutline,
  FormField,
  SubmitButton,
  inputStyle,
  ContentSection,
  CardTitle,
  TextLink,
  GhostButton,
  NumberedSection,
  AsymmetricGrid,
  DisplayHeading,
  Overline,
} from "@/components/layout/PagePrimitives";
import { usePublicLinks } from "@/i18n/use-public-links";
import { ACCENT, STRUCTURAL } from "@/lib/design-tokens";
import { FALLBACK_SUPPORT_EMAIL } from "@/lib/support-email";

/* ── Channel data ──────────────────────────────────────────────────────── */

const CHANNELS: readonly {
  icon: LucideIcon;
  titleKey: string;
  descriptionKey: string;
  link: string;
  linkLabel: string;
  accent: string;
  accentBg: string;
}[] = [
  {
    icon: MessageCircle,
    titleKey: "contactPage.channelGeneralTitle",
    descriptionKey: "contactPage.channelGeneralDescription",
    link: `mailto:${FALLBACK_SUPPORT_EMAIL}`,
    linkLabel: FALLBACK_SUPPORT_EMAIL,
    accent: ACCENT,
    accentBg: "rgba(226,72,29,0.1)",
  },
  {
    icon: Phone,
    titleKey: "contactPage.channelSupportTitle",
    descriptionKey: "contactPage.channelSupportDescription",
    link: "tel:+15550100",
    linkLabel: "+1 (555) 010-0000",
    accent: STRUCTURAL,
    accentBg: "rgba(33,28,22,0.1)",
  },
];

/* ── Service checkbox options ──────────────────────────────────────────── */

const SERVICES = [
  "formServiceEventTicketing",
  "formServiceOrganiserTools",
  "formServiceResaleProtection",
  "formServicePayouts",
  "formServiceApiAccess",
  "formServiceOther",
] as const;

/* ── Styles ────────────────────────────────────────────────────────────── */

const twoColRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 16,
};

const channelCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "20px 0",
};

const checkboxGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "10px 24px",
};

const checkboxLabel: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 14,
  color: "var(--color, #211C16)",
  cursor: "pointer",
};

/* ── Component ─────────────────────────────────────────────────────────── */

type FormState = "idle" | "submitting" | "sent";

export const ContactContent = () => {
  const t = useTranslations();
  // `/es/acerca-de` from the Spanish twin (spanish-seo FR-006).
  const aboutPath = usePublicLinks().path({ kind: "about" });

  const [formState, setFormState] = useState<FormState>("idle");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");
  const [services, setServices] = useState<Set<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<
    FieldErrors<"name" | "email" | "message">
  >({});

  const toggleService = useCallback((key: string) => {
    setServices((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();

      const fullName = `${firstName} ${lastName}`.trim();

      const result = validateForm({
        schema: contactFormSchema,
        data: { name: fullName, email, message },
        t,
      });

      if (!result.success) {
        setFieldErrors(result.fieldErrors);
        return;
      }

      setFieldErrors({});
      setFormState("submitting");

      const serviceList = [...services]
        .map((s) => String(t(`contactPage.${s}`)))
        .join(", ");

      const subject = encodeURIComponent(`Contact from ${fullName}`);
      const body = encodeURIComponent(
        [
          `From: ${fullName} <${result.data.email}>`,
          phone ? `Phone: ${phone}` : "",
          serviceList ? `Interested in: ${serviceList}` : "",
          "",
          result.data.message,
        ]
          .filter(Boolean)
          .join("\n"),
      );
      window.location.href = `mailto:${FALLBACK_SUPPORT_EMAIL}?subject=${subject}&body=${body}`;

      setTimeout(() => {
        setFormState("sent");
        setFirstName("");
        setLastName("");
        setEmail("");
        setPhone("");
        setMessage("");
        setServices(new Set());
      }, 600);
    },
    [firstName, lastName, email, phone, message, services, t],
  );

  const inputBase = inputStyle(false);
  const inputError = inputStyle(true);

  return (
    <PageContainer>
      {/* Hero — oversized display heading */}
      <section
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 20,
          paddingBottom: 32,
          borderBottom: "2px solid var(--borderColorSoft, rgba(33,28,22,0.3))",
        }}
      >
        <Overline>{String(t("contactPage.channelsHeading"))}</Overline>
        <DisplayHeading size="lg">
          {String(t("contactPage.heroTitle"))}
        </DisplayHeading>
        <p
          style={{
            maxWidth: 672,
            fontSize: 18,
            lineHeight: 1.6,
            color: "var(--colorMuted, #5C544A)",
          }}
        >
          {String(t("contactPage.heroDescription"))}
        </p>
      </section>

      {/* 01 — Contact form + channels (asymmetric grid) */}
      <NumberedSection
        n={1}
        title={String(t("contactPage.formHeading") ?? "Get in touch")}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "5fr 2fr",
            gap: 48,
            alignItems: "start",
          }}
        >
          {/* ── Left: form ────────────────────────────────────────── */}
          <SurfaceCard padding="32px" style={{ width: "100%" }}>
            {formState === "sent" ? (
              <ContentSection gap={16} center style={{ padding: "24px 0" }}>
                <IconCircle
                  icon={CheckCircle2}
                  color="#10b981"
                  bg="rgba(16,185,129,0.1)"
                />
                <CardTitle size={18}>
                  {String(t("contactPage.formSuccessTitle"))}
                </CardTitle>
                <MutedText maxWidth={384}>
                  {String(t("contactPage.formSuccessDescription"))}
                </MutedText>
                <GhostButton
                  onClick={() => setFormState("idle")}
                  style={{ marginTop: 8 }}
                >
                  {String(t("contactPage.formSendAnother"))}
                </GhostButton>
              </ContentSection>
            ) : (
              <form
                onSubmit={handleSubmit}
                style={{ display: "flex", flexDirection: "column", gap: 20 }}
              >
                {/* First + Last name */}
                <div style={twoColRow}>
                  <FormField
                    label={String(t("contactPage.formFirstNameLabel"))}
                    htmlFor="contact-first"
                    error={fieldErrors.name}
                  >
                    <input
                      id="contact-first"
                      type="text"
                      required
                      value={firstName}
                      onChange={(e) => {
                        setFirstName(e.target.value);
                        if (fieldErrors.name)
                          setFieldErrors((p) => ({ ...p, name: undefined }));
                      }}
                      placeholder={String(
                        t("contactPage.formFirstNamePlaceholder"),
                      )}
                      aria-invalid={fieldErrors.name ? true : undefined}
                      style={fieldErrors.name ? inputError : inputBase}
                    />
                  </FormField>

                  <FormField
                    label={String(t("contactPage.formLastNameLabel"))}
                    htmlFor="contact-last"
                  >
                    <input
                      id="contact-last"
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      placeholder={String(
                        t("contactPage.formLastNamePlaceholder"),
                      )}
                      style={inputBase}
                    />
                  </FormField>
                </div>

                {/* Email */}
                <FormField
                  label={String(t("contactPage.formEmailLabel"))}
                  htmlFor="contact-email"
                  error={fieldErrors.email}
                >
                  <input
                    id="contact-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (fieldErrors.email)
                        setFieldErrors((p) => ({ ...p, email: undefined }));
                    }}
                    placeholder={String(t("contactPage.formEmailPlaceholder"))}
                    aria-invalid={fieldErrors.email ? true : undefined}
                    style={fieldErrors.email ? inputError : inputBase}
                  />
                </FormField>

                {/* Phone */}
                <FormField
                  label={String(t("contactPage.formPhoneLabel"))}
                  htmlFor="contact-phone"
                >
                  <input
                    id="contact-phone"
                    type="tel"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder={String(t("contactPage.formPhonePlaceholder"))}
                    style={inputBase}
                  />
                </FormField>

                {/* Message */}
                <FormField
                  label={String(t("contactPage.formMessageLabel"))}
                  htmlFor="contact-message"
                  error={fieldErrors.message}
                >
                  <textarea
                    id="contact-message"
                    required
                    rows={5}
                    value={message}
                    onChange={(e) => {
                      setMessage(e.target.value);
                      if (fieldErrors.message)
                        setFieldErrors((p) => ({ ...p, message: undefined }));
                    }}
                    placeholder={String(
                      t("contactPage.formMessagePlaceholder"),
                    )}
                    aria-invalid={fieldErrors.message ? true : undefined}
                    style={{
                      ...(fieldErrors.message ? inputError : inputBase),
                      resize: "none",
                      lineHeight: 1.6,
                    }}
                  />
                </FormField>

                {/* Services checkboxes */}
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  <label
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      textTransform: "uppercase",
                      letterSpacing: "0.05em",
                      color: "var(--colorMuted, #5C544A)",
                    }}
                  >
                    {String(t("contactPage.formServicesLabel"))}
                  </label>
                  <div style={checkboxGrid}>
                    {SERVICES.map((key) => (
                      <label key={key} style={checkboxLabel}>
                        <input
                          type="checkbox"
                          checked={services.has(key)}
                          onChange={() => toggleService(key)}
                          style={{ accentColor: ACCENT }}
                        />
                        {String(t(`contactPage.${key}`))}
                      </label>
                    ))}
                  </div>
                </div>

                <SubmitButton disabled={formState === "submitting"}>
                  <Send size={15} />
                  {formState === "submitting"
                    ? String(t("contactPage.formSending"))
                    : String(t("contactPage.formSubmit"))}
                </SubmitButton>
              </form>
            )}
          </SurfaceCard>

          {/* ── Right: channels ───────────────────────────────────── */}
          <div
            className="swiss-dots"
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 8,
              paddingTop: 8,
              position: "relative",
              overflow: "hidden",
            }}
          >
            {CHANNELS.map(
              ({
                icon: Icon,
                titleKey,
                descriptionKey,
                link,
                linkLabel,
                accent,
                accentBg,
              }) => (
                <div key={titleKey} style={channelCard}>
                  <IconCircle icon={Icon} color={accent} bg={accentBg} />
                  <div>
                    <p
                      style={{
                        fontSize: 16,
                        fontWeight: 700,
                        color: "var(--foreground)",
                        marginBottom: 4,
                      }}
                    >
                      {String(t(titleKey))}
                    </p>
                    <p
                      style={{
                        fontSize: 14,
                        color: "var(--colorMuted, #5C544A)",
                        lineHeight: 1.5,
                      }}
                    >
                      {String(t(descriptionKey))}
                    </p>
                  </div>
                  <TextLink href={link} muted>
                    {linkLabel}
                  </TextLink>
                </div>
              ),
            )}
          </div>
        </div>
      </NumberedSection>

      {/* Responsive: stack on narrow screens */}
      <style>{`
        @media (max-width: 768px) {
          div[style*="5fr 2fr"] {
            grid-template-columns: 1fr !important;
          }
        }
      `}</style>

      {/* 02 — CTA */}
      <div
        className="swiss-diagonal"
        style={{ position: "relative", overflow: "hidden" }}
      >
        <NumberedSection n={2} title={String(t("contactPage.ctaTitle"))} accent>
          <AsymmetricGrid>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              <MutedText maxWidth={448} balance>
                {String(t("contactPage.ctaDescription"))}
              </MutedText>
              <ButtonRow>
                <ButtonPrimary href="/events">
                  {String(t("contactPage.ctaBrowseEvents"))}
                </ButtonPrimary>
                <ButtonOutline href={aboutPath}>
                  {String(t("contactPage.ctaAboutUs"))}
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
              <span className="swiss-hanging-num">02</span>
            </div>
          </AsymmetricGrid>
        </NumberedSection>
      </div>
    </PageContainer>
  );
};

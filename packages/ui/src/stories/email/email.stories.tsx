import type { Meta, StoryObj } from "@storybook/react";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@th/locale";
import {
  emailStorybookGeneratedAt,
  emailStorybookNotice,
  emailStorybookSampleMap,
  emailStorybookSamples,
  type EmailStorybookSample,
  type EmailStorybookVariant,
} from "./generated/samples";

type EmailViewerArgs = {
  templateId: string;
  locale?: string;
};

const localeOptions = SUPPORTED_LOCALES;

const meta: Meta<EmailViewerArgs> = {
  title: "Email",
  tags: ["autodocs"],
  parameters: {
    layout: "fullscreen",
  },
  argTypes: {
    locale: {
      control: { type: "select" },
      options: localeOptions,
      description: "Locale to preview (falls back to default if unavailable)",
      table: { category: "Selection" },
    },
  },
  args: {
    locale: DEFAULT_LOCALE,
  },
};

export default meta;

type Story = StoryObj<EmailViewerArgs>;

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

const MissingSamples = () => (
  <div
    style={{
      fontFamily:
        "Montserrat, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      padding: "3rem",
      maxWidth: "720px",
      margin: "0 auto",
      background: "#101828",
      color: "#F8FAFC",
      borderRadius: "16px",
      boxShadow: "0 24px 48px rgba(15, 23, 42, 0.25)",
    }}
  >
    <h2 style={{ marginTop: 0, fontSize: "1.75rem" }}>
      Email samples unavailable
    </h2>
    <p style={{ fontSize: "1rem", lineHeight: 1.6 }}>{emailStorybookNotice}</p>
  </div>
);

const EmailPreview = ({
  sample,
  variant,
}: {
  sample: EmailStorybookSample;
  variant?: EmailStorybookVariant;
}) => {
  const sampleVariants = sample.variants ?? [];
  const view = variant ??
    sampleVariants[0] ?? {
      locale: "default",
      subject: sample.subject,
      html: sample.html,
      text: sample.text,
    };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1.5rem",
        padding: "2rem",
        maxWidth: "960px",
        margin: "0 auto",
        fontFamily:
          "Montserrat, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <header
        style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
      >
        <span
          style={{
            fontSize: "0.75rem",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "#475467",
          }}
        >
          Template ID: {sample.id}
        </span>
        <h2 style={{ fontSize: "2rem", margin: 0 }}>{sample.displayName}</h2>
        <p style={{ margin: 0, color: "#475467" }}>Locale: {view.locale}</p>
        <p style={{ margin: 0, color: "#475467" }}>
          Subject preview: {view.subject}
        </p>
        {emailStorybookGeneratedAt ? (
          <small style={{ color: "#667085" }}>
            Generated: {new Date(emailStorybookGeneratedAt).toLocaleString()}
          </small>
        ) : null}
      </header>

      <section
        style={{ display: "flex", flexDirection: "column", gap: "0.75rem" }}
      >
        <h3 style={{ margin: 0, fontSize: "1rem", color: "#0F172A" }}>
          Rendered email
        </h3>
        <iframe
          title={`${sample.displayName} email (${view.locale})`}
          srcDoc={view.html}
          sandbox="allow-same-origin"
          style={{
            width: "100%",
            minHeight: "720px",
            border: "1px solid #E2E8F0",
            borderRadius: "16px",
            boxShadow: "0 20px 40px rgba(15, 23, 42, 0.12)",
          }}
        />
      </section>

      <section>
        <details
          open
          style={{
            background: "#F8FAFC",
            borderRadius: "12px",
            padding: "1rem",
          }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>
            Plaintext fallback
          </summary>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              margin: 0,
              fontFamily:
                "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            }}
          >
            {view.text}
          </pre>
        </details>
      </section>

      <section>
        <details
          style={{
            background: "#F8FAFC",
            borderRadius: "12px",
            padding: "1rem",
          }}
        >
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>
            Template props
          </summary>
          <pre
            style={{
              margin: "0.5rem 0 0",
              fontSize: "0.85rem",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily:
                "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            }}
          >
            {JSON.stringify(sample.props, null, 2)}
          </pre>
        </details>
      </section>

      <section>
        <h4 style={{ marginBottom: "0.5rem" }}>Required fields</h4>
        <ul
          style={{
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
            padding: 0,
            margin: 0,
          }}
        >
          {sample.requiredProps.map((prop) => (
            <li
              key={prop}
              style={{
                listStyle: "none",
                background: "#E0E7FF",
                color: "#1D4ED8",
                padding: "0.35rem 0.65rem",
                borderRadius: "999px",
                fontSize: "0.8rem",
                fontWeight: 700,
              }}
            >
              {prop}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Helper: build a story that renders a single template by its ID
// ---------------------------------------------------------------------------

const templateStory = (
  templateId: keyof typeof emailStorybookSampleMap,
): Story => ({
  args: { templateId },
  render: ({ locale }) => {
    const sample = emailStorybookSampleMap[templateId];
    if (!sample) return <MissingSamples />;
    const requestedLocale = locale ?? DEFAULT_LOCALE;
    const variant = (sample.variants ?? []).find(
      (v) => v.locale === requestedLocale,
    );
    return <EmailPreview sample={sample} variant={variant} />;
  },
});

// ---------------------------------------------------------------------------
// Individual template stories
// ---------------------------------------------------------------------------

export const VerificationCode: Story = {
  name: "Auth / Verification Code",
  ...templateStory("auth.verification_code"),
};

export const Announcement: Story = {
  name: "Event / Announcement",
  ...templateStory("event.announcement"),
};

export const EventDetails: Story = {
  name: "Event / Details",
  ...templateStory("event.details"),
};

export const ApplicationApproved: Story = {
  name: "Event / Application Approved",
  ...templateStory("event.application_approved"),
};

export const OrderReceipt: Story = {
  name: "Order / Receipt",
  ...templateStory("order.receipt"),
};

export const OrgInvitation: Story = {
  name: "Org / Invitation",
  ...templateStory("org.invitation"),
};

export const TicketIssued: Story = {
  name: "Ticket / Issued",
  ...templateStory("ticket.issued"),
};

// ---------------------------------------------------------------------------
// Gallery: all templates side by side
// ---------------------------------------------------------------------------

export const Gallery: Story = {
  render: () => {
    if (!emailStorybookSamples.length) {
      return <MissingSamples />;
    }

    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: "2rem",
          padding: "2rem",
          background: "#F1F5F9",
        }}
      >
        {emailStorybookSamples.map((sample) => (
          <div
            key={sample.id}
            style={{
              borderRadius: "16px",
              background: "#FFFFFF",
              boxShadow: "0 16px 32px rgba(15, 23, 42, 0.16)",
              overflow: "hidden",
            }}
          >
            <div
              style={{ padding: "1.25rem", borderBottom: "1px solid #E2E8F0" }}
            >
              <h3 style={{ margin: "0 0 0.25rem", fontSize: "1.15rem" }}>
                {sample.displayName}
              </h3>
              <p style={{ margin: 0, color: "#64748B" }}>{sample.subject}</p>
            </div>
            <iframe
              title={`${sample.id} preview`}
              srcDoc={sample.html}
              sandbox="allow-same-origin"
              style={{
                width: "100%",
                minHeight: "480px",
                border: 0,
              }}
            />
          </div>
        ))}
      </div>
    );
  },
};

// ---------------------------------------------------------------------------
// Locale comparison: shows all locales for ticket.issued side by side
// ---------------------------------------------------------------------------

export const TicketIssuedLocales: Story = {
  name: "Ticket / Issued (all locales)",
  render: () => {
    const sample = emailStorybookSampleMap["ticket.issued"];
    if (!sample) {
      return <MissingSamples />;
    }

    const variants = sample.variants ?? [];

    return (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))",
          gap: "2rem",
          padding: "2rem",
          background: "#F8FAFC",
        }}
      >
        {variants.map((variant) => (
          <div
            key={variant.locale}
            style={{
              borderRadius: "18px",
              background: "#FFFFFF",
              boxShadow: "0 18px 36px rgba(15, 23, 42, 0.12)",
              overflow: "hidden",
            }}
          >
            <div
              style={{ padding: "1.5rem", borderBottom: "1px solid #E2E8F0" }}
            >
              <h3 style={{ margin: "0 0 0.5rem", fontSize: "1.3rem" }}>
                Locale: {variant.locale}
              </h3>
              <p style={{ margin: 0, color: "#64748B" }}>{variant.subject}</p>
            </div>
            <iframe
              title={`ticket.issued-${variant.locale}`}
              srcDoc={variant.html}
              sandbox="allow-same-origin"
              style={{ width: "100%", minHeight: "520px", border: 0 }}
            />
            <details style={{ padding: "1.25rem", background: "#F8FAFC" }}>
              <summary style={{ cursor: "pointer", fontWeight: 700 }}>
                Plaintext
              </summary>
              <pre
                style={{
                  margin: "0.75rem 0 0",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontFamily:
                    "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
                }}
              >
                {variant.text}
              </pre>
            </details>
          </div>
        ))}
      </div>
    );
  },
};

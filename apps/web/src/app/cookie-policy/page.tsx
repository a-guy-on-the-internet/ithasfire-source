import type { Metadata } from "next";

import {
  LegalPage,
  LegalSection,
  TextLink,
} from "@/components/layout/PagePrimitives";

export const metadata: Metadata = {
  title: "Cookie Policy",
  description: "How Ithas Fire uses cookies and similar technologies.",
};

// Table chrome, theme-tracking. The border rides the `borderColorSoft` theme
// token; the thead fill is a low-alpha ink tint of the page surface (there is
// no semantic token for a table-header wash). Stub hexes are the fallbacks —
// they are what SSR/first paint renders.
const TABLE_BORDER = "var(--borderColorSoft, rgba(33,28,22,0.3))";
const TABLE_HEAD_BG = "rgba(33,28,22,0.06)";

/**
 * Four columns of prose do not fit a phone. Measured at 375px: the table laid
 * out at 508px inside a 351px scrollport, hiding 157px — all of Duration and
 * half of Type. The page did not overflow (the `overflow-x: auto` wrapper did
 * its job) but a third of a legal disclosure sat behind a horizontal scroll
 * nobody would think to perform.
 *
 * So below 640px each row becomes a labelled block, driven by `data-label` so
 * the header text is never duplicated in the markup. Styles live here rather
 * than inline because inline styles win over media queries.
 */
const TABLE_CSS = `
.ck-table { width: 100%; text-align: left; font-size: 14px; border-collapse: collapse; border: 1px solid ${TABLE_BORDER}; }
.ck-table th, .ck-table td { border-bottom: 1px solid ${TABLE_BORDER}; padding: 8px 16px; vertical-align: top; }
.ck-table th { font-weight: 700; background: ${TABLE_HEAD_BG}; }
.ck-table tr:last-child td { border-bottom: 0; }
@media (max-width: 640px) {
  .ck-table { border-collapse: separate; }
  .ck-table thead { display: none; }
  .ck-table tr { display: block; border-bottom: 1px solid ${TABLE_BORDER}; padding: 12px 0; }
  .ck-table tr:last-child { border-bottom: 0; }
  .ck-table td { display: block; border-bottom: 0; padding: 2px 16px; }
  .ck-table td::before { content: attr(data-label); display: block; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; opacity: 0.65; margin-bottom: 2px; }
}
`;

type CookieRow = {
  name: React.ReactNode;
  purpose: string;
  type: string;
  duration: string;
};

const COOKIE_ROWS: CookieRow[] = [
  {
    name: <code>better-auth.session_token</code>,
    purpose: "Keeps you signed in across page loads.",
    type: "Essential",
    duration: "Until you sign out; refreshed while active",
  },
  {
    name: <code>th-theme</code>,
    purpose:
      "Remembers whether you chose light or dark, so the page does not flash the wrong one while loading.",
    type: "Essential",
    duration: "1 year",
  },
  {
    name: <code>th_eu_&lt;event id&gt;</code>,
    purpose:
      "Remembers that you entered the correct password for a private event, so you are not asked again on every page.",
    type: "Essential",
    duration: "24 hours",
  },
  {
    name: <code>th_ea_&lt;event id&gt;</code>,
    purpose:
      "Remembers that the organizer approved your application to an event, so the event page opens for you without signing in. It stops working if the approval is taken back.",
    type: "Essential",
    duration: "24 hours",
  },
  {
    name: <code>th_ei_&lt;event id&gt;</code>,
    purpose:
      "Set when you open an invite link to a private event, so the event page opens for you without a password or an application.",
    type: "Essential",
    duration: "Until the event ends",
  },
  {
    name: (
      <>
        <code>__stripe_mid</code> / <code>__stripe_sid</code>
      </>
    ),
    purpose:
      "Set by Stripe for fraud detection. Only appears on checkout pages, when you are actually paying.",
    type: "Essential",
    duration: "1 year / 30 min",
  },
];

export default function CookiePolicyPage() {

  return (
    <LegalPage title="Cookie Policy" updatedAt="July 2026">
      <style dangerouslySetInnerHTML={{ __html: TABLE_CSS }} />
      <LegalSection title="The short version">
        <p>
          We set four cookies, and every one of them is needed to make the site
          work — signing you in, remembering your theme, opening private events,
          and letting Stripe check for fraud when you pay. We run no advertising
          trackers, we build no profile of you, and we sell and share nothing
          with data brokers.
        </p>
        <p>
          That is also why you have never seen a cookie banner here. There is
          nothing optional to agree to, so we do not interrupt you to ask.
        </p>
      </LegalSection>

      <LegalSection title="What are cookies?">
        <p>
          Cookies are small text files stored on your device by your browser.
          They help websites remember your preferences, keep you signed in, and
          keep a checkout secure.
        </p>
      </LegalSection>

      <LegalSection title="Cookies we use">
        <p>
          All four are strictly necessary. Under the ePrivacy Directive
          (Article 5(3)) cookies of this kind do not require consent, which is
          why there is no banner asking for it.
        </p>
        <div style={{ overflowX: "auto", marginTop: 12 }}>
          <table className="ck-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Purpose</th>
                <th>Type</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {COOKIE_ROWS.map((row, i) => (
                <tr key={i}>
                  <td data-label="Name">{row.name}</td>
                  <td data-label="Purpose">{row.purpose}</td>
                  <td data-label="Type">{row.type}</td>
                  <td data-label="Duration">{row.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </LegalSection>

      <LegalSection title="Analytics">
        <p>
          We use a cookieless analytics service to count visits and see which
          pages get used. It sets no cookies, stores nothing on your device, and
          creates no identifier that could follow you between visits or across
          other websites. It measures pages, not people.
        </p>
        <p>
          We deliberately do not use Google Analytics, advertising pixels, or
          any other cross-site tracking technology.
        </p>
      </LegalSection>

      <LegalSection title="Error diagnostics">
        <p>
          When something breaks, we capture the error through Sentry so we can
          fix it. This sets no cookies and stores nothing on your device. The
          report contains the technical detail of the failure — the error
          itself, which page it happened on, and your browser and operating
          system version — and is configured to exclude IP addresses, cookies,
          and request contents.
        </p>
        <p>
          We do this under our legitimate interest in keeping the platform
          secure and working (GDPR Recital 49). We do not record your screen or
          your session.
        </p>
      </LegalSection>

      <LegalSection title="Managing your preferences">
        <p>
          Because we set only essential cookies, there is nothing here to switch
          off — and no consent to withdraw.
        </p>
        <p>
          Your browser can still block or delete cookies for this site at any
          time. Be aware that blocking them will break sign-in and checkout,
          since those genuinely depend on the cookies above.
        </p>
        <p>
          If we ever add something optional — analytics that identifies you, or
          an advertising pixel an event organiser has asked for — we will ask
          you first, name it plainly, and this page will list it before it runs.
        </p>
      </LegalSection>

      <LegalSection title="More information">
        <p>
          Cookies are only part of the picture. For what we do with the
          information you give us — your account, your orders, your tickets —
          see our <TextLink href="/privacy">Privacy Policy</TextLink>. If you
          have questions, contact us at{" "}
          <strong>privacy@ithasfire.com</strong>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

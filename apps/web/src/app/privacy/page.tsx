import type { Metadata } from "next";

import {
  LegalPage,
  LegalSection,
  LegalList,
  TextLink,
} from "@/components/layout/PagePrimitives";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How Ithas Fire collects, uses, and protects your data.",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy" updatedAt="18 October 2026">
      <LegalSection title="1. Who we are">
        <p>
          Ithas Fire (&quot;we&quot;, &quot;us&quot;, &quot;our&quot;) operates
          the Ithas Fire platform for event discovery, ticketing, and payments.
          This policy explains how we collect, use, and protect personal data
          when you use our website and mobile applications.
        </p>
        <p>
          For the purposes of the EU and UK General Data Protection Regulations,
          Ithas Fire is the <strong>data controller</strong> of personal data
          collected through the platform. Event organisers using Ithas Fire to
          sell tickets are independent controllers of the attendee data they
          receive from us; their own privacy notices govern that processing.
        </p>
        <p>
          Privacy enquiries, data-subject requests, and our Data Protection
          contact: <strong>privacy@ithasfire.com</strong>. We aim to
          respond within 30 days as required by Article 12(3) GDPR.
        </p>
      </LegalSection>

      <LegalSection title="2. Data we collect">
        <LegalList>
          <li>
            <strong>Account data</strong> &mdash; name, email address, profile
            picture, and authentication credentials when you create an account.
          </li>
          <li>
            <strong>Phone number (optional)</strong> &mdash; if you add a
            mobile number, we store it and whether you have verified it. We use
            it only for the texts you opt into: security codes (phone
            verification and two-factor sign-in) and the notification texts
            you turn on (volunteer reminders and location reveals for
            events you are going to). Each opt-in is separate from accepting
            our Terms, and you can withdraw it at any time by replying STOP to
            any text or by contacting support. Reply HELP for help. We never send marketing
            by text. We do not sell, rent or share your mobile number or SMS
            opt-in consent with third parties or affiliates for their
            marketing or promotional purposes. We give it to Amazon Web
            Services to deliver texts. A number you enter on a volunteer
            signup or booking request also goes to the organiser or place owner you
            sent it to, so they can reach you about it. See{" "}
            <TextLink href="/terms#sms">SMS terms</TextLink>.
          </li>
          <li>
            <strong>Transaction data</strong> &mdash; order details (including
            the IP address used at checkout), payment method identifiers
            (processed by Stripe), and payout information for event organisers.
          </li>
          <li>
            <strong>Usage data</strong> &mdash; pages visited, features used,
            device type, browser, IP address, and approximate location derived
            from IP.
          </li>
          <li>
            <strong>Cookies &amp; similar technologies</strong> &mdash; see our{" "}
            <TextLink href="/cookie-policy">Cookie Policy</TextLink> for
            details.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="3. How we use your data">
        <LegalList>
          <li>To provide, maintain, and improve the platform.</li>
          <li>To process ticket purchases and payouts.</li>
          <li>To send transactional emails (order confirmations, receipts).</li>
          <li>
            To send the texts you opted into: security codes, and the volunteer
            reminders and location reveals you turned on. Msg
            &amp; data rates may apply. Reply STOP to any text to opt out, or
            HELP for help.
          </li>
          <li>To detect fraud and enforce our terms of service.</li>
          <li>
            To analyse usage trends (when you consent to analytics cookies).
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="4. Legal bases (GDPR)">
        <p>
          We process personal data on the following legal bases:{" "}
          <strong>contract</strong> (to fulfil ticket purchases),{" "}
          <strong>legitimate interest</strong> (fraud prevention, platform
          security), and <strong>consent</strong> (analytics and marketing
          cookies).
        </p>
      </LegalSection>

      <LegalSection title="5. Data sharing">
        <p>
          We share data only as necessary: with <strong>Stripe</strong> for
          payment processing, with event organisers so they can fulfil your
          tickets, and with infrastructure providers that host our systems. We
          do not sell personal data.
        </p>
        <p>
          Two third-party services see technical data about your visit.{" "}
          <strong>Sentry</strong> receives application error reports under our
          legitimate interest in platform reliability; these are configured to
          exclude IP addresses, cookies, and request contents, and we do not
          record your screen or your session. A{" "}
          <strong>cookieless analytics service</strong> counts page visits
          without setting cookies, storing anything on your device, or creating
          any identifier that could follow you between visits. We do not use
          Google Analytics or advertising pixels. See our{" "}
          <TextLink href="/cookie-policy">Cookie Policy</TextLink> for details.
        </p>
      </LegalSection>

      <LegalSection title="6. Data retention">
        <p>
          We retain account and transaction data for as long as your account is
          active, plus any period required by law (e.g. tax records). Usage data
          and logs are retained for up to 12 months. Support chat conversations
          are deleted 12 months after the conversation is resolved.
        </p>
        <p>
          To prevent fraud and abuse, when you sign up or sign in we keep a
          keyed hash of your network address and of its network range, the
          country it comes from, and your browser and operating system family
          (not the full browser string) for about 30 days. When you suggest an
          edit to a community listing, we keep a keyed hash of your network
          address with the suggestion for about 30 days to limit abuse. If we
          ban or suspend an account for abuse, we keep a keyed hash of its email
          address for as long as the ban or suspension stands, including after
          the account is deleted, and hashes of the network ranges it used for
          about 30 days from the ban or suspension.
        </p>
        <p>
          In our database we keep raw IP addresses only on evidence records:
          when you accept our terms, a waiver, a refund policy or the scanner
          terms, or when an organiser attests to hosting an event, we record the
          IP address with that acceptance as evidence of it. When you get
          tickets online, we record the IP address with the order as well as
          with your refund-policy acceptance. If the payment is disputed, we
          send it to our payment processor as evidence of the purchase. It is
          kept with the order for as long as we keep transaction data (see
          above). Apart from these records, we do not store your IP address
          with your account or your sessions.
        </p>
      </LegalSection>

      <LegalSection title="7. Your rights">
        <p>
          Depending on your jurisdiction you may have the right to access,
          correct, delete, or port your personal data. You can also withdraw
          consent for optional cookies at any time by clearing the{" "}
          <code>th-consent</code> cookie. To exercise your rights, contact us at{" "}
          <strong>privacy@ithasfire.com</strong>.
        </p>
        <p>
          We keep a record of your consent decisions — timestamp, the policy
          version in effect, the device&apos;s anonymous identifier, and a
          one-way hash of your network address — so we can demonstrate
          compliance with Article 7(1) GDPR. The raw IP itself is not retained.
          Email <strong>privacy@ithasfire.com</strong> to request a copy
          of your consent history or to have it deleted.
        </p>
      </LegalSection>

      <LegalSection title="8. International data transfers">
        <p>
          Some of our processors are located in the United States — specifically{" "}
          <strong>Stripe</strong> (payments), <strong>Sentry</strong> (error
          diagnostics), and <strong>Google</strong> (analytics, when you
          consent). When personal data is transferred from the EU/EEA, UK, or
          Switzerland to a third country, we rely on one of the following
          Article 46 GDPR mechanisms:
        </p>
        <LegalList>
          <li>
            The <strong>EU–US Data Privacy Framework</strong> for transfers to
            certified US-based processors (Google, Sentry).
          </li>
          <li>
            The European Commission&apos;s{" "}
            <strong>Standard Contractual Clauses</strong> (2021/914) where the
            DPF does not apply, supplemented by the UK International Data
            Transfer Addendum where required.
          </li>
        </LegalList>
        <p>
          You can request a copy of the safeguards in place by contacting{" "}
          <strong>privacy@ithasfire.com</strong>.
        </p>
      </LegalSection>

      <LegalSection title="9. Security">
        <p>
          We use encryption in transit (TLS), hashed credentials, and scoped
          access controls to protect your data. Stripe handles all payment-card
          data; we never store card numbers directly.
        </p>
      </LegalSection>

      <LegalSection title="10. Lodging a complaint">
        <p>
          If you are in the EU/EEA, UK, or Switzerland and believe our
          processing infringes data-protection law, you have the right to lodge
          a complaint with your local supervisory authority. A list of EU
          authorities is available at{" "}
          <TextLink href="https://edpb.europa.eu/about-edpb/about-edpb/members_en">
            edpb.europa.eu
          </TextLink>
          ; UK residents can contact the{" "}
          <TextLink href="https://ico.org.uk/make-a-complaint/">
            Information Commissioner&apos;s Office
          </TextLink>
          . We&apos;d appreciate the chance to address your concern first —
          please contact us at <strong>privacy@ithasfire.com</strong>.
        </p>
      </LegalSection>

      <LegalSection title="11. Contact">
        <p>
          For privacy-related questions, reach us at{" "}
          <strong>privacy@ithasfire.com</strong>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

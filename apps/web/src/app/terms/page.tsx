import type { Metadata } from "next";

import {
  LegalPage,
  LegalSection,
  LegalList,
  TextLink,
} from "@/components/layout/PagePrimitives";
import { FALLBACK_SUPPORT_EMAIL } from "@/lib/support-email";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "Ithas Fire terms and conditions of use.",
};

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service" updatedAt="18 October 2026">
      {/* ── DRAFT banner — remove before publication ─────────────────────── */}
      <div
        role="note"
        style={{
          // Support-amber family (--support) — was an off-palette #b45309.
          border: "2px solid var(--support, #F59E0B)",
          background: "rgba(245, 158, 11, 0.08)",
          color: "var(--foreground)",
          padding: "12px 16px",
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: 0.3,
          borderRadius: 0,
        }}
      >
        [DRAFT — MERCHANT-OF-RECORD REVISION PENDING REVIEW BY QUALIFIED COUNSEL
        BEFORE PUBLICATION]
      </div>

      <LegalSection title="1. Acceptance of these terms">
        <p>
          These Terms of Service (&ldquo;<strong>Terms</strong>&rdquo;) form a
          binding agreement between you and Ithas Fire (&ldquo;
          <strong>Ithas Fire</strong>&rdquo;, &ldquo;we&rdquo;,
          &ldquo;us&rdquo;, &ldquo;our&rdquo;), the operator of the Ithas Fire
          event-ticketing platform at <strong>ithasfire.com</strong> and
          its mobile applications (collectively, the &ldquo;
          <strong>Platform</strong>&rdquo;). By creating an account, purchasing
          a ticket, listing an event, or otherwise using the Platform, you
          accept these Terms. If you do not accept them, do not use the
          Platform.
        </p>
        <p>
          Additional terms apply to specific roles: ticket buyers (&ldquo;
          <strong>Buyers</strong>&rdquo;), event organisers and hosts (&ldquo;
          <strong>Organisers</strong>&rdquo;), and people and organisations who
          own or run places (&ldquo;<strong>Place owners</strong>&rdquo;).
          Where this document refers to &ldquo;
          <strong>you</strong>&rdquo;, it applies to whichever role you are
          acting in at the time.
        </p>
      </LegalSection>

      <LegalSection title="2. Eligibility & accounts">
        <p>
          You must be at least 18 years old (or the age of majority in your
          jurisdiction) to create an account or purchase a ticket on the
          Platform. If you are using the Platform on behalf of a legal entity,
          you confirm you are authorised to bind that entity to these Terms.
        </p>
        <p>
          You are responsible for safeguarding your account credentials and for
          all activity under your account. Notify us promptly at{" "}
          <TextLink href="mailto:security@ithasfire.com">
            security@ithasfire.com
          </TextLink>{" "}
          if you suspect unauthorised access. We may suspend, restrict, or
          terminate accounts that violate these Terms, our policies, or
          applicable law.
        </p>
      </LegalSection>

      <LegalSection title="3. The Platform's role (merchant of record)">
        <p>
          Ithas Fire is the <strong>merchant of record</strong> for ticket
          transactions processed through the Platform. Payments from Buyers are
          collected into Ithas Fire&apos;s own platform account through Stripe,
          and Ithas Fire then remits the Organiser&apos;s net share to the
          Organiser&apos;s connected account. Because we hold funds before
          passing them on, the payment relationship for each ticket transaction
          is with Ithas Fire, and Ithas Fire carries the associated
          refund and chargeback responsibility with the card networks and our
          payment processor.
        </p>
        <p>
          Being merchant of record for the transaction does{" "}
          <strong>not</strong> make Ithas Fire the producer of the event. Each
          event is offered, produced, operated, and warranted{" "}
          <strong>solely by its Organiser</strong>. Ithas Fire does not own the
          events listed, does not control admission decisions, and is not
          responsible for how an event is run. We provide payment processing as
          merchant of record together with ticketing, discovery, and scanning
          tooling; the Organiser is responsible for delivering the event itself.
        </p>
      </LegalSection>

      <LegalSection title="4. Buyer terms — purchases & tickets">
        <p>
          When you purchase a ticket, your <strong>payment</strong> is
          processed by Ithas Fire as merchant of record (see Section 3), while
          the underlying <strong>event</strong> is provided by, and your
          admission is a matter between you and the <strong>Organiser</strong>{" "}
          and the Place owner. Tickets are a revocable licence to attend the
          event subject to the Organiser&apos;s and Place owner&apos;s admission rules, including but
          not limited to identification checks, search policies, conduct
          policies, age restrictions, and capacity limits.
        </p>
        <p>
          All prices shown at checkout are inclusive of applicable fees
          (Ithas Fire fee, payment-processor fee, and, where applicable, sales
          tax). The price shown on the final pay button is the price you will be
          charged. We comply with the U.S. Federal Trade Commission&apos;s
          &ldquo;all-in pricing&rdquo; requirements for live-event ticketing.
        </p>
        <p>
          Free, paid, donation (pay-what-you-want), and password-gated tickets
          each carry the refund disclosures described in{" "}
          <strong>Section 5</strong>.
        </p>
      </LegalSection>

      <LegalSection title="5. Refund & cancellation policy">
        <LegalList>
          <li>
            <strong>Paid tickets</strong>: refunds are governed by the
            Organiser&apos;s refund policy disclosed on the event page. Where
            the Organiser has not stated a policy, paid tickets are
            non-refundable except where required by law or by
            payment-card-network rules.
          </li>
          <li>
            <strong>Fees on a refund</strong>: where a refund is issued, the
            Ithas Fire platform fee (currently 3.33% of the ticket price, capped
            at $0.50 per primary-market ticket) is refunded to you along with the
            ticket price and any tax. The payment-processor fee passed through
            from Stripe is{" "}
            <strong>non-refundable</strong>, except where prohibited by law,
            because the processor retains that fee when a payment is reversed.
          </li>
          <li>
            <strong>Donation / adjustable-price tickets</strong>: donation
            tickets are
            <strong> non-refundable</strong>. Because there is no agreed face
            value, refund disputes cannot be reconciled to a defined product,
            and any donation amount chosen by the Buyer was voluntary.
          </li>
          <li>
            <strong>Free tickets</strong>: no refund applies (no payment was
            made). The Organiser may cancel a free RSVP at their discretion.
          </li>
          <li>
            <strong>Event cancellation by the Organiser</strong>: if the
            Organiser cancels the event in full, Ithas Fire will automatically
            initiate a refund of the ticket face value to all Buyers with
            succeeded orders, including donation orders where applicable. The
            Ithas Fire platform fee remains non-refundable.
          </li>
          <li>
            <strong>Event postponement</strong>: if the Organiser postpones
            rather than cancels the event, your ticket remains valid for the
            rescheduled date unless the Organiser publishes a refund window.
          </li>
          <li>
            <strong>Chargebacks &amp; disputes</strong>: if you initiate a
            chargeback without first contacting the Organiser or Ithas Fire
            support, we may suspend your account pending review. Chargeback fees
            passed through by the card network may be charged to the responsible
            party.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="6. Organiser terms — listing events & receiving payouts">
        <p>
          By listing an event on the Platform, you represent and warrant that:
        </p>
        <LegalList>
          <li>
            You have the legal right to host the event at the disclosed
            location, including any required permits, licences, landlord or HOA
            permissions, and zoning compliance.
          </li>
          <li>
            You will comply with all applicable laws relating to noise,
            occupancy, fire code, alcohol service, food handling, taxation,
            accessibility (ADA in the U.S.), and ticket-resale regulations.
          </li>
          <li>
            You will not sell alcohol on the Platform unless you are a licensed
            alcohol retailer in the jurisdiction of the event; pour-your-own /
            BYOB private events are permitted where local law allows.
          </li>
          <li>
            You will deliver the event substantially as described, with material
            changes disclosed promptly to ticket-holders.
          </li>
          <li>
            You will honour your stated refund policy and any
            consumer-protection rights Buyers have under applicable law.
          </li>
          <li>
            Revenue you receive through the Platform is your responsibility for
            tax-reporting purposes. Stripe may issue you a 1099-K (or
            jurisdiction-equivalent form) when thresholds are met.
          </li>
        </LegalList>
        <p>
          Ithas Fire collects ticket payments as merchant of record (see
          Section 3) and pays out the Organiser&apos;s net share through Stripe
          Connect. By signing up as an Organiser, you also accept the{" "}
          <TextLink href="https://stripe.com/legal/connect-account">
            Stripe Connected Account Agreement
          </TextLink>{" "}
          for the connected account that receives your payouts. Ithas Fire
          deducts its fee from the amount it collects; the remainder is
          transferred to you on the payout schedule applicable to your account.
        </p>
        <p>
          Because Ithas Fire carries refund and chargeback liability as merchant
          of record, we may <strong>withhold, reserve, delay, or reverse</strong>{" "}
          all or part of a payout where there is unusual chargeback risk,
          suspected fraud, pending disputes, refund exposure, or a violation of
          these Terms or the{" "}
          <TextLink href="/acceptable-use">Acceptable Use Policy</TextLink>. You
          remain responsible for chargebacks, refunds, and related fees arising
          from your events, and you authorise Ithas Fire to recover those
          amounts from your balance, from future payouts, or by other lawful
          means.
        </p>
      </LegalSection>

      <LegalSection title="7. House shows & private events">
        <p>
          The Platform supports informal &ldquo;house show&rdquo; and private
          events. Organisers of private events confirm at the point of creation
          that they have the legal right to host, are in compliance with local
          noise and occupancy rules, are not engaged in unlicensed sale of
          alcohol, and accept that income from ticket sales is taxable. Address
          details are disclosed to confirmed RSVPs only.
        </p>
      </LegalSection>

      <LegalSection title="8. Resale, transfers & secondary market">
        <p>
          Where the Organiser permits transfer, Buyers may transfer or list
          tickets for resale through the Platform. Resale prices are subject to
          caps configured by the Organiser and to applicable anti-scalping laws
          in the event jurisdiction.
        </p>
        <p>
          Tickets bought or transferred off-platform are not guaranteed to be
          honoured at the door and will not be supported by Ithas Fire customer
          service.
        </p>
      </LegalSection>

      <LegalSection title="9. User content & licence">
        <p>
          You retain ownership of content you submit to the Platform (event
          descriptions, images, profile information, reviews, etc.). You grant
          Ithas Fire a worldwide, non-exclusive, royalty-free, sublicensable
          licence to host, display, reproduce, and distribute that content as
          necessary to operate, promote, and improve the Platform.
        </p>
        <p>
          You are responsible for ensuring your content does not infringe
          third-party rights, defame any person, or include unlawful material.
          We may remove content that violates these Terms, our community policy,
          or applicable law.
        </p>
      </LegalSection>

      <LegalSection title="10. Acceptable use">
        <p>
          You agree not to: (a) interfere with or disrupt the Platform; (b)
          attempt to access accounts or data you are not authorised to access;
          (c) scrape, crawl, or reverse-engineer the Platform beyond what
          robots.txt allows; (d) impersonate any person or misrepresent your
          affiliation; (e) use the Platform to ticket events that are unlawful,
          fraudulent, or that promote violence, hate, or harassment; (f) bypass
          platform fees through off-platform settlement of on-platform orders.
        </p>
        <p>
          Organisers are additionally bound by our{" "}
          <TextLink href="/acceptable-use">Acceptable Use Policy</TextLink>,
          which sets out — as a flowdown from our payment partners&apos; rules —
          the categories of events and content we cannot process payments for.
          It forms part of these Terms.
        </p>
      </LegalSection>

      <LegalSection title="11. Privacy & data protection">
        <p>
          Our processing of personal data is described in the{" "}
          <TextLink href="/privacy">Privacy Policy</TextLink>, which forms part
          of these Terms. Cookie use is described in the{" "}
          <TextLink href="/cookie-policy">Cookie Policy</TextLink>.
        </p>
      </LegalSection>

      <LegalSection id="sms" title="12. SMS communications & consent">
        <p>
          The <strong>Ithas Fire text messages</strong> program sends texts
          only to a mobile number you have given us and only for the kinds of
          text you have turned on. There are two kinds:
        </p>
        <LegalList>
          <li>
            <strong>Security codes</strong> &mdash; one-time codes to verify
            your phone number and to sign in with two-factor authentication.
            Frequency: one text each time you ask for a code. You opt in when
            you add and verify a phone number in{" "}
            <strong>Settings &rarr; Security</strong>.
          </li>
          <li>
            <strong>Notification texts</strong> &mdash; volunteer reminders
            (up to two for each shift or role you sign up for, on an event or
            on a one-time volunteer ask: about 24 hours and about 1 hour
            before it starts), and one text when the hidden location of an event you
            are going to is revealed. Frequency varies with how many volunteer
            sign-ups and events you have. You opt in to volunteer reminders
            with the text-reminder box when you sign up or later on that
            sign-up, and to location texts with the SMS switch in your
            notification settings.
          </li>
        </LegalList>
        <p>
          We never send marketing, announcements or organiser messages by
          text. Consent to texts is not a condition of any purchase, sign-up
          or other service, and is never part of accepting these Terms. You
          can get the same codes and notifications by email instead.
        </p>
        <p>
          Msg &amp; data rates may apply. Reply <strong>STOP</strong> to any
          text to opt out: we confirm with one reply and send nothing more.
          Reply <strong>START</strong> to get texts again; volunteer reminders
          stay off until you tick the text-reminder box on that sign-up again.
          A sign-up that isn't listed in your account has no box, so its
          reminders stay off. Reply{" "}
          <strong>HELP</strong> for help, or email{" "}
          <TextLink href={`mailto:${FALLBACK_SUPPORT_EMAIL}`}>
            {FALLBACK_SUPPORT_EMAIL}
          </TextLink>
          . Carriers are not liable for delayed or undelivered messages. How
          we handle your number is described in the{" "}
          <TextLink href="/privacy">Privacy Policy</TextLink>.
        </p>
      </LegalSection>

      <LegalSection title="13. Disclaimers">
        <p>
          THE PLATFORM IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
          AVAILABLE&rdquo;. ITHASFIRE DISCLAIMS ALL WARRANTIES, EXPRESS OR
          IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, AND NON-INFRINGEMENT, EXCEPT AS REQUIRED BY
          APPLICABLE LAW.
        </p>
        <p>
          ITHASFIRE IS NOT RESPONSIBLE FOR THE QUALITY, SAFETY, LEGALITY, OR
          CONDUCT OF EVENTS LISTED ON THE PLATFORM, NOR FOR ANY ACT OR OMISSION
          OF AN ORGANISER, PLACE OWNER, OR ATTENDEE.
        </p>
      </LegalSection>

      <LegalSection title="14. Limitation of liability">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, ITHASFIRE&apos;S AGGREGATE
          LIABILITY ARISING FROM OR RELATING TO THESE TERMS OR THE PLATFORM WILL
          NOT EXCEED THE GREATER OF (A) THE TOTAL ITHASFIRE FEES YOU PAID IN
          THE TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM,
          OR (B) ONE HUNDRED U.S. DOLLARS ($100).
        </p>
        <p>
          ITHASFIRE WILL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL,
          CONSEQUENTIAL, OR PUNITIVE DAMAGES, OR FOR LOST PROFITS, REVENUE,
          DATA, OR GOODWILL, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
        </p>
      </LegalSection>

      <LegalSection title="15. Indemnification">
        <p>
          You will indemnify, defend, and hold harmless Ithas Fire, its
          affiliates, and their respective officers, directors, employees, and
          agents, from and against any claims, liabilities, damages, losses, and
          expenses (including reasonable attorneys&apos; fees) arising out of or
          in any way connected with: (a) your use of the Platform; (b) your
          violation of these Terms; (c) your violation of any third-party right
          (including any intellectual-property, publicity, or privacy right);
          (d) the events you host (if an Organiser); or (e) any content you
          submit.
        </p>
      </LegalSection>

      <LegalSection title="16. Termination">
        <p>
          You may stop using the Platform at any time. We may suspend or
          terminate your access for any breach of these Terms, for legal or
          regulatory reasons, or for extended inactivity. Pending obligations
          (payouts due, refund obligations, fees incurred) survive termination.
        </p>
      </LegalSection>

      <LegalSection title="17. Changes to these Terms">
        <p>
          We may update these Terms from time to time. We will post the revised
          version with an updated &ldquo;last updated&rdquo; date and, for
          material changes, notify registered users by email or in-app.
          Continued use of the Platform after changes take effect constitutes
          acceptance of the revised Terms.
        </p>
      </LegalSection>

      <LegalSection title="18. Governing law & dispute resolution">
        <p>
          These Terms are governed by the laws of the State of Delaware, United
          States, without regard to its conflict-of-laws principles. The federal
          and state courts located in <strong>Delaware</strong> will have
          exclusive jurisdiction over any dispute arising from or relating to
          these Terms, except where the parties agree to alternative dispute
          resolution or where applicable law grants you the right to bring
          claims in your local courts.
        </p>
        <p>
          Before filing a formal claim, you agree to first contact us at{" "}
          <TextLink href="mailto:legal@ithasfire.com">
            legal@ithasfire.com
          </TextLink>{" "}
          and allow at least thirty (30) days for good-faith resolution.
        </p>
        <p>
          <strong>Class-action waiver.</strong> To the extent permitted by law,
          you and Ithas Fire agree to bring claims only in your individual
          capacity and not as a plaintiff or class member in any purported
          class, collective, or representative proceeding.
        </p>
      </LegalSection>

      <LegalSection title="19. Miscellaneous">
        <p>
          These Terms, together with the Privacy Policy and any policies
          referenced herein, are the entire agreement between you and Ithas Fire
          concerning the Platform. If any provision is found unenforceable, the
          remaining provisions remain in full force. Our failure to enforce a
          provision is not a waiver of the right to enforce it later. You may
          not assign these Terms; we may assign them to a successor in
          connection with a merger, acquisition, or sale of assets.
        </p>
      </LegalSection>

      <LegalSection title="20. Contact">
        <p>
          Questions about these Terms? Reach us at{" "}
          <TextLink href="mailto:legal@ithasfire.com">
            legal@ithasfire.com
          </TextLink>
          . Mailing address available on request.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

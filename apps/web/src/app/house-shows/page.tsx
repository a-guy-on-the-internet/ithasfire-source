import type { Metadata } from "next";

import {
  LegalPage,
  LegalSection,
  LegalList,
  TextLink,
} from "@/components/layout/PagePrimitives";

export const metadata: Metadata = {
  title: "House Shows — FAQ & Legal Guide",
  description:
    "Everything performers and hosts need to know about running house shows, DIY events, and private gatherings — donations, capacity, noise, insurance, and more.",
};

export default function HouseShowFaqPage() {
  return (
    <LegalPage title="House Shows" updatedAt="October 2026">
      <LegalSection title="What this page is">
        <p>
          This is a plain-language guide for performers and hosts who use
          Ithas Fire to run house shows, living room concerts, backyard gigs,
          and other private events. It covers the most common legal questions we
          hear.{" "}
          <strong>This is educational information, not legal advice.</strong>{" "}
          Laws vary by city, county, and state. If you need legal counsel,
          consult an attorney licensed in your jurisdiction.
        </p>
      </LegalSection>

      <LegalSection title="Donations vs. tickets">
        <p>
          Most house shows operate on a &ldquo;suggested donation&rdquo; model
          rather than selling tickets at a fixed price. The distinction matters
          because many local entertainment and amusement tax codes only apply to
          events that charge admission. A voluntary contribution — where
          attendees can pay any amount including zero — is generally not
          considered a ticket sale.
        </p>
        <p>
          Ithas Fire supports this through <strong>adjustable pricing</strong>:
          you set an optional minimum and a suggested amount, and the attendee
          chooses what to pay. There is no enforced price.
        </p>
        <p>
          That said, &ldquo;suggested donation&rdquo; is not a magic phrase. If
          entry is conditional on payment, regulators may treat it as admission
          regardless of how it is labeled. To stay on the right side of the
          line:
        </p>
        <LegalList>
          <li>Never turn someone away for not paying.</li>
          <li>Make clear that the contribution is voluntary.</li>
          <li>Do not advertise a fixed ticket price for the event.</li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Zoning and land use">
        <p>
          Residential properties are generally zoned for residential use. A
          one-off gathering of friends is not a zoning issue. Regular, publicly
          advertised events with paid entry can cross into &ldquo;commercial
          use&rdquo; territory depending on your municipality.
        </p>
        <p>
          In practice, most house shows fly under the radar because they are
          small, infrequent, and private. Risks increase when:
        </p>
        <LegalList>
          <li>Events are large (50+ people) or frequent (weekly).</li>
          <li>Neighbors file noise complaints.</li>
          <li>The property is a rental and the lease prohibits events.</li>
          <li>Events are publicly advertised on social media.</li>
        </LegalList>
        <p>
          Ithas Fire&apos;s <strong>private event</strong> and{" "}
          <strong>hidden address</strong> features help limit public exposure.
          Attendees only see the address after they RSVP, and private events are
          never indexed in search or shown in public listings.
        </p>
      </LegalSection>

      <LegalSection title="Capacity and fire code">
        <p>
          Most residential occupancy limits are not formally enforced for
          private gatherings, but fire codes still apply. As a general
          guideline, most living rooms and basements can safely hold 30-40
          people. Once you exceed 49 occupants in a single room, many
          jurisdictions classify the space as an &ldquo;assembly
          occupancy,&rdquo; which triggers additional requirements (marked
          exits, fire extinguishers, occupancy permits).
        </p>
        <p>
          Keep crowds manageable. Use Ithas Fire&apos;s capacity setting to cap
          attendance and avoid overselling.
        </p>
      </LegalSection>

      <LegalSection title="Noise">
        <p>
          Noise ordinances vary by city but almost universally apply to
          residential areas. Most municipalities measure in decibels at the
          property line, and many have stricter limits after 10 PM.
        </p>
        <p>
          <strong>Nashville specific:</strong> Metro Code 11.12.070 sets
          residential noise limits at 75 dBA at the property line during the day
          and 65 dBA at night (after 10 PM). Violations can result in fines.
        </p>
        <p>Practical tips:</p>
        <LegalList>
          <li>Keep windows and doors closed during performances.</li>
          <li>End amplified music by a reasonable hour.</li>
          <li>Acoustic sets are almost never a problem.</li>
          <li>
            Give neighbors a heads-up — most complaints come from surprise, not
            volume.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="Alcohol">
        <p>
          <strong>Do not sell alcohol at a house show.</strong> Selling alcohol
          without a license is a criminal offense in every US state. This
          includes &ldquo;suggested donations&rdquo; for drinks, charging a
          cover that includes drinks, or any arrangement where payment is
          exchanged for alcohol.
        </p>
        <p>
          BYOB (bring your own) is generally fine for private gatherings. The
          host is not selling or serving — guests are consuming what they
          brought. However, the host may still have social host liability if an
          intoxicated guest causes harm after leaving. Some states (including
          Tennessee) have social host liability statutes.
        </p>
        <p>
          If you want to serve alcohol, you need a temporary event permit or a
          licensed caterer. This is typically not worth the cost or complexity
          for a house show.
        </p>
      </LegalSection>

      <LegalSection title="Insurance">
        <p>
          Your homeowner&apos;s or renter&apos;s insurance likely does not cover
          injuries to event attendees, especially if the gathering could be
          considered a commercial activity. If someone trips on your stairs and
          breaks an arm, you could be personally liable.
        </p>
        <p>
          Event liability insurance is inexpensive and available for one-off
          events. Providers that cover house concerts and small private events
          include:
        </p>
        <LegalList>
          <li>
            <strong>The Event Helper</strong> — from ~$60 for a single event,
            covers general liability up to $1M.
          </li>
          <li>
            <strong>Thimble</strong> — on-demand event insurance, can purchase
            day-of.
          </li>
          <li>
            <strong>GatherGuard</strong> — designed for private gatherings and
            house parties.
          </li>
        </LegalList>
        <p>
          We strongly recommend event insurance for any gathering over 20 people
          or any event involving amplified sound equipment.
        </p>
      </LegalSection>

      <LegalSection title="Tax obligations">
        <p>
          Money received at house shows — whether labeled as donations,
          contributions, or ticket sales — is taxable income. This applies to
          both the host (if they keep any of the money) and performers (for
          their share).
        </p>
        <LegalList>
          <li>
            Track all income and expenses. Ithas Fire provides transaction
            records for every event.
          </li>
          <li>
            If you receive $600 or more from a single payer in a calendar year,
            expect a 1099.
          </li>
          <li>
            &ldquo;Donations&rdquo; to an individual are not tax-deductible for
            the giver — only donations to registered 501(c)(3) nonprofits
            qualify.
          </li>
          <li>
            Performers can deduct ordinary business expenses (travel, equipment,
            strings) against performance income.
          </li>
        </LegalList>
        <p>
          <strong>Nashville specific:</strong> Davidson County levies a 9.25%
          amusement tax on admission charges (T.C.A. &sect; 67-6-212). Voluntary
          donations where entry is not conditioned on payment are generally not
          subject to this tax, but the line is fact-specific. Consult a tax
          professional if you are running regular paid events in Nashville.
        </p>
      </LegalSection>

      <LegalSection title="Waivers">
        <p>
          A liability waiver does not make you immune from lawsuits, but it
          significantly strengthens your legal position. Courts generally
          enforce waivers for voluntary recreational activities as long as the
          language is clear and the signer had a genuine choice.
        </p>
        <p>
          Ithas Fire supports <strong>checkout waivers</strong> — when enabled,
          attendees must accept the waiver before completing their RSVP. The
          acceptance is timestamped and stored with the order. Hosts can
          customize the waiver text or use the platform default.
        </p>
        <p>A good house show waiver should state:</p>
        <LegalList>
          <li>
            The event is held at a private residence, not licensed premises.
          </li>
          <li>The attendee voluntarily assumes the risk of attending.</li>
          <li>
            The host is not responsible for injury, loss, or damage except in
            cases of gross negligence.
          </li>
        </LegalList>
      </LegalSection>

      <LegalSection title="PRO licensing (ASCAP, BMI, SESAC)">
        <p>
          Performance Rights Organizations license public performances of
          copyrighted music. The key word is &ldquo;public.&rdquo; A private
          gathering in a home is generally not considered a public performance
          under copyright law (17 U.S.C. &sect; 101).
        </p>
        <p>
          A performance is &ldquo;public&rdquo; when it occurs at a place open
          to the public or where a substantial number of people outside the
          normal circle of family and friends are gathered. A house show with 30
          invited guests is almost certainly private. A 200-person backyard
          festival advertised on Instagram is almost certainly public.
        </p>
        <p>
          If your events are growing to the point where PRO licensing is a
          concern, you are probably also hitting capacity and zoning thresholds
          — and it may be time to find a proper place.
        </p>
      </LegalSection>

      <LegalSection title="What Ithas Fire is and isn't">
        <p>
          Ithas Fire is a technology platform that provides ticketing, RSVP
          management, and discovery tools. We do not organize, produce, host, or
          control any events listed on the platform. The event organizer is
          solely responsible for their event, their place, and compliance with
          all applicable laws.
        </p>
        <p>
          We built these features — adjustable pricing, private events, hidden
          addresses, checkout waivers — because we believe house shows and
          community events deserve the same tools that big clubs and theatres
          get. We want to make it easier to do this well, not to tell you how
          to do it.
        </p>
        <p>
          For full details, see our{" "}
          <TextLink href="/terms">Terms of Service</TextLink>.
        </p>
      </LegalSection>

      <LegalSection title="Precedent and context">
        <p>
          House shows have a long and rich history in American independent
          music. Platforms like Sofar Sounds, Concerts in Your Home, and
          Groupmuse have operated in this space for years. The DIY house show
          circuit — from 924 Gilman Street to the punk basements of the Midwest
          — is a foundational part of the indie music ecosystem.
        </p>
        <p>
          Ithas Fire exists to serve this community with honest tools and
          transparent pricing. If you have questions not covered here, reach out
          at <TextLink href="/contact">ithasfire.com/contact</TextLink>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

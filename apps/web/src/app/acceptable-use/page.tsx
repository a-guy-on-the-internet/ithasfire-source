import type { Metadata } from "next";

import {
  LegalPage,
  LegalSection,
  LegalList,
  TextLink,
} from "@/components/layout/PagePrimitives";

export const metadata: Metadata = {
  title: "Acceptable Use Policy",
  description:
    "What you can host on Ithas Fire, the limits our payment partners require, and how we enforce them.",
};

export default function AcceptableUsePage() {
  return (
    <LegalPage title="Acceptable Use Policy" updatedAt="[EFFECTIVE DATE]">
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
        [DRAFT — REQUIRES REVIEW BY QUALIFIED COUNSEL BEFORE PUBLICATION]
      </div>

      <LegalSection title="The short version">
        <p>
          Ithas Fire exists because live, independent art deserves a ticketing
          platform that isn&rsquo;t trying to squeeze it. We host almost
          anything that real artists and organisers actually do — the loud
          stuff, the dark stuff, the stuff that makes someone&rsquo;s aunt
          nervous. That&rsquo;s the scene. We&rsquo;re not here to sanitise it.
        </p>
        <p>
          So read the rest of this in that spirit. The limits below aren&rsquo;t
          us being squeamish about your art. They exist because Ithas Fire
          processes real money for you: we are the merchant of record on your
          sales, and we&rsquo;re bound by the rules of our payment partners —
          the card networks (Visa, Mastercard, and others) and our processor,
          Stripe. Those rules apply to us whether we like every one of them or
          not, and if we break them, the whole platform loses the ability to
          take payments for everyone. So a handful of things are off-limits
          here, and they&rsquo;re listed plainly below.
        </p>
        <p>
          This Acceptable Use Policy (&ldquo;<strong>AUP</strong>&rdquo;) is part
          of our{" "}
          <TextLink href="/terms">Terms of Service</TextLink>, and you agreed to
          it when you signed up to sell tickets. If anything here is unclear,
          ask us before you list — we&rsquo;d rather talk it through than take
          something down.
        </p>
      </LegalSection>

      <LegalSection title="What's welcome here">
        <p>
          Let&rsquo;s be direct, because a lot of platforms leave this vague on
          purpose: <strong>edgy is fine.</strong> Provocative is fine. Political
          is fine. Offensive-to-somebody is fine. The line we draw is at{" "}
          <strong>illegal</strong>, not at &ldquo;might upset a stranger.&rdquo;
        </p>
        <p>Concretely, all of this is welcome on Ithas Fire:</p>
        <LegalList>
          <li>
            Horror, gore, and graphic or disturbing imagery — noise shows,
            splatter film nights, haunted-house theatre, the works.
          </li>
          <li>
            Punk, metal, hardcore, and any music with confrontational,
            transgressive, or violent-sounding lyrics or artwork.
          </li>
          <li>
            Political and protest events across the spectrum, including angry,
            uncomfortable, or unpopular speech.
          </li>
          <li>
            Dark, crude, blue, or button-pushing comedy — including material
            that&rsquo;s deliberately offensive as an act.
          </li>
          <li>
            Suggestive, sensual, or body-positive performance — drag, burlesque,
            and theatrical adult-adjacent art (see the note under adult content
            below for where the payment-network line falls).
          </li>
          <li>
            House shows, DIY spaces, warehouse gigs, and unconventional places.
          </li>
        </LegalList>
        <p>
          If your event is legal and it&rsquo;s a genuine event — real art, a
          real show, a real gathering that people are buying a real ticket to
          attend — it almost certainly belongs here. The rest of this document
          is about the narrow set of things our payment partners won&rsquo;t
          let us process, full stop.
        </p>
      </LegalSection>

      <LegalSection title="What we can't allow">
        <p>
          Everything in this section is a <strong>flowdown</strong> — a rule
          that reaches us from the card networks and Stripe and that we have to
          pass on to you as a condition of processing your payments. Some of
          these are stricter than the law in your area. That&rsquo;s not us
          moralising; it&rsquo;s the price of being able to take cards at all.
          Where we have room to use judgement, we will, and we&rsquo;ll say so.
        </p>

        <p style={{ fontWeight: 700 }}>Adult content and adult businesses</p>
        <p>
          Pornography and sexually explicit material produced for sexual
          gratification can&rsquo;t be sold or accessed through the Platform.
          Neither can adult-oriented businesses and services — that includes
          escort or companionship services, strip clubs and adult-entertainment
          places operating as such, adult live-chat or cam services, and similar
          adult businesses.
        </p>
        <p>
          <strong>The burlesque / adult-revue gray zone:</strong> we know a lot
          of real, artful performance lives near this line, and we don&rsquo;t
          want to lose it. Theatrical or artful adult-adjacent performance —
          burlesque, drag, sensual or body-positive stage work — may be reviewed
          by us <strong>case by case</strong>, and a lot of it is perfectly
          fine to sell tickets to here. What we can&rsquo;t host is the
          explicitly adult <em>business</em>: events that are, in substance, a
          sale of sexual services or sexually explicit material rather than a
          performance. When in doubt, describe your event to us honestly before
          you list and we&rsquo;ll tell you where it lands.
        </p>
        <p>
          One practical heads-up on <strong>images</strong>: our processor runs
          automated content screening on listing images and scores them for
          nudity. Explicit or fully nude imagery will trip that threshold and
          get flagged for removal even when the performance itself would be
          fine. If your show is on the artful side of the line, keep your{" "}
          <em>public listing art</em> suggestive rather than explicit — cover
          the parts a card network won&rsquo;t — and the event can still run.
          If a legitimate image gets auto-flagged, tell us and we&rsquo;ll
          review it by hand.
        </p>

        <p style={{ fontWeight: 700 }}>
          Promotion of unlawful or hate-based violence
        </p>
        <p>
          We can&rsquo;t host content or organisations that promote, encourage,
          or celebrate <strong>unlawful violence</strong> — including violence
          targeting people because of their race, religion, disability, gender,
          sexual orientation, national origin, or other immutable
          characteristics.
        </p>
        <p>
          Read that carefully, because it is narrow on purpose. This targets{" "}
          <strong>incitement to unlawful violence</strong> and{" "}
          <strong>hate-based violence</strong> — real calls to hurt real people,
          and organising built around that. It is <em>not</em> a rule against
          political speech, offensive art, violent imagery, or provocative
          performance, all of which remain welcome as described above. A horror
          show is not a hate group. An angry protest is not incitement. We know
          the difference, and we&rsquo;ll apply this to the substance of what
          you&rsquo;re actually organising, not the vibe of your flyer.
        </p>
        <p>
          Same heads-up as with images above: our processor runs automated
          screening that scores content for hate, and imagery or copy that reads
          as a genuine hate signal — the actual symbols and slurs of
          hate-based violence, used as such — can get auto-flagged. Reclaimed,
          critical, satirical, or in-context artistic use is welcome, but if
          your public listing leans on that kind of imagery it may get flagged
          and land in front of a human. If that happens to legitimate work, tell
          us and we&rsquo;ll review it.
        </p>

        <p style={{ fontWeight: 700 }}>Cannabis and CBD</p>
        <p>
          Cannabis, CBD, and related businesses can&rsquo;t sell or transact
          through the Platform, and events can&rsquo;t be cannabis-branded or
          involve on-site cannabis sales or vending — even where cannabis is
          legal locally. This is a hard line from our payment partners, not a
          position of ours on the plant.
        </p>

        <p style={{ fontWeight: 700 }}>Firearms and weapons</p>
        <p>
          No sale of firearms, ammunition, weapons, or related parts through the
          Platform, and no events whose prize, giveaway, or draw is a firearm or
          weapon.
        </p>

        <p style={{ fontWeight: 700 }}>
          Gambling, raffles, and games of chance
        </p>
        <p>
          Raffles, sweepstakes, lotteries, contests, and games of chance or
          skill that award a monetary or material prize can&rsquo;t run through
          the Platform&rsquo;s payment flow. This includes selling entries,
          tickets, or chances tied to a prize draw.
        </p>
        <p>
          One exception we&rsquo;ll look at: legitimate{" "}
          <strong>charitable fundraising raffles</strong> may be permitted{" "}
          <strong>subject to review</strong> and to the rules that apply to
          charitable gaming where you operate. If that&rsquo;s what
          you&rsquo;re running, talk to us first so we can review it rather than
          having it pulled after the fact.
        </p>

        <p style={{ fontWeight: 700 }}>
          Fake, ambiguous, or disguised transfers
        </p>
        <p>
          Every charge on Ithas Fire has to correspond to a{" "}
          <strong>real ticket, a real good, or a bona fide donation.</strong>{" "}
          You can&rsquo;t use the Platform&rsquo;s checkout to move money that
          isn&rsquo;t buying anything — no fake &ldquo;tickets&rdquo; that
          exist only to route funds, no ambiguous transfers, no using the
          payment flow as a general-purpose way to send yourself or someone else
          money. Genuine donation and pay-what-you-can flows are fine; disguised
          money movement is not.
        </p>

        <p>
          This list isn&rsquo;t exhaustive of everything the card networks
          restrict, and our payment partners can change their rules. If
          something you&rsquo;re planning isn&rsquo;t named here but is clearly
          in the same family, assume it needs a conversation first.
        </p>
      </LegalSection>

      <LegalSection title="How we enforce this">
        <p>
          Because Ithas Fire is the merchant of record on your sales, the
          chargebacks, refund liability, and the relationship with Stripe and
          the card networks all sit with us. That means when a rule here is
          broken, we have to be able to act — quickly, and sometimes before
          money has fully moved. So, at our discretion, we may:
        </p>
        <LegalList>
          <li>
            <strong>Remove or unpublish</strong> a listing, event, image, or any
            content that violates this AUP.
          </li>
          <li>
            <strong>Hold, freeze, delay, or reverse a payout</strong> connected
            to a violating event, or where we reasonably need to while we review
            — including to cover refunds or chargeback exposure we&rsquo;re
            carrying as merchant of record.
          </li>
          <li>
            <strong>Suspend, restrict, or terminate</strong> an organiser
            account, and decline to onboard an organiser in the first place.
          </li>
          <li>
            <strong>Refund buyers</strong> where an event can&rsquo;t or
            shouldn&rsquo;t proceed on the Platform.
          </li>
          <li>
            <strong>Cooperate with legal obligations</strong> — responding to
            lawful requests, and reporting where we&rsquo;re required to.
          </li>
        </LegalList>
        <p>
          Some of this starts with a machine. Ithas Fire and our processor run{" "}
          <strong>automated content screening</strong> that scores listings and
          images — nudity and hate are the two thresholds that matter most — and
          content that scores over the line gets flagged automatically. An
          auto-flag isn&rsquo;t a verdict: it routes the item to us, and where a
          legitimate event or image gets caught, a human can and will clear it.
          If something of yours is flagged unfairly, say so and we&rsquo;ll look.
        </p>
        <p>
          Beyond that, we&rsquo;ll aim to be a human about it: where we
          reasonably can, we&rsquo;ll tell you what the problem is and give you a
          chance to fix it or move a borderline event into review. But some
          situations — legal risk, fraud, active payment-partner exposure — mean
          we act first and explain after.
        </p>
        <p>
          Two things to be clear about. First,{" "}
          <strong>enforcement is at Ithas Fire&rsquo;s discretion</strong> under
          this AUP and the{" "}
          <TextLink href="/terms">Terms of Service</TextLink>. Second,{" "}
          <strong>
            being legal somewhere doesn&rsquo;t guarantee you access to the
            Platform.
          </strong>{" "}
          Our payment partners&rsquo; rules can be — and often are — stricter
          than the law where you operate, and we&rsquo;re bound by the stricter
          of the two.
        </p>
      </LegalSection>

      <LegalSection title="Reporting a violation">
        <p>
          If you see an event, listing, or image on Ithas Fire that you think
          crosses one of the lines above, tell us. Anyone can report — you
          don&rsquo;t need an account, and you don&rsquo;t need to be involved
          with the event.
        </p>
        <p>
          Email{" "}
          <TextLink href="mailto:[TRUST_AND_SAFETY_EMAIL]">
            [TRUST_AND_SAFETY_EMAIL]
          </TextLink>{" "}
          with a link to the event or listing and a short note on what the
          problem is. Screenshots help but aren&rsquo;t required.
        </p>
        <p>
          We commit to reviewing reports and acting on the ones that hold up.
          We&rsquo;ll weigh what&rsquo;s actually being organised, not just how
          it looks on a flyer — and we&rsquo;ll keep in mind that edgy art is
          the point of this place, not a bug in it.
        </p>
      </LegalSection>

      <LegalSection title="Changes to this policy">
        <p>
          We may update this AUP as our payment partners&rsquo; rules change or
          as we learn from running the Platform. When we make a material change,
          we&rsquo;ll update the effective date below and, where appropriate,
          give organisers notice. Continuing to sell tickets on Ithas Fire after
          a change means you accept the updated policy.
        </p>
        <p style={{ fontSize: 14 }}>
          <strong>Effective date:</strong> [EFFECTIVE DATE]
        </p>
        <p style={{ fontSize: 14 }}>
          Ithas Fire is operated by Hearthfire LLC, a Delaware limited liability
          company. This AUP is governed by [GOVERNING LAW / JURISDICTION] and is
          incorporated into our{" "}
          <TextLink href="/terms">Terms of Service</TextLink>. See also our{" "}
          <TextLink href="/privacy">Privacy Policy</TextLink>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

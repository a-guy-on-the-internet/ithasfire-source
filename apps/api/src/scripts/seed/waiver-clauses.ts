import type { PrismaClient } from "@prisma/client";

/**
 * Waiver Clause Library — Platform-maintained risk paragraphs.
 *
 * Three-layer architecture:
 *   STRUCTURAL: Always included, never toggleable (6 clauses)
 *   RISK_SPECIFIC: Toggleable by organizer, auto-selected by event properties (12 clauses)
 *
 * Legal basis: Copeland v. HealthSouth (Tenn. 2018) three-factor test.
 * See docs/specs/2026-04-19/waiver-clause-library.spec.md
 */

export type ClauseSeed = {
  slug: string;
  title: string;
  body: string;
  category:
    | "STRUCTURAL"
    | "VENUE"
    | "ACTIVITY"
    | "SUBSTANCE"
    | "LEGAL"
    | "GENERAL";
  layer: "STRUCTURAL" | "RISK_SPECIFIC";
  isRequired: boolean;
  isDefault: boolean;
  sortOrder: number;
  voidInStates?: string[];
  requiredInStates?: string[];
  autoSelectRules?: Array<{ field: string; operator: string; value: string }>;
};

// ── STRUCTURAL CLAUSES (Layer 1) ────────────────────────────────────────────

const STRUCTURAL_CLAUSES: ClauseSeed[] = [
  {
    slug: "released-parties-definition",
    title: "Definitions",
    body: `DEFINITIONS. As used in this Waiver, "Released Parties" means the event organizer(s), the property owner(s), and their respective parents, subsidiaries, affiliates, successors and assigns, and each of their respective officers, directors, employees, agents, volunteers, members, sponsors, independent contractors, vendors, insurers, and property and premises lessors. "Event" means the event described on the ticket or RSVP confirmation associated with this Waiver.`,
    category: "STRUCTURAL",
    layer: "STRUCTURAL",
    isRequired: true,
    isDefault: true,
    sortOrder: 10,
  },
  {
    slug: "core-release",
    title: "Release and Waiver of Liability",
    body: `RELEASE AND WAIVER OF LIABILITY. In consideration of being permitted to attend or participate in the Event, I, for myself, my heirs, next of kin, spouse, personal representatives, assigns, and estate, to the fullest extent permitted by law, HEREBY RELEASE, WAIVE, DISCHARGE, AND COVENANT NOT TO SUE the Released Parties from any and all claims, demands, causes of action, or liabilities of any kind, including those arising from the ordinary negligence of any of the Released Parties, for any personal injury, illness, death, property loss, or other damages arising out of my attendance at or participation in the Event.`,
    category: "STRUCTURAL",
    layer: "STRUCTURAL",
    isRequired: true,
    isDefault: true,
    sortOrder: 20,
    voidInStates: ["LA", "VA"],
  },
  {
    slug: "core-assumption-of-risk",
    title: "Voluntary Assumption of Risk",
    body: `VOLUNTARY ASSUMPTION OF RISK. I acknowledge that attending this Event involves inherent risks that may result in personal injury, illness, death, or property damage. These risks include but are not limited to: the actions and conduct of other attendees, performers, vendors, and staff; environmental conditions; equipment failure; and hazards of the venue. I understand these risks and voluntarily assume full responsibility for any injuries, damages, or losses that may occur as a result of my attendance, whether or not caused by the ordinary negligence of the Released Parties.`,
    category: "STRUCTURAL",
    layer: "STRUCTURAL",
    isRequired: true,
    isDefault: true,
    sortOrder: 30,
  },
  {
    slug: "gross-negligence-footer",
    title: "Scope and Limitations",
    body: `SCOPE AND LIMITATIONS. This Waiver applies only to claims arising from ordinary negligence. Nothing in this Waiver releases, waives, or limits liability for gross negligence, recklessness, willful or wanton misconduct, intentional wrongdoing, fraud, or any statutory violation that cannot be waived under applicable law.`,
    category: "STRUCTURAL",
    layer: "STRUCTURAL",
    isRequired: true,
    isDefault: true,
    sortOrder: 900,
  },
  {
    slug: "severability-reformation",
    title: "Severability",
    body: `SEVERABILITY. If any provision of this Waiver is found to be unenforceable, invalid, or void under applicable law, that provision shall be modified, narrowed, and blue-penciled to the minimum extent necessary to make it valid and enforceable. The remaining provisions shall continue in full force and effect. The parties intend that the ordinary-negligence release and assumption of risk constitute the minimum enforceable protection of this Waiver.`,
    category: "LEGAL",
    layer: "STRUCTURAL",
    isRequired: true,
    isDefault: true,
    sortOrder: 910,
  },
  {
    slug: "governing-law-tn",
    title: "Governing Law (Tennessee)",
    body: `GOVERNING LAW AND VENUE. This Waiver shall be governed by and construed in accordance with the laws of the State of Tennessee. Any disputes arising from this Waiver or my attendance at the Event shall be resolved exclusively in the state or federal courts located in Davidson County, Tennessee.`,
    category: "LEGAL",
    layer: "STRUCTURAL",
    isRequired: true,
    isDefault: true,
    sortOrder: 920,
  },
];

// ── RISK-SPECIFIC CLAUSES (Layer 2) ─────────────────────────────────────────

const RISK_SPECIFIC_CLAUSES: ClauseSeed[] = [
  {
    slug: "private-residential",
    title: "Private Residential Property",
    body: `PRIVATE RESIDENTIAL PROPERTY. I understand that this Event takes place at a private residential property that is not a licensed commercial venue. The property has not been inspected or approved for public assembly by any government authority. I accept the property in its current condition, including any hazards related to: stairs, porches, and decks without code-compliant handrails; uneven floors and thresholds; limited or residential-only lighting; residential electrical systems; absence of commercial fire suppression, sprinklers, or fire alarms; limited egress points and exits; household pets; and general conditions of a private home not designed for public gatherings.`,
    category: "VENUE",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: true,
    sortOrder: 100,
    autoSelectRules: [
      // Any obscured-location event (obfuscated circle or fully hidden) —
      // legacy HIDDEN collapsed into OBSCURED (location-visibility-reveal).
      { field: "locationMode", operator: "eq", value: "OBSCURED" },
      { field: "visibility", operator: "eq", value: "PRIVATE" },
    ],
  },
  {
    slug: "outdoor-event",
    title: "Outdoor Event",
    body: `OUTDOOR EVENT. I understand that this Event takes place partially or entirely outdoors. I accept the risks associated with outdoor conditions, including but not limited to: uneven, unpaved, or natural terrain; exposure to weather including heat, cold, rain, wind, lightning, and sun; insects, ticks, and wildlife; limited or no shelter; natural obstacles; and reduced visibility after dark. I am responsible for wearing appropriate clothing and footwear, monitoring weather conditions, and removing myself from unsafe conditions.`,
    category: "VENUE",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: false,
    sortOrder: 110,
  },
  {
    slug: "non-traditional-venue",
    title: "Non-Traditional Venue",
    body: `NON-TRADITIONAL VENUE. I understand that this Event takes place at a non-traditional venue that may not meet the standards of a licensed commercial event space. The venue may have limited accessibility, non-standard restroom facilities, absence of ADA-compliant features, non-commercial electrical and plumbing systems, and conditions that differ from a professional event environment. I accept these conditions and assume the associated risks.`,
    category: "VENUE",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: false,
    sortOrder: 120,
  },
  {
    slug: "amplified-sound",
    title: "Amplified Sound and Hearing Risk",
    body: `AMPLIFIED SOUND. I understand that this Event involves amplified sound, live music, or recorded music at sound-pressure levels that routinely exceed 85 decibels at live-music events and may cause temporary or permanent hearing damage, tinnitus, or other auditory injury. I am solely responsible for protecting my own hearing, including the use of earplugs or other hearing protection devices. The Released Parties recommend but do not require the use of hearing protection.`,
    category: "ACTIVITY",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: true,
    sortOrder: 200,
  },
  {
    slug: "physical-activity",
    title: "Physical Activity",
    body: `PHYSICAL ACTIVITY. I understand that this Event involves physical activity, which may include but is not limited to: dancing, standing for extended periods, movement in crowded or confined spaces, participation in interactive or immersive performances, and navigating stairs or uneven surfaces. I accept the risk of physical exertion, fatigue, contact with other attendees, slips, trips, and falls.`,
    category: "ACTIVITY",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: false,
    sortOrder: 210,
  },
  {
    slug: "fire-pyrotechnics",
    title: "Fire, Candles, or Pyrotechnic Elements",
    body: `FIRE AND PYROTECHNICS. I understand that this Event may involve open flames, candles, fire performance, fireworks, sparklers, or other pyrotechnic elements. I accept the risks of burns, smoke inhalation, sparks, and fire-related injury. I will maintain a safe distance from all fire elements, follow all safety instructions provided by the organizer and any certified pyrotechnic operators, and immediately comply with any evacuation instruction.`,
    category: "ACTIVITY",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: false,
    sortOrder: 220,
  },
  {
    slug: "crowding",
    title: "Crowded Conditions",
    body: `CROWDED CONDITIONS. I understand that this Event may involve crowded conditions with limited personal space. I accept the risks associated with close proximity to other attendees, including but not limited to: physical contact, compression, limited mobility, difficulty exiting, elevated temperatures, and crowd movement or surges. I will immediately comply with any evacuation, shelter, or move-back instruction from event staff.`,
    category: "ACTIVITY",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: false,
    sortOrder: 230,
  },
  {
    slug: "byob-alcohol",
    title: "Alcohol Present (BYOB)",
    body: `ALCOHOL. I understand that alcoholic beverages may be present at this Event on a bring-your-own basis. No alcohol is sold, served, or provided by the event organizer or the Released Parties. I accept full responsibility for my own alcohol consumption and resulting behavior. I represent that I am at least 21 years of age if I choose to consume alcohol. I will not provide alcohol to any person under the legal drinking age. I will arrange safe transportation from the Event if I consume alcohol and will not operate a motor vehicle while impaired. I agree to indemnify and hold harmless the Released Parties from any claim, demand, or liability arising from my alcohol consumption or from my providing alcohol to any other person at the Event.`,
    category: "SUBSTANCE",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: false,
    sortOrder: 300,
  },
  {
    slug: "smoke-fog",
    title: "Smoke or Fog Effects",
    body: `SMOKE AND FOG. I understand that this Event may involve theatrical smoke, fog machines, haze, incense, or similar atmospheric effects. These may aggravate respiratory conditions including asthma and COPD. I accept this risk and will remove myself from the affected area if I experience discomfort or respiratory difficulty.`,
    category: "SUBSTANCE",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: false,
    sortOrder: 310,
  },
  {
    slug: "medical-acknowledgment",
    title: "Medical Acknowledgment",
    body: `MEDICAL. I certify that I am physically able to attend this Event and have not been advised against participation by a medical professional. I agree to be financially responsible for any medical costs incurred as a result of injury or illness during the Event. If I am unable to provide consent at the time of need, I authorize the Released Parties to summon emergency medical services on my behalf. The Released Parties may but are not obligated to provide first-aid personnel or equipment at the Event. The presence of any medical personnel does not guarantee any particular standard or speed of response. Attendees remain responsible for their own medical decisions.`,
    category: "GENERAL",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: true,
    sortOrder: 400,
  },
  {
    slug: "photo-media",
    title: "Photo and Media Release",
    body: `PHOTO AND MEDIA. I consent to being photographed, filmed, or recorded (including audio and video capture of my voice and likeness) during this Event. I grant the event organizer a non-exclusive, royalty-free, perpetual right to use my likeness and voice in event documentation, promotion, and social media, excluding AI-generated synthetic reproductions of my likeness or voice. I understand I may decline by notifying the organizer in writing before the Event begins, and that photo-free accommodations may be available upon request.`,
    category: "GENERAL",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: false,
    sortOrder: 410,
  },
  {
    slug: "minor-notice",
    title: "Notice Regarding Minors",
    body: `MINORS. This Waiver applies to adult attendees age 18 and older. If I am the parent or legal guardian of a minor attending this Event, I acknowledge that I am responsible for their safety and supervision throughout the Event. I understand that under the laws of Tennessee and most US states, a parent or guardian cannot waive a minor child's right to pursue legal claims for personal injury. This Waiver does not purport to waive any such claims on behalf of any minor. I personally assume the risks described herein with respect to my own attendance, and I agree to indemnify the Released Parties for claims arising from my minor child's conduct that causes injury or damage to third parties.`,
    category: "GENERAL",
    layer: "RISK_SPECIFIC",
    isRequired: false,
    isDefault: false,
    sortOrder: 420,
  },
];

export const ALL_CLAUSES = [...STRUCTURAL_CLAUSES, ...RISK_SPECIFIC_CLAUSES];

// ── Platform disclaimer (appended to every assembled waiver) ────────────────

export const PLATFORM_DISCLAIMER: ClauseSeed = {
  slug: "platform-disclaimer-footer",
  title: "Platform Disclaimer",
  body: `This document was assembled by the event organizer using the Ithas Fire platform. Ithas Fire, Inc. is a software provider and did not draft this specific document. Ithas Fire does not provide legal advice and makes no representation regarding the enforceability of this Waiver in any jurisdiction. Use of the Ithas Fire waiver tool does not create an attorney-client relationship. Organizers are responsible for ensuring compliance with applicable laws in their jurisdiction.`,
  category: "LEGAL",
  layer: "STRUCTURAL",
  isRequired: true,
  isDefault: true,
  sortOrder: 999,
};

/**
 * Seed the waiver clause library.
 */
export async function seedWaiverClauses(prisma: PrismaClient) {
  console.log("Seeding waiver clause library...");

  const allClauses = [...ALL_CLAUSES, PLATFORM_DISCLAIMER];
  let created = 0;
  let updated = 0;

  for (const clause of allClauses) {
    const { autoSelectRules, ...data } = clause;

    const existing = await prisma.waiverClause.findUnique({
      where: { slug: clause.slug },
    });

    if (existing) {
      await prisma.waiverClause.update({
        where: { slug: clause.slug },
        data: {
          title: data.title,
          body: data.body,
          category: data.category,
          layer: data.layer,
          isRequired: data.isRequired,
          isDefault: data.isDefault,
          sortOrder: data.sortOrder,
          voidInStates: data.voidInStates ?? [],
          requiredInStates: data.requiredInStates ?? [],
        },
      });
      updated++;
    } else {
      const created_clause = await prisma.waiverClause.create({
        data: {
          slug: data.slug,
          title: data.title,
          body: data.body,
          category: data.category,
          layer: data.layer,
          isRequired: data.isRequired,
          isDefault: data.isDefault,
          sortOrder: data.sortOrder,
          voidInStates: data.voidInStates ?? [],
          requiredInStates: data.requiredInStates ?? [],
        },
      });

      // Create auto-select rules
      if (autoSelectRules?.length) {
        for (const rule of autoSelectRules) {
          await prisma.waiverClauseAutoRule.create({
            data: {
              clauseId: created_clause.id,
              field: rule.field,
              operator: rule.operator,
              value: rule.value,
            },
          });
        }
      }

      created++;
    }
  }

  console.log(
    `  Waiver clauses: ${created} created, ${updated} updated (${allClauses.length} total)`,
  );
}

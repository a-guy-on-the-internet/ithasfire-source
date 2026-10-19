"use client";

import { YStack } from "tamagui";

import { MembershipStandingsView } from "./_components/MembershipStandingsView";
import { RecurringRevenueSection } from "./_components/RecurringRevenueSection";
import {
  MembershipsLeavingSection,
  MembershipsNeedingAttentionSection,
} from "./_components/MembershipPositionsSection";

// ─────────────────────────────────────────────────────────────────────────────
// /platform/memberships — VISIBILITY first, RISK second.
//
// This page used to be seven lines rendering only `MembershipStandingsView`:
// suspension and rolling reserve, which is the answer to "is somebody
// defrauding us". Useful, and not the question anyone opens this page with.
// There was no view of the memberships THEMSELVES — not what they are worth,
// not which ones are broken, not who is about to leave — so `past_due` (a
// status that DENIES benefits at checkout) was watched by nothing at all.
//
// Order is deliberate: what the book is worth, then what is wrong with it,
// then who is leaving, then the risk tools. Risk sits last because it is the
// rarest thing anyone comes here to do and the only destructive one.
// ─────────────────────────────────────────────────────────────────────────────

export default function PlatformMembershipsPage() {
  return (
    <YStack>
      {/* Its own padded block: `MembershipStandingsView` brings its own
          `padding="$4"`, so wrapping the whole page in one would double the
          horizontal inset on that half. */}
      <YStack gap="$6" padding="$4">
        <RecurringRevenueSection />
        <MembershipsNeedingAttentionSection />
        <MembershipsLeavingSection />
      </YStack>
      <MembershipStandingsView />
    </YStack>
  );
}

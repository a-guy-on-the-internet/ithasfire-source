"use client";

import { YStack } from "tamagui";

import { AdminEmailVerificationGate } from "@/components/auth/AdminEmailVerificationGate";
import { AdminPageHeader } from "../_components/AdminPageHeader";
import { SellView } from "./_components/SellView";

/**
 * The box office — the screen an operator runs all night at a door.
 *
 * A thin shell on purpose: the behaviour lives in `SellView` so it can be
 * exercised without a route, the same split the scan page uses.
 */
export default function AdminSellPage() {
  return (
    <AdminEmailVerificationGate mode="block">
      <YStack
        gap="$4"
        flex={1}
        // Vertical padding only on a phone: the admin shell's frame already
        // pads the sides 24px, and a second 16px here left the sale summary
        // 206px at a 320px screen, too narrow for label | Card | Cash.
        paddingVertical="$4"
        paddingHorizontal={0}
        $gtSm={{ paddingHorizontal: "$4" }}
        maxWidth={1024}
        marginHorizontal="auto"
        width="100%"
      >
        <AdminPageHeader
          title="Sell"
          subtitle="Ring up walk-ups at the door — card, cash or comp."
        />
        <SellView />
      </YStack>
    </AdminEmailVerificationGate>
  );
}

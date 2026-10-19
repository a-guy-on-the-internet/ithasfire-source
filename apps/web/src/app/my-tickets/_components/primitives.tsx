"use client";

import type { ReactNode } from "react";
import { Stack, XStack, YStack, styled } from "tamagui";

import { Text } from "@th/ui";

/** Shared skeleton block. Same pulse the rest of the app uses. */
export const SkeletonPulse = styled(Stack, {
  name: "SkeletonPulse",
  backgroundColor: "$surfaceMuted",
  borderRadius: 0,
  animation: "th-skeleton-pulse 1.8s ease-in-out infinite",
});

/** v2 kicker index numeral — decorative, so aria-hidden. fontSize bumped to
 *  14 to sit optically next to the section headings (override noted per the
 *  page-pass checklist; matches the home-pilot section-number pattern). */
export const SectionNum = ({ children }: { children: ReactNode }) => (
  <Text
    variant="kicker"
    tone="accent"
    weight="bold"
    aria-hidden
    fontSize={14}
    minWidth={28}
  >
    {children}
  </Text>
);

/**
 * A numbered section of the page: rule, index numeral, uppercase label, body.
 *
 * The `num` is passed IN, never derived here — the host assigns numbers
 * top-to-bottom over the sections that actually render (design-system-v2 §8).
 * A section that hardcodes its own number is how `/my-tickets` once shipped a
 * past-only wallet reading a lone "02 PAST" with no 01 above it.
 */
export const NumberedSection = ({
  num,
  label,
  headingId,
  testId,
  children,
}: {
  num: string;
  label: string;
  /** Ties the section's body to its heading for assistive tech. */
  headingId?: string;
  testId?: string;
  children: ReactNode;
}) => (
  <YStack
    gap="$3"
    borderTopWidth={2}
    borderTopColor="$borderColor"
    paddingTop="$4"
    {...(testId ? { "data-testid": testId } : {})}
  >
    <XStack gap="$2" alignItems="baseline">
      <SectionNum>{num}</SectionNum>
      <Text
        variant="h4"
        tag="h2"
        id={headingId}
        weight="bold"
        tone="muted"
        textTransform="uppercase"
        letterSpacing={1}
      >
        {label}
      </Text>
    </XStack>
    {children}
  </YStack>
);

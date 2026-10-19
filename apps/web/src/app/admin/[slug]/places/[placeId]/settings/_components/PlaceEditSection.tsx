"use client";

import type { ReactNode } from "react";
import { XStack, YStack } from "tamagui";
import { Text } from "@th/ui";

/**
 * One named group of the place editor's main column.
 *
 * The editor used to be a flat stack of four anonymous bordered boxes, so a
 * reader had to infer the grouping from the fields themselves. This is the
 * same LOCAL panel convention that stack already used — bordered YStack,
 * `borderWidth 2`, `$borderColor`, `$surface`, `radius 0` — with a heading
 * added. Deliberately NOT `@th/ui`'s `Card`, which is an opinionated
 * eyebrow/title/description/stats organism rather than a generic panel.
 *
 * The heading is `overline` (Montserrat, uppercase, 2px tracking, 700) so it
 * outranks the sentence-case `bodySmall`/bold FIELD labels inside without
 * competing with the page's h2. `tag="h3"` keeps the document outline honest
 * under the page heading — the visual scale and the semantic level are set
 * independently on purpose.
 */
export type PlaceEditSectionProps = {
  title: string;
  children: ReactNode;
  /** Marks the heading as the label of a `<section>` for screen readers. */
  headingId: string;
  /**
   * Make the heading a JUMP TARGET for the venue settings section index:
   * `tabIndex={-1}` so the index can move focus onto it, plus the
   * `data-settings-anchor` hook globals.css uses for its scroll margin and
   * focus ring. Off by default so a heading nobody jumps to never becomes
   * programmatically focusable.
   */
  anchor?: boolean;
  /**
   * Trailing content on the heading's row — a status badge or a link out
   * (the settings boards put one on Verification and on Public page). The
   * row wraps, so a long label drops under the heading instead of pushing
   * the panel wider than a phone.
   */
  headerAside?: ReactNode;
};

export function PlaceEditSection({
  title,
  children,
  headingId,
  anchor = false,
  headerAside,
}: PlaceEditSectionProps) {
  const heading = (
    <Text
      variant="overline"
      weight="bold"
      tag="h3"
      id={headingId}
      {...(anchor
        ? { tabIndex: -1, "data-settings-anchor": "" }
        : {})}
    >
      {title}
    </Text>
  );

  return (
    <YStack
      tag="section"
      aria-labelledby={headingId}
      gap="$4"
      padding="$4"
      borderWidth={2}
      borderColor="$borderColor"
      borderRadius={0}
      backgroundColor="$surface"
    >
      {headerAside ? (
        <XStack
          justifyContent="space-between"
          alignItems="center"
          gap="$3"
          flexWrap="wrap"
        >
          {heading}
          {headerAside}
        </XStack>
      ) : (
        heading
      )}
      {children}
    </YStack>
  );
}

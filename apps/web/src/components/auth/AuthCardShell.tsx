"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import { Stack, XStack, YStack, useThemeName } from "tamagui";

import { CardSurface, Text, elevationTokens, useTranslations } from "@th/ui";

/**
 * The auth card is a PANEL with a step band.
 *
 * It used to be dressed as a ticket stub — head register, brand mark, mono
 * serial, dashed tear, die-cut punches. The costume said "this is a ticket"
 * on a surface that is not one, and the serial (`ACCESS · 01`, `VERIFY · 02`)
 * was carrying the flow's step count in a form nobody reads as a step count.
 * What replaces it says the same thing literally: a segmented band across the
 * top edge, and one mono line naming where the reader is.
 *
 * This file deliberately owns none of the panel CONTENT — every auth panel
 * (sign-in, sign-up, verify, 2FA, reset) renders into it and inherits the
 * chrome, so the flow has one card and not six.
 *
 * ## The card is INK
 *
 * The panel is the theme's inverted surface, printed on the cream page. The
 * colour work is NOT here: `[data-auth-card]` in `apps/web/src/app/globals.css`
 * rebinds the semantic tokens for this subtree, because the app-wide
 * `input:…` rule is (0,6,1) and no Tamagui style prop can outrank it. Read
 * that block before changing anything about a colour on an auth panel — this
 * file only sets the two values the shell paints itself.
 */

/**
 * Where the reader is in a flow.
 *
 * Two kinds, because the flows have two shapes:
 *
 * - `counted` — a flow declares its length up front and never changes it.
 *   Sign-in is two, sign-up is four, recovery is two.
 * - `interruption` — a panel that fires only sometimes (the 2FA challenge).
 *   It gets no number, because numbering it would make the total change
 *   underneath the reader mid-flow. It takes the amber `support` band, which
 *   is the one place on this surface the support colour earns its keep.
 */
export type AuthCardStep =
  | { kind: "counted"; index: number; total: number; name: string }
  | { kind: "interruption"; name: string };

/** Band segment height, and the gap between segments. Raw px, not tokens —
 *  `$` space tokens start at 4 and step by 4, so 3 has no rung, and the
 *  fractional token forms (`$0.75`) are the ones with the known Tamagui
 *  rounding bug. */
const SEGMENT_HEIGHT = 4;
const SEGMENT_GAP = 3;

/**
 * The unfilled segment: the panel's own foreground at 24%.
 *
 * On the ink card `--color` is PAPER, so this is cream-on-ink, not the
 * ink-on-cream it started as — 16% of ink over ink would have been nothing at
 * all. 45%, measured: at 24% the unfilled half sat at 2.15:1 on the ink card
 * and read as nothing — a two-segment band that shows only its filled half
 * cannot say "1 of 2". 45% clears the 3:1 a meaningful graphic owes while
 * still losing decisively to the flame it is the ground for. Raised from the
 * specimen's 20% because the band is the card's top
 * edge and has to survive a phone in daylight; it owes no contrast floor of
 * its own (`aria-hidden`, and the mono line beneath states the same fact in
 * words), so this is a legibility choice, not a compliance one.
 *
 * `color-mix` rather than a hex with an alpha suffix — concatenating alpha
 * onto a `var()` produces invalid CSS (v2 §4), and there is no semantic token
 * at this weight. The fallback is Stub's `--color`, which is what SSR paints
 * before the theme snapshot lands on `<body>`.
 */
const SEGMENT_EMPTY =
  "color-mix(in srgb, var(--color, #211C16) 45%, transparent)";

/**
 * The step band — line work, and nothing but.
 *
 * `aria-hidden` on purpose: it is `total` empty boxes with no text in them, so
 * to a screen reader it is either noise or nothing. The mono line underneath
 * is the real, readable statement of the same fact, and it is NOT hidden.
 *
 * That split is also what makes `$accent` legal here. #E2481D on the card's
 * ink surface (#211C16) is 4.17:1 — under the 4.5:1 small-text floor, over the
 * 3:1 floor for a graphic. As a bar it clears; as the label it would not,
 * which is why the label takes `$support` instead.
 */
const StepBand = ({ step }: { step: AuthCardStep }) => {
  const t = useTranslations();

  const segments =
    step.kind === "counted"
      ? Array.from({ length: step.total }, (_, i) => ({
          key: i,
          // 1-based `index`: every segment up to AND INCLUDING the current one
          // is filled, so the terminal panel of a flow fills the band rather
          // than resetting it — "done" reads as done.
          filled: i + 1 <= step.index,
        }))
      : [{ key: 0, filled: true }];

  return (
    <YStack width="100%" flexShrink={0}>
      <XStack aria-hidden width="100%" gap={SEGMENT_GAP}>
        {segments.map(({ key, filled }) => (
          <Stack
            key={key}
            flex={1}
            minWidth={0}
            height={SEGMENT_HEIGHT}
            backgroundColor={
              step.kind === "interruption"
                ? "$support"
                : filled
                  ? "$accent"
                  : SEGMENT_EMPTY
            }
          />
        ))}
      </XStack>

      {/* Sits on the body's content grid — same horizontal padding, so the
          step name lines up with the panel's h1 directly under it. */}
      <YStack
        width="100%"
        paddingHorizontal="$5"
        paddingTop="$3"
        $gtSm={{ paddingHorizontal: "$7" }}
      >
        <Text variant="overline" color="$colorMuted">
          {step.kind === "counted" ? (
            <>
              {/* `checkout.stepProgress` is "Step {current} of {total}" and is
                  translated in both catalogs. Borrowed rather than duplicated
                  under `auth.*`: the string is generic, and a second copy of
                  it would be a second thing to keep translated. */}
              {String(
                t("checkout.stepProgress", {
                  current: step.index,
                  total: step.total,
                }),
              )}
              {" · "}
              {/* `$support`, NOT `$accentText`. On cream the step name was
                  the accent pulled to label legibility; on ink that token
                  travels the WRONG WAY — #A8300F is 2.49:1 there, darker than
                  the accent it deepens. Amber is this surface's designated
                  label hue (7.87:1), the same one the focus ring takes. */}
              <Text variant="overline" color="$support">
                {step.name}
              </Text>
            </>
          ) : (
            step.name
          )}
        </Text>
      </YStack>
    </YStack>
  );
};

export type AuthCardShellProps = {
  testId: string;
  /** Optional content rendered above the main card body. */
  header?: ReactNode;
  /**
   * Where this panel sits in its flow. Drives the band across the top edge and
   * the mono line under it. Omitted on panels that are not part of a numbered
   * flow at all (the reset-password link landing, the mock panels).
   */
  step?: AuthCardStep;
  children: ReactNode;
  /**
   * Tightens top/bottom padding for dense form views (e.g. sign-up form
   * expanded). Horizontal padding stays the same so the card chrome
   * remains visually consistent with sibling views.
   */
  compactVerticalPadding?: boolean;
};

/** Shared auth-card chrome — the panel every auth card is printed on. */
export const AuthCardShell = ({
  testId,
  header,
  step,
  children,
  compactVerticalPadding = false,
}: AuthCardShellProps) => {
  const themeName = useThemeName();

  // The hard offset print shadow is the brand's single most identifying
  // property. Stub is `4px 4px 0` ink; Ember/Swiss are flat ("none" — borders
  // carry structure there). It survives the ink flip unchanged: the shadow is
  // the card's OWN colour offset onto the cream page, so it still reads at
  // 14.89:1 — it just stops looking like a shadow and starts looking like the
  // card is a printing plate that slipped.
  //
  // Consumed via `useThemeName()` and applied as an
  // INLINE style because `CardSurface` hard-sets `elevation: 0` /
  // `shadowColor: transparent`, and a multi-part CSS shadow string has no
  // React Native equivalent to set as a prop. Same pattern as `EventCard`.
  const shadow = useMemo(() => {
    const elevation =
      elevationTokens[themeName as keyof typeof elevationTokens] ??
      elevationTokens.ember;
    return elevation.card;
  }, [themeName]);

  return (
    <CardSurface
      data-testid={testId}
      // The hook the auth-scoped CSS in `globals.css` hangs off. It is not a
      // test id and not a style prop: the rule it enables has to BEAT the
      // global `input:…:focus { border-color: var(--accent) }` block, whose
      // (0,6,1) selector already out-specifies anything Tamagui compiles from
      // a style prop. An attribute selector is the only lever that reaches it
      // without reopening the app-wide input styling.
      data-auth-card=""
      width="100%"
      maxWidth={480}
      // The panel is the theme's INVERTED surface — ink (#211C16) on Stub —
      // sitting on the cream page at 14.89:1. Never transparent: a see-through
      // auth card was the defect this rebuild exists to fix.
      //
      // `$backgroundInverted` and not `$surface`, even though the rebind above
      // points `--surface` at the same value: the shell should say what it
      // paints. The rebind is for the descendants that cannot say it —
      // including the native `<input>`s, which no style prop can reach.
      //
      // The border is the SAME ink as the fill, which is not a no-op — it
      // holds the 2px geometry the shell's padding and its offset shadow are
      // measured against, and it keeps the panel one token away from being a
      // paper card again. `$borderColor` would be wrong here twice over: the
      // rebind makes it paper (correct for the CONTROLS on the panel, a bright
      // frame around the panel itself), and a paper edge against the cream
      // page would erase the card's outline entirely.
      backgroundColor="$backgroundInverted"
      borderColor="$backgroundInverted"
      borderWidth={2}
      borderRadius={0}
      // Padding lives on the body (and on the step band's label) so the band
      // itself can run flush from border to border.
      padding={0}
      gap={0}
      overflow="hidden"
      style={shadow === "none" ? undefined : { boxShadow: shadow }}
    >
      {step ? <StepBand step={step} /> : null}

      <YStack
        width="100%"
        paddingHorizontal="$5"
        // The band already spends 12px + a 14px line above the body, so the
        // body's own top padding steps down one rung when it is present —
        // otherwise the panel's h1 sat 60px below the step line that names it.
        paddingTop={compactVerticalPadding ? "$3" : step ? "$4" : "$5"}
        paddingBottom={compactVerticalPadding ? "$3" : "$5"}
        gap="$4"
        $gtSm={{
          paddingHorizontal: "$7",
          paddingTop: compactVerticalPadding ? "$4" : step ? "$5" : "$7",
          paddingBottom: compactVerticalPadding ? "$4" : "$7",
        }}
      >
        {header}
        {children}
      </YStack>
    </CardSurface>
  );
};

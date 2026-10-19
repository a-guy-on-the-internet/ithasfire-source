import { forwardRef } from "react";

import { Text as UiText, type TextProps as UiTextProps } from "@th/ui";

import { useColors } from "./theme";

/**
 * The native `Text`.
 *
 * A thin wrapper over `@th/ui`'s `Text` that keeps the whole variant / weight /
 * letterSpacing / textTransform API and re-points `tone` at `useColors()`.
 *
 * ## Why this exists (FR-009)
 *
 * Every RN screen was importing `Text` from `@th/ui` directly while importing
 * every other token from `@th/ui-native` — two import surfaces for one visual
 * vocabulary. It is NOT broken today: `App.tsx` binds `IthasFireProvider
 * theme={name}` to the native theme, so Tamagui's `$color` and
 * `useColors().color` resolve to the same value. This is hygiene, and it makes
 * the coupling explicit rather than incidental: if the provider wiring ever
 * drifts, `tone="muted"` here keeps agreeing with `colors.colorMuted` because
 * it literally IS `colors.colorMuted`.
 *
 * The typography scale is deliberately NOT forked — `variant` still resolves
 * through `@th/ui`, so Montserrat, the size ramp and the weight tokens stay in
 * exactly one place.
 *
 * ## `numberOfLines` / `ellipsizeMode`
 *
 * `@th/ui`'s `TextProps` `Omit`s both (it exposes `truncate` for the 1-line
 * case only), but the underlying Tamagui `Paragraph` renders an RN `Text` on
 * native and honours them. The FR-003 verdict state needs a 2-line holder name
 * with a tail ellipsis, so they are re-declared here and forwarded through a
 * narrow cast. This is the same escape hatch `app-shell.tsx` already uses
 * inline; centralising it means one cast in the package instead of one per
 * call site.
 */

/** Tones resolved from the ACTIVE native palette. */
export type NativeTextTone =
  | "default"
  | "muted"
  | "inverted"
  | "accent"
  | "success"
  | "warning"
  | "danger";

/**
 * ## Why `emphasis` is omitted, not merely discouraged
 *
 * `@th/ui`'s `TextProps` carries `emphasis` (`muted` → opacity 0.8, `subtle` →
 * 0.65). On a full-bleed tone fill that is an unmeasurable hazard rather than a
 * style choice: `emphasis="subtle"` on the FAIL pair (`onVerdictFail` over
 * `verdictFail`) composites to 3.34:1 — the "secondary line on the verdict"
 * reflex the design bans — and the contrast guard
 * (`apps/scanner/src/__tests__/tone-contrast.test.ts`) checks TOKEN PAIRS, so
 * it cannot see an alpha applied at the call site.
 *
 * The Design System's own `.if-verdict__state` carries `opacity: .85`. We drop
 * it for the same reason (see `./tone.ts`'s `TonePair`): full opacity costs
 * nothing here and removes a question nobody re-measures.
 *
 * Hierarchy on this surface comes from size and weight, never opacity. Omitting
 * the prop makes that rule unreachable instead of merely documented; a
 * component that genuinely needs a softer rung asks `useColors()` for
 * `colorMuted` by name.
 */
export type NativeTextProps = Omit<UiTextProps, "tone" | "emphasis"> & {
  tone?: NativeTextTone;
  /** Max lines before truncation. Forwarded to the underlying RN `Text`. */
  numberOfLines?: number;
  ellipsizeMode?: "head" | "middle" | "tail" | "clip";
};

export const Text = forwardRef<unknown, NativeTextProps>(
  ({ tone = "default", color, numberOfLines, ellipsizeMode, ...rest }, ref) => {
    const colors = useColors();

    /**
     * `accent`/`warning`/`danger` map to the TEXT rungs (`accentText`,
     * `warningSoft`, `dangerSoft`), not the fill rungs. The fill values are
     * graphic-floor colours: `accent` as copy is 3.57:1 on Stub's cream and
     * `danger` as copy is ~4.0:1 on Ember's surface. A component that wants a
     * fill value asks `useColors()` for it by name.
     */
    const toneColor: Record<NativeTextTone, string> = {
      default: colors.color,
      muted: colors.colorMuted,
      inverted: colors.colorInverted,
      accent: colors.accentText,
      success: colors.success,
      warning: colors.warningSoft,
      danger: colors.dangerSoft,
    };

    const lineProps = {
      ...(numberOfLines === undefined ? {} : { numberOfLines }),
      ...(ellipsizeMode === undefined ? {} : { ellipsizeMode }),
    } as Record<string, unknown>;

    return (
      <UiText
        ref={ref as never}
        color={color ?? toneColor[tone]}
        {...lineProps}
        {...rest}
      />
    );
  },
);

Text.displayName = "NativeText";

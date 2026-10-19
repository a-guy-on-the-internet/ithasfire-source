"use client";

import type { ComponentProps, ReactNode } from "react";
import { Button, Spinner, useTranslations } from "@th/ui";
import { XStack } from "tamagui";

import { AppleLogo, GoogleLogo } from "./oauth-logos";

export type OAuthProviderButtonsProps = {
  /** Whether any auth action is in progress — disables both buttons. */
  disabled?: boolean;
  /** Which provider (if any) has a pending OAuth redirect. */
  loading: "google" | "apple" | null;
  /** Fires when the user taps a provider button. */
  onPress: (provider: "google" | "apple") => void;
  /** Test-id prefix applied to each button (e.g. "auth-sign-in"). */
  testIdPrefix?: string;
  /**
   * Layout props spread onto the pair's row — this component's layout lever,
   * so no card's arrangement is hard-coded in here.
   *
   * It used to fold the pair into a THREE-peer row (`flex: 2` beside the
   * passkey's `flex: 1`) above `$gtXs`. Measured at 1440: three `$4` buttons
   * across a 480px card cannot hold a glyph plus its label, and both providers
   * ellipsised to `GOO…` / `APP…` — the 1+2 break that fixes it was gated to
   * the phone breakpoint, where the problem is smallest. Both cards now pass
   * a plain full-width row at every width and let the passkey own its own
   * line, so the pair only ever splits ONE row two ways.
   */
  containerProps?: ComponentProps<typeof XStack>;
};

type ProviderButtonProps = {
  testId: string;
  label: string;
  accessibleName: string;
  glyph: ReactNode;
  /** Another auth path is mid-flight — this button is inert. */
  blocked: boolean;
  /** THIS provider's redirect is in flight. */
  pending: boolean;
  onPress: () => void;
};

/**
 * One provider peer.
 *
 * ## The label is the Button atom's own, not a `<Text>` child
 *
 * The first cut of the de-vendoring put `<Text variant="overline">` inside each
 * button, which rendered the label in IBM Plex Mono at 11px inside a 44px
 * frame: undersized against its own button, and the only mono button label
 * anywhere in the product (v2 §6 puts button labels on Montserrat 700 / +1.5px
 * tracking; the mono idiom is for labels ABOUT things, not for the things
 * themselves). Passing the label as a bare string child hands it to
 * `ButtonText`, which already carries that grammar — and takes the
 * `tone="inherit"` question off the table entirely, because the atom sets
 * `color: inherit` on its own label on web.
 *
 * ## Why the inset is tight and `space` is zero
 *
 * The binding case is 320px: a 296px card leaves 244px of content, so each
 * half of this row is 116px, and `GOOGLE` at the atom's 12px/700/+1.5px needs
 * 63 of them. `ellipse` on Tamagui's `ButtonText` truncates rather than
 * wrapping, so running out is silent — the label just says `GOO…`.
 *
 * `$1` (4px) inset against the `$4` size's own `$5` (24px) buys most of it.
 * `space={0}` buys the rest, and is the non-obvious half: Tamagui's Button
 * inserts a real `is_Spacer` ELEMENT between children *in addition to* the CSS
 * `gap` its size variant already sets, so a glyph+label button pays for the
 * separation twice. Measured at 320 before either change: 4px border + 48px
 * inset + 16px mark + 8px gap + 11.88px spacer + 8px gap left the label 20px
 * against the 63 `GOOGLE` needs, which is the `GOO…` that shipped.
 *
 * With both, and at the 20px mark the brand asked for, the 320 button's 104px
 * content box holds 20 + 8 + 63 = 91, leaving **12.94px** free. Verified by
 * growing the mark live until the ellipsis engaged: 20/22/24 hold, 26 truncates
 * — so the shipped size sits ~5px under the cliff, and a metric shift or a
 * longer translation degrades rather than truncating on day one. If you enlarge
 * the mark again, re-measure at 320 before believing it.
 *
 * The inset is only ever REACHED under that squeeze — the content is centred,
 * so at any comfortable width the padding is slack and the button looks
 * identical to a `$5`-inset one.
 *
 * ## Pending is not disabled
 *
 * v2: a loading control stays at FULL opacity and says so with `aria-busy`;
 * `disabled` would dim (opacity .45) the very spinner that IS the feedback. So
 * the pending button takes `aria-busy` + `aria-disabled` and guards its own
 * press, which is exactly the escape hatch the Button atom documents. Its peer
 * still takes a real `disabled`.
 */
const ProviderButton = ({
  testId,
  label,
  accessibleName,
  glyph,
  blocked,
  pending,
  onPress,
}: ProviderButtonProps) => (
  <Button
    data-testid={testId}
    aria-label={accessibleName}
    variant="secondary"
    size="$4"
    flex={1}
    flexBasis={0}
    minWidth={0}
    paddingHorizontal="$1"
    // Drops the duplicate `is_Spacer` element; the size variant's CSS `gap`
    // still separates the mark from the label. See the note above.
    space={0}
    disabled={pending ? undefined : blocked}
    aria-busy={pending ? true : undefined}
    aria-disabled={pending ? true : undefined}
    onPress={() => {
      if (pending || blocked) return;
      onPress();
    }}
  >
    {pending ? <Spinner size="sm" /> : glyph}
    {label}
  </Button>
);

/**
 * The two provider buttons, de-vendored.
 *
 * These used to be a `#4285F4` Google slab and a `#000000` Apple slab with
 * white labels — the loudest, most off-palette elements on the whole auth
 * surface (no blue exists anywhere in the Stub palette). Neither brand's
 * guidelines require the slab; what identifies the vendor is the MARK.
 *
 * So both take the shared `secondary` grammar — ink outline that inverts to an
 * ink fill on hover — and keep the glyph in full brand colour. Google's mark is
 * multicolour by definition; Apple's rides `currentColor` so it inverts with
 * the frame.
 */
export const OAuthProviderButtons = ({
  disabled = false,
  loading,
  onPress,
  testIdPrefix = "auth",
  containerProps,
}: OAuthProviderButtonsProps) => {
  const t = useTranslations();

  return (
    <XStack gap="$3" {...containerProps}>
      <ProviderButton
        testId={`${testIdPrefix}-google`}
        label={String(t("auth.lcGoogle"))}
        accessibleName={String(t("auth.lcContinueGoogle"))}
        glyph={<GoogleLogo size={20} />}
        blocked={disabled}
        pending={loading === "google"}
        onPress={() => onPress("google")}
      />

      <ProviderButton
        testId={`${testIdPrefix}-apple`}
        label={String(t("auth.lcApple"))}
        accessibleName={String(t("auth.lcContinueApple"))}
        glyph={<AppleLogo size={20} />}
        blocked={disabled}
        pending={loading === "apple"}
        onPress={() => onPress("apple")}
      />
    </XStack>
  );
};

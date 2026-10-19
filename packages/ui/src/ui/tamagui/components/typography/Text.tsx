import { forwardRef } from "react";
import { Platform } from "react-native";
import {
  Paragraph,
  type GetProps,
  type ParagraphProps,
  type TamaguiElement,
} from "tamagui";

const isWeb = Platform.OS === "web";

const toneColorMap = {
  /**
   * Web-only escape hatch: paint nothing of our own and let the label track an
   * ancestor's CSS colour through all its rungs. Its reason for existing is the
   * Button atom — `hoverStyle`/`pressStyle` colours only ever land on the FRAME,
   * so a self-painting label silently keeps its resting colour through hover and
   * press (on `outlined` that rendered #B93312 text on the #B93312 hover fill:
   * a 1:1 label, i.e. a blank orange rectangle).
   *
   * `inherit` is a CSS keyword and NOT a valid React Native colour — RN has no
   * View→Text style inheritance for it to name. The Button atom gates its own
   * `textProps.color` on web, but the TONE is reachable from any call site, and
   * two already live in this cross-platform package (NavigationDrawer,
   * NotificationInbox). Native therefore degrades to ink rather than handing RN
   * a colour it cannot parse.
   */
  inherit: isWeb ? "inherit" : "$color",
  default: "$color",
  muted: "$colorMuted",
  inverted: "$colorInverted",
  accent: "$accent",
  brandPrimary: "$brandPrimary",
  brandSecondary: "$brandSecondary",
  success: "$success",
  info: "$info",
  warning: "$warning",
  error: "$danger",
} as const;

const weightMap = {
  regular: "400",
  medium: "500",
  semibold: "600",
  bold: "700",
  black: "900",
} as const;

const emphasisOpacity = {
  normal: 1,
  muted: 0.8,
  subtle: 0.65,
} as const;

const blockDisplayVariants = new Set<TextVariant>([
  "subtitle",
  "body",
  "bodySmall",
]);

type TextTone = keyof typeof toneColorMap;
type TextWeight = keyof typeof weightMap;
type TextEmphasis = keyof typeof emphasisOpacity;

export type TextVariant =
  | "display"
  | "h1"
  | "h2"
  | "h3"
  | "h4"
  | "h5"
  | "h6"
  | "subtitle"
  | "body"
  | "label"
  | "bodySmall"
  | "caption"
  | "overline"
  | "kicker"
  | "code"
  | "span";

interface VariantConfig {
  readonly tag: ParagraphProps["tag"];
  readonly fontFamily: string;
  readonly fontSize: ParagraphProps["fontSize"];
  readonly lineHeight?: ParagraphProps["lineHeight"];
  readonly letterSpacing?: ParagraphProps["letterSpacing"];
  readonly textTransform?: ParagraphProps["textTransform"];
  readonly defaultWeight: TextWeight;
}

const variantConfig: Record<TextVariant, VariantConfig> = {
  // v2 weights: display is Black (900), h1–h3 are Bold (700) — matches
  // typographyTokens (display/heading). h4–h6 stay medium: they're compact
  // structural headings, not display type.
  display: {
    tag: "h1",
    fontFamily: "$heading",
    fontSize: "$10",
    lineHeight: "$10",
    letterSpacing: -0.5,
    textTransform: "uppercase",
    defaultWeight: "black",
  },
  h1: {
    tag: "h1",
    fontFamily: "$heading",
    fontSize: "$9",
    lineHeight: "$9",
    letterSpacing: -0.4,
    textTransform: "uppercase",
    defaultWeight: "bold",
  },
  h2: {
    tag: "h2",
    fontFamily: "$heading",
    fontSize: "$8",
    lineHeight: "$8",
    letterSpacing: -0.3,
    textTransform: "uppercase",
    defaultWeight: "bold",
  },
  h3: {
    tag: "h3",
    fontFamily: "$heading",
    fontSize: "$7",
    lineHeight: "$7",
    letterSpacing: -0.25,
    textTransform: "uppercase",
    defaultWeight: "bold",
  },
  h4: {
    tag: "h4",
    fontFamily: "$heading",
    fontSize: "$6",
    lineHeight: "$6",
    letterSpacing: -0.2,
    textTransform: "uppercase",
    defaultWeight: "medium",
  },
  h5: {
    tag: "h5",
    fontFamily: "$heading",
    fontSize: "$5",
    lineHeight: "$5",
    letterSpacing: -0.15,
    textTransform: "uppercase",
    defaultWeight: "medium",
  },
  h6: {
    tag: "h6",
    fontFamily: "$heading",
    fontSize: "$4",
    lineHeight: "$4",
    letterSpacing: -0.1,
    textTransform: "uppercase",
    defaultWeight: "medium",
  },
  subtitle: {
    tag: "span",
    fontFamily: "$heading",
    fontSize: "$4",
    lineHeight: "$4",
    letterSpacing: -0.05,
    defaultWeight: "medium",
  },
  label: {
    tag: "span",
    fontFamily: "$heading",
    fontSize: "$3",
    lineHeight: "$3",
    letterSpacing: -0.05,
    defaultWeight: "medium",
  },
  body: {
    tag: "span",
    fontFamily: "$body",
    fontSize: "$3",
    lineHeight: "$3",
    defaultWeight: "regular",
  },
  bodySmall: {
    tag: "span",
    fontFamily: "$body",
    fontSize: "$2",
    lineHeight: "$2",
    defaultWeight: "regular",
  },
  caption: {
    tag: "span",
    fontFamily: "$body",
    fontSize: "$1",
    lineHeight: "$1",
    defaultWeight: "regular",
  },
  // v2 label idiom — IBM Plex Mono, the `sm` rung of the mono ladder
  // (11px / 2px tracking / 600). Reinstated 2026-08-26; this was Montserrat
  // between the 2026-07-28 Montserrat-only sweep and now. Size and tracking
  // are the pair from `monoScale.sm` — neither half travels alone.
  overline: {
    tag: "span",
    fontFamily: "$mono",
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 2,
    textTransform: "uppercase",
    defaultWeight: "semibold",
  },
  // v2 kicker — the wider-tracked editorial variant of the label idiom, for
  // the eyebrow line above a headline. IBM Plex Mono 600 at 3px tracking
  // (`labelIdioms.kicker`); pair with tone="accent". The mono treatment was
  // retired in the 2026-07-28 Montserrat-only sweep and reinstated 2026-08-26.
  // Stays an inline span (kickers sit above headings; callers own layout and
  // set the tone themselves).
  kicker: {
    tag: "span",
    fontFamily: "$mono",
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 3,
    textTransform: "uppercase",
    defaultWeight: "semibold",
  },
  // Genuine code-like content. Rides the same $mono face as the label idioms
  // above; the two-site allowlist that used to pin $mono is gone, because mono
  // is a brand font again rather than a per-OS fallback to be contained.
  code: {
    tag: "code",
    fontFamily: "$mono",
    fontSize: "$3",
    lineHeight: "$3",
    defaultWeight: "regular",
  },
  span: {
    tag: "span",
    fontFamily: "$body",
    fontSize: "$3",
    lineHeight: "$3",
    defaultWeight: "regular",
  },
};

export interface TextProps extends Omit<
  GetProps<typeof Paragraph>,
  "color" | "opacity" | "numberOfLines" | "ellipsizeMode"
> {
  variant?: TextVariant;
  tone?: TextTone;
  weight?: TextWeight;
  emphasis?: TextEmphasis;
  truncate?: boolean;
  testId?: string;
  qaId?: string;
  color?: ParagraphProps["color"];
}

export const Text = forwardRef<TamaguiElement, TextProps>(
  (
    {
      variant = "body",
      tone = "default",
      weight,
      fontWeight,
      emphasis = "normal",
      truncate = false,
      testId,
      qaId,
      style,
      color,
      tag,
      fontFamily,
      fontSize,
      lineHeight,
      letterSpacing,
      textTransform,
      ...rest
    },
    ref,
  ) => {
    const automationProps = isWeb
      ? {
          ...(testId ? { "data-testid": testId } : {}),
          ...(qaId ? { "data-qa": qaId } : {}),
        }
      : {
          ...(testId ? { testID: testId } : {}),
          ...(qaId ? { accessibilityLabel: qaId } : {}),
        };

    const config = variantConfig[variant] ?? variantConfig.body;
    const resolvedWeight = weight ?? config.defaultWeight;
    const resolvedColor = color ?? toneColorMap[tone] ?? toneColorMap.default;
    const resolvedOpacity = emphasisOpacity[emphasis] ?? emphasisOpacity.normal;

    const variantProps: Partial<ParagraphProps> = {
      fontFamily: fontFamily ?? config.fontFamily,
      fontSize: fontSize ?? config.fontSize,
      lineHeight: lineHeight ?? config.lineHeight,
      letterSpacing: letterSpacing ?? config.letterSpacing,
      tag: tag ?? config.tag,
    };

    const resolvedTextTransform = textTransform ?? config.textTransform;
    const providedStyleArray = Array.isArray(style)
      ? style
      : style
        ? [style]
        : [];
    const blockDisplayStyle =
      isWeb && !tag && blockDisplayVariants.has(variant)
        ? { display: "block" as const }
        : null;
    const truncateStyle =
      truncate && isWeb
        ? {
            whiteSpace: "nowrap" as const,
            overflow: "hidden" as const,
            textOverflow: "ellipsis" as const,
          }
        : null;

    const mergedStyle = [
      {
        fontWeight:
          fontWeight ?? weightMap[resolvedWeight] ?? weightMap.regular,
      },
      resolvedTextTransform ? { textTransform: resolvedTextTransform } : null,
      blockDisplayStyle,
      ...providedStyleArray,
      truncateStyle,
    ].filter(Boolean) as ParagraphProps["style"];

    const truncateProps = truncate
      ? {
          numberOfLines: 1 as const,
          ellipsizeMode: "tail" as const,
        }
      : undefined;

    return (
      <Paragraph
        ref={ref}
        opacity={resolvedOpacity}
        color={resolvedColor}
        {...variantProps}
        {...automationProps}
        {...truncateProps}
        style={mergedStyle}
        {...rest}
      />
    );
  },
);

Text.displayName = "Text";

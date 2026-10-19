import { memo } from "react";
import type { ReactNode } from "react";
import { Platform } from "react-native";
import { Stack, XStack, YStack, styled, type GetProps } from "tamagui";

import { Text } from "../typography/Text";

/**
 * Ticket — the object an attendee presents at the door.
 *
 * **Landscape, with the stub on the right.** Body left, a narrow tear-off stub
 * right, separated by a vertical dashed perforation with die-cut punch holes at
 * its top and bottom. That is the shape of a real ticket, and it is what makes
 * this recognisable at a gate from two metres away. Below 520px the grid
 * re-declares to a single column and the stub moves under the body — the tear
 * turns horizontal and the holes move to the sides. Nothing is ever hidden.
 *
 * **One object, two renderings.** `medium` changes treatment, never content or
 * proportions: same markup, same facts, same order. An attendee comparing
 * their phone to their printout has to see the same ticket, which is the whole
 * reason this is one component rather than two.
 *
 * | `medium` | what changes |
 * |---|---|
 * | `screen` | hard offset shadow, dashed perforation, die-cut punch holes |
 * | `print`  | no shadow, solid divider, no punch holes, code renders larger |
 *
 * **The facts are fixed and ordered** — when, where, tier, holder, seat — and
 * they sit in an auto-fit grid so two fit per row at full width and one per row
 * when the ticket narrows. Named props, not a free-form list: a ticket whose
 * shape varies per event type stops being recognisable at the door. A fact with
 * no value is omitted; that is absence, not a new shape.
 *
 * **Values are mono, not sans.** Everything on the stub side of a ticket is
 * data someone reads out loud or types in under pressure, so it rides the same
 * face as the code.
 *
 * **The QR is a slot, not a dependency.** `@th/ui` does not own an encoder —
 * the app passes its own rendered code and this supplies the frame and size.
 */

export type TicketMedium = "screen" | "print";

const TicketFrame = styled(XStack, {
  name: "Ticket",
  width: "100%",
  maxWidth: 520,
  minWidth: 0,
  borderWidth: 2,
  borderColor: "$borderColor",
  backgroundColor: "$surface",
  borderRadius: 0,
  alignItems: "stretch",
  // Landscape cuts its die-cuts with a MASK (see `notchMask`), so the holes are
  // genuinely transparent and the wrapper's drop-shadow traces them. Stacked
  // falls back to clipping full circles, which needs `hidden`.
  overflow: "hidden",

  variants: {
    /**
     * How the shadow is drawn.
     *
     * `masked` — none here; the wrapper paints a `drop-shadow` that follows the
     * masked silhouette, notches included.
     * `box` — the plain hard offset, for the stacked fallback and print.
     */
    shadow: {
      box: {
        // Hard offset, zero blur — the only elevation this system has.
        shadowColor: "$borderColor",
        shadowOffset: { width: 4, height: 4 },
        shadowOpacity: 0.85,
        shadowRadius: 0,
      },
      masked: { shadowOpacity: 0, shadowRadius: 0 },
      none: { shadowOpacity: 0, shadowRadius: 0 },
    },
    stacked: {
      // Below 520px: one column, stub beneath the body.
      true: { flexDirection: "column" },
      false: { flexDirection: "row" },
    },
  } as const,

  defaultVariants: { shadow: "box", stacked: false },
});

/**
 * Room reserved at the top of the stub for the rotated ADMIT ONE, and the
 * inset it hangs at. Whole pixels, deliberately — see the note at its render.
 */
const ADMIT_INSET = 16;
const ADMIT_RESERVE = 92;

/** Die-cut radius. The hole is 2r across, centred on the ticket's edge. */
const HOLE_R = 9;

/** Ink at the shadow's 85%, expressible in a `drop-shadow()`. */
const SHADOW_INK =
  "color-mix(in srgb, var(--borderColor, #211C16) 85%, transparent)";

/**
 * The die-cut mask for the landscape rendering.
 *
 * Two radial gradients, each transparent inside `r` and opaque outside, at the
 * two ends of the tear. `mask-composite: intersect` means a pixel survives only
 * if BOTH layers keep it — the default (`add`) would union the opaque regions
 * and cut nothing.
 *
 * The payoff is that the holes are real transparency rather than circles
 * painted the colour of the page: `filter: drop-shadow()` traces the element's
 * actual alpha silhouette, so the offset shadow gets the same bite the ticket
 * has. A box-shadow follows the border box and can never do that.
 *
 * It also clips the arc rings for free — their outer halves fall in the
 * transparent region — so the notch keeps the ticket's outline curving around
 * it without a second clipping wrapper.
 */
const notchMask = (stubWidth: number, r: number) => {
  const x = `calc(100% - ${stubWidth}px)`;
  const layer = (y: string) =>
    `radial-gradient(circle ${r}px at ${x} ${y}, transparent ${r}px, #000 ${r}px)`;
  const image = `${layer("0")}, ${layer("100%")}`;
  return {
    maskImage: image,
    WebkitMaskImage: image,
    maskComposite: "intersect",
    WebkitMaskComposite: "source-in",
  } as Record<string, string>;
};

/**
 * Punch hole — the ONE sanctioned circular exception in this system.
 *
 * It is a HOLE, not a circle drawn on the ticket. It carries the page's own
 * background, sits above the frame so it interrupts the ticket's edge, and is
 * positioned to straddle that edge so the frame's `overflow: hidden` throws the
 * outer half away.
 *
 * What survives is a half-circle notch whose curve carries the ticket's own 2px
 * outline — the edge running *around* the bite rather than stopping dead at it.
 * A full, unclipped circle is what reads as a dot stuck on the ticket; a
 * clipped one reads as a die-cut, which is the whole point.
 */
const PunchHole = styled(Stack, {
  name: "TicketPunchHole",
  position: "absolute",
  width: HOLE_R * 2,
  height: HOLE_R * 2,
  borderRadius: 999,
  borderWidth: 2,
  borderColor: "$borderColor",
  // Above the frame's border, so the straight edge gives way to the curve.
  zIndex: 2,

  variants: {
    /**
     * `arc` — a ring with NO fill, for the masked path. The mask has already
     * removed the ticket where the hole is, so a fill would paint a disc back
     * into the gap; only the stroke is wanted, and only its inner half, which
     * the mask leaves behind.
     *
     * `cut` — a filled circle carrying the page colour, for the stacked
     * fallback where the frame clips instead of masking.
     */
    kind: {
      arc: { backgroundColor: "transparent" },
      cut: { backgroundColor: "$background" },
    },
  } as const,

  defaultVariants: { kind: "cut" },
});

interface Fact {
  label: string;
  value: string;
}

export interface TicketProps
  extends Omit<
    GetProps<typeof TicketFrame>,
    "children" | "medium" | "stacked"
  > {
  medium?: TicketMedium;
  /**
   * Render the stub beneath the body instead of beside it. The DS collapses
   * here at 520px; pass it explicitly since a Tamagui container has no
   * element-width media query.
   */
  stacked?: boolean;
  /**
   * Width of the tear-off stub, in px.
   *
   * Fixed rather than `max-content` because the die-cut mask has to know where
   * the tear is: the notches are cut at `calc(100% - stubWidth)`. A stub that
   * sizes to its contents cannot be expressed in a mask, and a ticket stub is
   * a fixed-width thing anyway.
   */
  stubWidth?: number;
  /** Category line above the title, e.g. "Music · Festival". */
  kicker?: string;
  eventTitle: string;
  /** Pass labels already localized — this component does not own copy. */
  when?: string;
  whenLabel?: string;
  where?: string;
  whereLabel?: string;
  tier?: string;
  tierLabel?: string;
  holder?: string;
  holderLabel?: string;
  seat?: string;
  seatLabel?: string;
  /** Rotated up the stub's edge on screen, e.g. "Admit one". */
  admitLabel?: string;
  /** The rendered QR. The app owns the encoder; this is its output, framed. */
  qr?: ReactNode;
  /** Human-readable code, printed beneath the QR so it can be typed in. */
  code?: string;
  /** Serial, printed small in the foot. Rendered as "No. 001984". */
  serial?: string;
  /**
   * Fill for the punch holes. They ARE the surface showing through, so this
   * MUST match whatever the ticket sits on — the default `$background` is only
   * correct on the page canvas. A mismatch turns the hole back into a dot.
   */
  holeColor?: GetProps<typeof Stack>["backgroundColor"];
  testId?: string;
}

const isWeb = Platform.OS === "web";

export const Ticket = memo<TicketProps>(function Ticket({
  medium = "screen",
  stacked = false,
  stubWidth = 192,
  kicker,
  eventTitle,
  when,
  whenLabel = "When",
  where,
  whereLabel = "Where",
  tier,
  tierLabel = "Tier",
  holder,
  holderLabel = "Holder",
  seat,
  seatLabel = "Seat",
  admitLabel,
  qr,
  code,
  serial,
  holeColor,
  testId,
  ...rest
}) {
  // Fixed order. Absent facts drop out; the order of the rest never changes.
  const facts: Fact[] = (
    [
      { label: whenLabel, value: when },
      { label: whereLabel, value: where },
      { label: tierLabel, value: tier },
      { label: holderLabel, value: holder },
      { label: seatLabel, value: seat },
    ] as Array<{ label: string; value?: string }>
  ).filter((f): f is Fact => Boolean(f.value));

  const screen = medium === "screen";
  const holeFill = holeColor ? { backgroundColor: holeColor } : {};
  // A DOM marker on the die-cuts. Their geometry (no border, page fill, above
  // the frame) is only observable in a real browser — jsdom does not apply
  // Tamagui's class-based styles — so tests assert that the right NUMBER of
  // holes exists in each rendering, and the browser pass covers how they look.
  const holeMark = isWeb ? { "data-th-punch-hole": "true" } : {};

  // The masked die-cut is web-only (CSS masks and drop-shadow), and only fits
  // the landscape rendering — stacked cannot express its tear position, whose
  // y depends on the stub's content height. Print gets neither: it wants no
  // shadow and no holes at all.
  const masked = screen && !stacked && isWeb;

  const frame = (
    <TicketFrame
      shadow={masked ? "masked" : screen ? "box" : "none"}
      stacked={stacked}
      {...(masked
        ? ({ style: notchMask(stubWidth, HOLE_R) } as Record<string, unknown>)
        : {})}
      {...(testId ? (isWeb ? { "data-testid": testId } : { testID: testId }) : {})}
      {...rest}
    >
      {/* ── Body ─────────────────────────────────────────────────────── */}
      <YStack flex={1} minWidth={0} padding="$5" gap="$3">
        {kicker ? (
          <Text variant="overline" fontSize={9.5} letterSpacing={2.5} tone="accent">
            {kicker}
          </Text>
        ) : null}

        <Text
          variant="h3"
          tag="h2"
          weight="black"
          textTransform="uppercase"
          letterSpacing={-0.4}
        >
          {eventTitle}
        </Text>

        {facts.length > 0 ? (
          // Two per row at full width, one when narrow. A hairline separates
          // the facts from the title — the only inner rule on the ticket.
          <XStack
            flexWrap="wrap"
            gap="$3"
            marginTop="$1"
            paddingTop="$3"
            borderTopWidth={1}
            borderTopColor="$borderColorSoft"
          >
            {facts.map((fact) => (
              <YStack
                key={fact.label}
                gap={2}
                minWidth={96}
                flexGrow={1}
                flexBasis={stacked ? "100%" : "40%"}
              >
                <Text
                  variant="overline"
                  fontSize={9.5}
                  letterSpacing={2.5}
                  tone="muted"
                >
                  {fact.label}
                </Text>
                {/* Mono: read aloud or typed in under pressure, like the code. */}
                <Text
                  variant="span"
                  fontFamily="$mono"
                  fontSize={11.5}
                  letterSpacing={0.4}
                  lineHeight={16}
                >
                  {fact.value}
                </Text>
              </YStack>
            ))}
          </XStack>
        ) : null}
      </YStack>

      {/* ── Stub ─────────────────────────────────────────────────────── */}
      <YStack
        position="relative"
        alignItems="center"
        justifyContent="center"
        gap="$2"
        padding="$4"
        backgroundColor="$surface"
        flexShrink={0}
        // Fixed in landscape so the mask knows where the tear is; full width
        // once stacked, where the tear runs across instead.
        {...(stacked
          ? { width: "100%" }
          : {
              width: stubWidth,
              // Reserves the rotated label's column; it is absolute, so this
              // is what keeps it from sitting on top of the QR.
              paddingTop: admitLabel && isWeb ? ADMIT_RESERVE : undefined,
            })}
        // The perforation: ONE edge, a vertical tear beside the stub and a
        // horizontal one above it once stacked.
        //
        // Every side is pinned to 0 first. Setting `borderStyle` without
        // widths let a 3px default in on the other three sides, so the stub
        // rendered dashed on all four edges — a box of ragged lines sitting
        // just inside the frame's solid border, which read as a rendering
        // fault rather than a perforation. Widths must be explicit.
        borderTopWidth={stacked ? 2 : 0}
        borderRightWidth={0}
        borderBottomWidth={0}
        borderLeftWidth={stacked ? 0 : 2}
        borderColor="$borderColor"
        // Solid in print — a 2px dashed rule reproduces as mush on paper.
        {...(screen ? { borderStyle: "dashed" as const } : {})}
      >
        {/* Holes sit at the two ends of the tear, straddling the frame edge. */}
        {screen ? (
          stacked ? (
            <>
              <PunchHole
                kind={masked ? "arc" : "cut"}
                left={-HOLE_R}
                top={-HOLE_R}
                {...holeMark}
                {...(masked ? {} : holeFill)}
              />
              <PunchHole
                kind={masked ? "arc" : "cut"}
                right={-HOLE_R}
                top={-HOLE_R}
                {...holeMark}
                {...(masked ? {} : holeFill)}
              />
            </>
          ) : (
            <>
              <PunchHole
                kind={masked ? "arc" : "cut"}
                left={-HOLE_R}
                top={-HOLE_R}
                {...holeMark}
                {...(masked ? {} : holeFill)}
              />
              <PunchHole
                kind={masked ? "arc" : "cut"}
                left={-HOLE_R}
                bottom={-HOLE_R}
                {...holeMark}
                {...(masked ? {} : holeFill)}
              />
            </>
          )
        ) : null}

        {admitLabel ? (
          <Text
            variant="overline"
            fontSize={9}
            weight="bold"
            letterSpacing={2.5}
            tone="muted"
            // Rotated up the stub's edge — the detail that makes this read as
            // a torn-off stub rather than a panel. Web-only; native falls back
            // to horizontal, which is the same information, unrotated.
            //
            // ABSOLUTE when rotated, and the stub reserves the room with
            // padding instead. Vertical text measures its own run length, which
            // is fractional once letter-spacing lands on a 9px mono face — it
            // came out 71.109px and pushed the whole ticket to 319.109px tall.
            // A fractional ticket makes every ticket after the first start on a
            // different subpixel boundary, so the page's grain and any rule
            // beneath them render a pixel apart from one card to the next.
            // Out of flow, the stub's height is QR + code, both integers.
            {...(!stacked && isWeb
              ? ({
                  position: "absolute",
                  top: ADMIT_INSET,
                  style: {
                    writingMode: "vertical-rl",
                    transform: "rotate(180deg)",
                  },
                } as Record<string, unknown>)
              : {})}
          >
            {admitLabel}
          </Text>
        ) : null}

        {qr ? (
          <Stack
            padding="$2"
            borderWidth={2}
            borderColor="$borderColor"
            borderRadius={0}
            alignItems="center"
            justifyContent="center"
          >
            {qr}
          </Stack>
        ) : null}

        {code ? (
          // Printed beneath the QR so a scanner failure at the gate is
          // recoverable by typing. Larger in print, where it is the fallback
          // someone reads aloud.
          <Text
            variant="span"
            fontFamily="$mono"
            weight="bold"
            fontSize={screen ? 13 : 17}
            letterSpacing={2}
            textAlign="center"
            // A ticket code is ONE unbroken token (`tk_` + 24 chars) with no
            // space to break at, so the default wrap finds no opportunity and
            // the run overflows the stub instead of wrapping inside it:
            // measured ~265px at 13px/ls2 against a 160px inner width
            // (stubWidth 192 less `$4` padding either side). It slid off the
            // page on `/my-tickets/<id>`. Native Text already breaks
            // per-character; these are the web-only equivalents. `maxWidth`
            // pins it to the stub so the break has something to measure
            // against — without it the text box itself grows past the parent.
            maxWidth="100%"
            {...(isWeb
              ? ({
                  style: { overflowWrap: "anywhere", wordBreak: "break-all" },
                } as Record<string, unknown>)
              : {})}
          >
            {code}
          </Text>
        ) : null}

        {serial ? (
          <Text
            variant="overline"
            fontSize={9.5}
            letterSpacing={2}
            tone="muted"
            textAlign="center"
          >
            {`No. ${serial}`}
          </Text>
        ) : null}
      </YStack>
    </TicketFrame>
  );

  if (!masked) {
    return frame;
  }

  // `drop-shadow` rather than `box-shadow`: it traces the element's rendered
  // alpha, so the offset copy carries the same notches the mask cut. A
  // box-shadow follows the border BOX and would run straight past them.
  return (
    <Stack
      alignSelf="flex-start"
      maxWidth="100%"
      {...({
        style: { filter: `drop-shadow(4px 4px 0 ${SHADOW_INK})` },
      } as Record<string, unknown>)}
    >
      {frame}
    </Stack>
  );
});

import { Children, memo } from "react";
import type { ReactNode } from "react";
import { Stack, XStack, YStack, styled, type GetProps } from "tamagui";

/**
 * ButtonGroup — joins peer actions into one bar.
 *
 * The buttons butt against each other and **share a single 2px seam** instead
 * of each carrying its own border with a gap between: every child after the
 * first is pulled back by the border width, so two 2px edges collapse into one.
 * That is what makes a row of actions read as one control rather than three
 * loose buttons, and it is the whole reason this component exists.
 *
 * Use it for **peers** — actions of equal weight on the same object, like a
 * ticket's download / transfer / resend. It is the wrong container for a
 * primary-plus-secondary pair: those are not peers, and joining them implies
 * they are.
 *
 * A hovered or focused child lifts above its neighbours, because its border
 * changes colour and a shared seam would otherwise let the neighbour paint over
 * half of it.
 */

const GroupFrame = styled(XStack, {
  name: "ButtonGroup",
  alignSelf: "flex-start",
  alignItems: "stretch",

  variants: {
    /** Stack vertically — the seam collapses upward instead of leftward. */
    vertical: { true: {}, false: {} },
    /**
     * Stack below the `md` breakpoint.
     *
     * A four-action bar is ~740px wide; left in a row it hangs 434px off the
     * side of a 320px screen. Stacking keeps every action reachable and keeps
     * the seam — it just collapses upward instead of leftward.
     */
    stackOnNarrow: {
      true: {
        $md: { flexDirection: "column", width: "100%", alignSelf: "stretch" },
      },
      false: {},
    },
    /** Fill the container rather than sizing to content. */
    fullWidth: { true: { alignSelf: "stretch", width: "100%" }, false: {} },
  } as const,

  defaultVariants: { vertical: false, fullWidth: false, stackOnNarrow: true },
});

const VerticalFrame = styled(YStack, {
  name: "ButtonGroupVertical",
  alignSelf: "flex-start",
  alignItems: "stretch",

  variants: {
    fullWidth: { true: { alignSelf: "stretch", width: "100%" }, false: {} },
  } as const,

  defaultVariants: { fullWidth: false },
});

/** The structural border width the seam collapses. */
const SEAM = 2;

export interface ButtonGroupProps
  extends Omit<GetProps<typeof GroupFrame>, "children" | "vertical"> {
  children: ReactNode;
  vertical?: boolean;
  fullWidth?: boolean;
  /** Stack below `md` rather than running off the side. Default true. */
  stackOnNarrow?: boolean;
  /**
   * Accessible name for the set. A group of actions is a group; without this a
   * screen reader announces three unrelated buttons.
   */
  label?: string;
  testId?: string;
}

export const ButtonGroup = memo<ButtonGroupProps>(function ButtonGroup({
  children,
  vertical = false,
  fullWidth = false,
  stackOnNarrow = true,
  label,
  testId,
  ...rest
}) {
  const items = Children.toArray(children).filter(Boolean);

  // Each child is WRAPPED and the wrapper carries the offset, rather than the
  // offset being cloned onto the child.
  //
  // Cloning only works when the child forwards style props, and half of a real
  // action bar does not: a `next/link` wrapper drops them, and so does any
  // component that renders its own trigger. That shipped as a bar whose first
  // seam collapsed and whose remaining two did not — the exact ragged row this
  // component exists to prevent. The wrapper works whatever the child is.
  const joined = items.map((child, index) => (
    <Stack
      key={index}
      {...(index > 0
        ? vertical
          ? { marginTop: -SEAM }
          : {
              marginLeft: -SEAM,
              // The seam turns with the group: leftward in a row, upward once
              // it stacks. Without this the offsets stay horizontal and the
              // stacked buttons overlap sideways into each other.
              ...(stackOnNarrow
                ? { $md: { marginLeft: 0, marginTop: -SEAM } }
                : {}),
            }
        : {})}
      {...(stackOnNarrow && !vertical ? { $md: { width: "100%" } } : {})}
      // A hovered or focused child lifts above its neighbours: its border
      // changes colour, and a shared seam would let the neighbour paint over
      // half of it.
      hoverStyle={{ zIndex: 1 }}
      {...(fullWidth && !vertical ? { flex: 1 } : {})}
    >
      {child}
    </Stack>
  ));

  const Frame = vertical ? VerticalFrame : GroupFrame;

  return (
    <Frame
      fullWidth={fullWidth}
      {...(vertical ? {} : { stackOnNarrow })}
      role="group"
      {...(label ? { "aria-label": label } : {})}
      {...(testId ? { "data-testid": testId } : {})}
      {...rest}
    >
      {joined}
    </Frame>
  );
});

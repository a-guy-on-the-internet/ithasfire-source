import type { Meta, StoryObj } from "@storybook/react";
import { XStack, YStack, styled } from "tamagui";

import { Button } from "../forms/Button";
import { Text } from "../typography/Text";
import {
  Tooltip,
  type TooltipAlign,
  type TooltipPlacement,
  type TooltipProps,
  type TooltipTone,
} from "./Tooltip";

type TooltipStoryArgs = Omit<TooltipProps, "anchor" | "open" | "children"> & {
  label?: string;
};

const TooltipStoryLayout = styled(YStack, {
  gap: "$5",
  alignItems: "center",
});

const TooltipStoryContent = styled(YStack, {
  gap: "$2",
  maxWidth: 260,
});

const TooltipLayoutReadout = styled(YStack, {
  gap: "$1",
  padding: "$2",
  borderRadius: 0,
  backgroundColor: "$surfaceMuted",
});

const TooltipLayoutLabel = styled(Text, {
  name: "TooltipLayoutLabel",
  variant: "overline",
  weight: "semibold",
  tone: "muted",
  margin: 0,
});

const TooltipLayoutLine = styled(Text, {
  name: "TooltipLayoutLine",
  variant: "code",
  fontSize: "$1",
  color: "$color",
  margin: 0,
});

const demoPlacements: TooltipPlacement[] = ["top", "right", "bottom", "left"];
const demoAlignments: TooltipAlign[] = ["start", "center", "end"];
const demoTones: TooltipTone[] = [
  "neutral",
  "info",
  "success",
  "warning",
  "danger",
  "inverse",
];

const STORY_POINTER_OVERLAP = 1;

type FrameStyleSnapshot = Partial<
  Record<
    | "top"
    | "right"
    | "bottom"
    | "left"
    | "marginTop"
    | "marginRight"
    | "marginBottom"
    | "marginLeft"
    | "transform",
    string | number
  >
>;

type LayoutSnapshot = {
  frameStyle: FrameStyleSnapshot;
  flexDirection: "row" | "row-reverse" | "column" | "column-reverse";
  alignItems: "flex-start" | "center" | "flex-end";
  frameTransform?: string;
};

type PointerSnapshot = {
  width: number;
  height: number;
  overlap: string;
};

const storyPlacementLayouts: Record<
  TooltipPlacement,
  {
    flexDirection: LayoutSnapshot["flexDirection"];
    isVertical: boolean;
    centerTransform: string;
    position: (offset: number) => FrameStyleSnapshot;
  }
> = {
  top: {
    flexDirection: "column",
    isVertical: true,
    centerTransform: "translateX(-50%)",
    position: (offset) => ({ bottom: "100%", marginBottom: offset }),
  },
  bottom: {
    flexDirection: "column-reverse",
    isVertical: true,
    centerTransform: "translateX(-50%)",
    position: (offset) => ({ top: "100%", marginTop: offset }),
  },
  left: {
    flexDirection: "row",
    isVertical: false,
    centerTransform: "translateY(-50%)",
    position: (offset) => ({ right: "100%", marginRight: offset }),
  },
  right: {
    flexDirection: "row-reverse",
    isVertical: false,
    centerTransform: "translateY(-50%)",
    position: (offset) => ({ left: "100%", marginLeft: offset }),
  },
};

const alignToFlex: Record<TooltipAlign, LayoutSnapshot["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
};

type AlignmentStyle = {
  edges: FrameStyleSnapshot;
  frameTransform?: string;
};

const alignFrameStyle = (
  placement: TooltipPlacement,
  align: TooltipAlign,
  centerTransform: string,
): AlignmentStyle => {
  const edges: FrameStyleSnapshot = {};
  const layout = storyPlacementLayouts[placement];

  if (align === "center") {
    if (layout.isVertical) {
      edges.left = "50%";
    } else {
      edges.top = "50%";
    }
    return { edges, frameTransform: centerTransform };
  }

  if (layout.isVertical) {
    if (align === "start") {
      edges.left = 0;
    } else {
      edges.right = 0;
    }
  } else if (align === "start") {
    edges.top = 0;
  } else {
    edges.bottom = 0;
  }

  return { edges };
};

const describeFrameLayout = (
  placement: TooltipPlacement,
  align: TooltipAlign,
  pointerThickness: number,
  showPointer: boolean,
): LayoutSnapshot => {
  const layout = storyPlacementLayouts[placement];
  const offset = showPointer
    ? Math.max(pointerThickness - STORY_POINTER_OVERLAP, 0)
    : 0;
  const alignment = alignFrameStyle(placement, align, layout.centerTransform);
  const frameStyle: FrameStyleSnapshot = {
    ...layout.position(offset),
    ...alignment.edges,
  };

  if (alignment.frameTransform) {
    frameStyle.transform = alignment.frameTransform;
  }

  return {
    frameStyle,
    flexDirection: layout.flexDirection,
    alignItems: alignToFlex[align],
    frameTransform: alignment.frameTransform,
  };
};

const pointerOverlapKeys: Record<
  TooltipPlacement,
  "marginTop" | "marginRight" | "marginBottom" | "marginLeft"
> = {
  top: "marginTop",
  right: "marginRight",
  bottom: "marginBottom",
  left: "marginLeft",
};

const describePointerLayout = (
  placement: TooltipPlacement,
  pointerLength: number,
  pointerThickness: number,
  showPointer: boolean,
): PointerSnapshot | null => {
  if (!showPointer) {
    return null;
  }

  const size =
    placement === "left" || placement === "right"
      ? { width: pointerThickness, height: pointerLength }
      : { width: pointerLength, height: pointerThickness };
  const overlapKey = pointerOverlapKeys[placement];

  return {
    ...size,
    overlap: `${overlapKey}: -${STORY_POINTER_OVERLAP}px`,
  };
};

const meta = {
  title: "Ui/Tamagui/Components/Feedback/Tooltip",
  component: Tooltip,
  args: {
    placement: "top",
    align: "center",
    tone: "neutral",
    label: "Hover or focus the trigger to explore the controls.",
    pointerThickness: 8,
    showPointer: true,
  },
  argTypes: {
    placement: {
      control: { type: "select" },
      pointerLength: {
        control: { type: "number", min: 8, max: 48, step: 1 },
        description:
          "Sets the pointer length (base width/height) which determines how far the pointer extends along the edge.",
      },
      showPointer: {
        control: { type: "boolean" },
        description:
          "Toggles the pointer entirely to preview the bubble alignment by itself.",
      },
      options: demoPlacements,
      description: "Positions the tooltip bubble around the anchor button.",
    },
    align: {
      control: { type: "select" },
      options: demoAlignments,
      description:
        "Slides the pointer along the active edge to keep it inside the anchor bounds.",
    },
    tone: {
      control: { type: "select" },
      options: demoTones,
      description:
        "Adjusts the bubble + pointer colors using the tooltip tone scale.",
    },
    pointerThickness: {
      control: { type: "number", min: 4, max: 24, step: 1 },
      description:
        "Sets the pointer thickness; the bubble gap matches this to avoid touching the anchor.",
    },
  },
  parameters: {
    layout: "centered",
  },
  render: ({ label, ...args }: TooltipStoryArgs) => {
    const placement = args.placement ?? "top";
    const align = args.align ?? "center";
    const pointerThickness = args.pointerThickness ?? 8;
    const pointerLength = args.pointerLength ?? 16;
    const showPointer = args.showPointer ?? true;
    const layoutInfo = describeFrameLayout(
      placement,
      align,
      pointerThickness,
      showPointer,
    );
    const pointerInfo = describePointerLayout(
      placement,
      pointerLength,
      pointerThickness,
      showPointer,
    );
    const formatValue = (value: string | number | undefined) => {
      if (value === undefined) {
        return "—";
      }
      return typeof value === "number" ? `${value}px` : value;
    };
    const frameLines = [
      {
        key: "flexDirection",
        label: "Flex direction",
        value: layoutInfo.flexDirection,
      },
      { key: "alignItems", label: "Align items", value: layoutInfo.alignItems },
      ...Object.entries(layoutInfo.frameStyle).map(([styleKey, value]) => ({
        key: `frame-${styleKey}`,
        label: styleKey,
        value: formatValue(value),
      })),
    ];
    const pointerLines = pointerInfo
      ? [
          {
            key: "pointer-size",
            label: "Pointer size",
            value: `${formatValue(pointerInfo.width)} × ${formatValue(pointerInfo.height)}`,
          },
          {
            key: "pointer-overlap",
            label: "Pointer overlap",
            value: pointerInfo.overlap,
          },
        ]
      : [{ key: "pointer-hidden", label: "Pointer", value: "Hidden" }];

    return (
      <YStack gap="$3" alignItems="center">
        <Tooltip
          {...args}
          anchor={
            <Button size="$4" variant="secondary">
              Hover me
            </Button>
          }
        >
          <TooltipStoryContent>
            <Text variant="body" weight="bold" margin={0}>
              {label}
            </Text>
            <Text variant="bodySmall" tone="muted" margin={0}>
              Placement — moves the bubble around the trigger.
            </Text>
            <Text variant="bodySmall" tone="muted" margin={0}>
              Align — shifts the pointer along the active edge so it stays
              inside.
            </Text>
            <Text variant="bodySmall" tone="muted" margin={0}>
              Tone — swaps the bubble and pointer color tokens.
            </Text>
            <TooltipLayoutReadout>
              <TooltipLayoutLabel>Frame layout</TooltipLayoutLabel>
              {frameLines.map(({ key, label: entryLabel, value }) => (
                <TooltipLayoutLine key={key}>
                  {entryLabel}: {value}
                </TooltipLayoutLine>
              ))}
              <TooltipLayoutLabel>Pointer</TooltipLayoutLabel>
              {pointerLines.map(({ key, label: entryLabel, value }) => (
                <TooltipLayoutLine key={key}>
                  {entryLabel}: {value}
                </TooltipLayoutLine>
              ))}
            </TooltipLayoutReadout>
          </TooltipStoryContent>
        </Tooltip>
        <Text variant="bodySmall" tone="muted" margin={0}>
          Tip: focus the button with Tab to preview keyboard behaviour.
        </Text>
      </YStack>
    );
  },
} satisfies Meta<TooltipStoryArgs>;

type Story = StoryObj<TooltipStoryArgs>;

export const Default: Story = {
  args: {},
};

export const AlignmentMatrix: Story = {
  args: {
    showPointer: true,
  },
  render: ({ label = "Alignment", tone = "neutral", ...args }) => (
    <YStack gap="$6">
      {demoPlacements.map((placement) => (
        <YStack key={placement} gap="$3">
          <Text variant="body" weight="bold" margin={0}>
            {placement.toUpperCase()}
          </Text>
          <XStack gap="$6" alignItems="center">
            {demoAlignments.map((align) => (
              <TooltipStoryLayout key={`${placement}-${align}`}>
                <Tooltip
                  {...args}
                  open
                  placement={placement}
                  align={align}
                  tone={tone}
                  anchor={
                    <Button size="$3" variant="secondary">
                      {align}
                    </Button>
                  }
                >
                  <TooltipStoryContent>
                    <Text variant="body" margin={0}>
                      {label}
                    </Text>
                  </TooltipStoryContent>
                </Tooltip>
              </TooltipStoryLayout>
            ))}
          </XStack>
        </YStack>
      ))}
    </YStack>
  ),
};

export default meta;

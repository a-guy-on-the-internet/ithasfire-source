"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import type { ReactNode } from "react";
import { YStack, styled, type StackProps } from "tamagui";

export type OverlayHostMode = "single" | "stack";
export type OverlayPlacement = "top" | "center" | "bottom";
export type OverlayAlignment = "start" | "center" | "end";

export type OverlayMountOptions = {
  placement?: OverlayPlacement;
  align?: OverlayAlignment;
  padding?: StackProps["padding"];
  maxWidth?: number | string;
  interactive?: boolean;
  testID?: string;
  zIndex?: StackProps["zIndex"];
};

export type OverlayDescriptor = {
  id: string;
  node: ReactNode;
  options?: OverlayMountOptions;
  priority?: number;
};

type OverlayUpdatePayload = Partial<Omit<OverlayDescriptor, "id">>;

export type OverlayController = {
  update: (next: OverlayUpdatePayload) => void;
  remove: () => void;
};

export type OverlayHostContextValue = {
  mode: OverlayHostMode;
  overlays: OverlayDescriptor[];
  activeOverlay: OverlayDescriptor | null;
  mount: (descriptor: OverlayDescriptor) => OverlayController;
  unmount: (id: string) => void;
};

const OverlayContext = createContext<OverlayHostContextValue | null>(null);

const OverlayRoot = styled(YStack, {
  name: "OverlayHostRoot",
  position: "relative",
  width: "100%",
}) as React.ComponentType<
  StackProps & { suppressHydrationWarning?: boolean }
>;

const OverlayLayer = styled(YStack, {
  name: "OverlayLayer",
  position: "absolute",
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  pointerEvents: "none",
  zIndex: 10,
});

export type OverlayHostProps = StackProps & {
  children?: ReactNode;
  mode?: OverlayHostMode;
  initialOverlay?: OverlayDescriptor | null;
  layerProps?: Partial<StackProps>;
};

const LAYER_PADDING_PROPS: Partial<StackProps> = {
  paddingHorizontal: "$2",
  paddingVertical: "$5",
};

const placementToJustify: Record<
  OverlayPlacement,
  StackProps["justifyContent"]
> = {
  top: "flex-start",
  center: "center",
  bottom: "flex-end",
};

const alignToItems: Record<OverlayAlignment, StackProps["alignItems"]> = {
  start: "flex-start",
  center: "center",
  end: "flex-end",
};

const DEFAULT_OVERLAY_OPTIONS: Required<
  Pick<OverlayMountOptions, "placement" | "align" | "interactive">
> = {
  placement: "top",
  align: "center",
  interactive: false,
};

const getOverlayOptions = (options?: OverlayMountOptions) => ({
  ...DEFAULT_OVERLAY_OPTIONS,
  ...options,
});

export const OverlayHost = ({
  children,
  mode = "single",
  initialOverlay = null,
  layerProps,
  ...stackProps
}: OverlayHostProps) => {
  const [overlays, setOverlays] = useState<OverlayDescriptor[]>(() =>
    initialOverlay ? [initialOverlay] : [],
  );

  const mount = useCallback(
    (descriptor: OverlayDescriptor): OverlayController => {
      setOverlays((prev) => {
        if (mode === "single") {
          return [descriptor];
        }
        const filtered = prev.filter((entry) => entry.id !== descriptor.id);
        return [...filtered, descriptor];
      });

      return {
        update: (next: OverlayUpdatePayload) => {
          setOverlays((prev) =>
            prev.map((entry) =>
              entry.id === descriptor.id
                ? {
                    ...entry,
                    ...next,
                    node: next.node ?? entry.node,
                    options: next.options ?? entry.options,
                    priority: next.priority ?? entry.priority,
                  }
                : entry,
            ),
          );
        },
        remove: () => {
          setOverlays((prev) =>
            prev.filter((entry) => entry.id !== descriptor.id),
          );
        },
      };
    },
    [mode],
  );

  const unmount = useCallback((id: string) => {
    setOverlays((prev) => prev.filter((entry) => entry.id !== id));
  }, []);

  const renderedOverlays = (
    mode === "single"
      ? overlays.length > 0
        ? [overlays[overlays.length - 1]]
        : []
      : overlays
  ).filter((entry): entry is (typeof overlays)[number] => entry !== undefined);

  const contextValue = useMemo<OverlayHostContextValue>(
    () => ({
      mode,
      overlays,
      activeOverlay: overlays[overlays.length - 1] ?? null,
      mount,
      unmount,
    }),
    [mode, mount, overlays, unmount],
  );

  const mergedLayerProps = {
    ...LAYER_PADDING_PROPS,
    ...layerProps,
  };
  const overlayRootProps = {
    ...stackProps,
    suppressHydrationWarning: true,
  } as StackProps;

  return (
    <OverlayContext.Provider value={contextValue}>
      {/* Tamagui resolves a few of its styled-component class names from
          runtime media queries (e.g. `$gtSm`). On SSR there's no viewport,
          so the first paint can emit a different class-name set than the
          client hydrate, producing a "won't be patched up" warning here
          even though the visual result reconciles correctly. Suppressing
          on the root is safe — the markup converges on the very next
          render once the media-query listener fires.

          Cast: Tamagui's styled() typings don't include the DOM-only
          `suppressHydrationWarning` attribute, but it's forwarded to the
          underlying element on web (proven by the same prop working on
          other Tamagui usages across the app). */}
      <OverlayRoot {...overlayRootProps}>
        {children}
        {renderedOverlays.length > 0 ? (
          <OverlayLayer {...mergedLayerProps}>
            {renderedOverlays.map((entry) => {
              const {
                placement,
                align,
                interactive,
                maxWidth,
                padding,
                testID,
                zIndex,
              } = getOverlayOptions(entry.options);
              const containerPointerEvents: StackProps["pointerEvents"] =
                interactive ? "auto" : "none";
              return (
                <YStack
                  key={entry.id}
                  pointerEvents={containerPointerEvents}
                  position="absolute"
                  top={0}
                  right={0}
                  bottom={0}
                  left={0}
                  padding={padding ?? "$5"}
                  zIndex={zIndex}
                  data-testid={testID}
                >
                  <YStack
                    flex={1}
                    justifyContent={placementToJustify[placement]}
                    alignItems={alignToItems[align]}
                  >
                    <YStack width="100%" maxWidth={maxWidth ?? "100%"}>
                      {entry.node}
                    </YStack>
                  </YStack>
                </YStack>
              );
            })}
          </OverlayLayer>
        ) : null}
      </OverlayRoot>
    </OverlayContext.Provider>
  );
};

OverlayHost.displayName = "OverlayHost";

export const useOverlayHost = () => {
  const context = useContext(OverlayContext);
  if (!context) {
    throw new Error("useOverlayHost must be used within an OverlayHost");
  }
  return context;
};

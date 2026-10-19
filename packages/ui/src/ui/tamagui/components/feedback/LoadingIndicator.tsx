"use client";

import { forwardRef, type ElementRef } from "react";
import { YStack, Stack, type YStackProps } from "tamagui";

import { Spinner, type SpinnerProps } from "./Spinner";
import { Text } from "../typography/Text";

export type LoadingIndicatorProps = Omit<YStackProps, "children"> & {
  /** Spinner size forwarded to `Spinner` */
  size?: SpinnerProps["size"];
  /** Optional text shown beside/below the spinner. Pass `null` to hide. */
  label?: string | null;
  /** Props forwarded to the underlying Spinner */
  spinnerProps?: Partial<SpinnerProps>;
  /** Test/QA identifiers */
  qaId?: string;
  testID?: string;
  /** Layout: when `true` render inline (row); otherwise stacked (column, centered) */
  inline?: boolean;
};

export const LoadingIndicator = forwardRef<
  ElementRef<typeof Stack>,
  LoadingIndicatorProps
>(
  (
    {
      size = "lg",
      label = "Loading...",
      spinnerProps,
      qaId = "loading-indicator",
      testID = "loading-indicator",
      inline = false,
      ...stackProps
    },
    ref,
  ) => {
    const direction = inline ? "row" : "column";
    const gap = inline ? 8 : 12;

    return (
      <YStack
        ref={ref}
        flexDirection={direction}
        alignItems={inline ? "center" : "center"}
        justifyContent={inline ? "flex-start" : "center"}
        gap={gap}
        data-qa={qaId}
        data-testid={testID}
        {...stackProps}
      >
        <Spinner size={size} {...spinnerProps} />
        {label !== null ? (
          <Text variant={size === "sm" ? "caption" : "body"} tone="muted">
            {label}
          </Text>
        ) : null}
      </YStack>
    );
  },
);

LoadingIndicator.displayName = "LoadingIndicator";

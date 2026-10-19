"use client";

import { forwardRef, type ElementRef } from "react";
import { YStack, type YStackProps } from "tamagui";

import {
  LoadingIndicator,
  type LoadingIndicatorProps,
} from "./LoadingIndicator";

export type FullPageLoaderProps = Omit<YStackProps, "children"> & {
  /** Spinner size variant. */
  size?: LoadingIndicatorProps["size"];
  /** Text shown beneath the spinner. Pass `null` to hide. */
  label?: string | null;
  /** Props forwarded to LoadingIndicator. */
  spinnerProps?: Partial<LoadingIndicatorProps>;
  qaId?: string;
  testID?: string;
};

export const FullPageLoader = forwardRef<
  ElementRef<typeof YStack>,
  FullPageLoaderProps
>(
  (
    {
      size = "lg",
      label = "Loading...",
      spinnerProps,
      qaId = "full-page-loader",
      testID = "full-page-loader",
      ...yStackProps
    },
    ref,
  ) => {
    return (
      <YStack
        ref={ref}
        alignItems="center"
        justifyContent="center"
        minHeight={300}
        gap="$3"
        data-testid={testID}
        data-qa={qaId}
        {...yStackProps}
      >
        <LoadingIndicator
          size={size}
          label={label}
          spinnerProps={spinnerProps}
        />
      </YStack>
    );
  },
);

FullPageLoader.displayName = "FullPageLoader";

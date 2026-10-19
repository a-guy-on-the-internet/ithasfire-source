/**
 * Native stub for DatePicker.
 *
 * The web DatePicker uses Popover with @floating-ui/react which depends on
 * react-dom. On native, use the native date picker from
 * @react-native-community/datetimepicker or similar.
 *
 * This stub logs a warning and renders nothing meaningful.
 */
import { useEffect } from "react";
import { Text, YStack } from "tamagui";

import type { DatePickerProps } from "./forms/DatePicker.types";

export type { DatePickerProps } from "./forms/DatePicker.types";

/**
 * Placeholder DatePicker for native – not implemented.
 * Use @react-native-community/datetimepicker instead.
 */
export const DatePicker = ({ label, placeholder }: DatePickerProps) => {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.warn(
      "[DatePicker] Web DatePicker is not supported on native. " +
        "Use @react-native-community/datetimepicker instead.",
    );
  }, []);

  return (
    <YStack gap="$2" opacity={0.5}>
      {label ? <Text>{label}</Text> : null}
      <Text style={{ opacity: 0.75 }}>
        {placeholder ?? "Date picker not available"}
      </Text>
    </YStack>
  );
};

DatePicker.displayName = "DatePicker";

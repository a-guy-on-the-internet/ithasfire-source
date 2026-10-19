import { Pressable } from "react-native";

import { Text } from "@th/ui-native";

/**
 * A refused admit that arrived while ANOTHER person's verdict was up. Shown in
 * its own slot (camera rail and search screen alike) so it is never written
 * over that verdict and never wiped by that verdict's express dwell. The host
 * times it out; a tap clears it sooner.
 */
export const LateRefusalNotice = ({
  message,
  onDismiss,
  testID,
}: {
  message: string;
  onDismiss: () => void;
  testID?: string;
}) => (
  <Pressable
    onPress={onDismiss}
    accessibilityRole="alert"
    accessibilityLiveRegion="assertive"
    accessibilityHint="Tap to dismiss."
    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
    testID={testID}
  >
    <Text variant="caption" weight="bold" tone="warning">
      {message}
    </Text>
  </Pressable>
);

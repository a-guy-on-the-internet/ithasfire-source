import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";

import { useColors } from "@th/ui-native";

/**
 * Android: how far the keyboard covers `ref`, measured in window coordinates
 * when the keyboard shows. The app runs edge-to-edge, so the window does not
 * resize and `KeyboardAvoidingView` is no help: its "height" behaviour
 * shrinks to a height derived from the FIRST layout it saw and a
 * parent-relative `y`, which on the Tickets tab left the card clipped above
 * an empty band. Measuring the container itself at show time sidesteps both.
 * If the window does resize, the overlap is 0 and nothing changes.
 */
const useAndroidKeyboardInset = (ref: RefObject<View | null>) => {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const show = Keyboard.addListener("keyboardDidShow", (event) => {
      ref.current?.measureInWindow((_x, y, _width, height) => {
        const overlap = y + height - event.endCoordinates.screenY;
        setInset(Math.max(0, Math.round(overlap)));
      });
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => setInset(0));
    return () => {
      show.remove();
      hide.remove();
    };
  }, [ref]);
  return inset;
};

/**
 * The scroll container a screen puts `EmailVerificationPrompt` in.
 *
 * - Keyboard: iOS keeps `KeyboardAvoidingView` "padding". Android pads the
 *   container by the measured keyboard overlap (see
 *   `useAndroidKeyboardInset`), so the ScrollView ends at the keyboard's top
 *   edge and the card scrolls rather than being cut off.
 * - Pull to refresh: the way out after verifying on web or another device.
 *   React Query does not refetch on foreground here, and the latch holds the
 *   prompt until the gated query answers, so `onRefresh` should refetch it.
 */
export const EmailVerificationScroll = ({
  children,
  contentContainerStyle,
  refreshing,
  onRefresh,
  testID,
}: {
  children: ReactNode;
  contentContainerStyle?: StyleProp<ViewStyle>;
  refreshing: boolean;
  onRefresh: () => void;
  testID?: string;
}) => {
  const colors = useColors();
  const containerRef = useRef<View>(null);
  const androidInset = useAndroidKeyboardInset(containerRef);
  return (
    <View
      ref={containerRef}
      style={[styles.fill, { paddingBottom: androidInset }]}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.fill}
      >
        <ScrollView
          contentContainerStyle={contentContainerStyle}
          keyboardShouldPersistTaps="handled"
          testID={testID}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.color}
            />
          }
        >
          {children}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
};

const styles = StyleSheet.create({ fill: { flex: 1 } });

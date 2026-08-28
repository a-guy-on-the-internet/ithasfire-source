import { Image, StyleSheet, Text, View } from "react-native";
import { Lock } from "lucide-react-native";

import {
  SquarePrimaryButton,
  useColors,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";

import type { CheckoutPath } from "@/features/checkout/checkout-eligibility";
import type { EventGatedPreview } from "@/features/events/use-event-detail";
import { ScreenHeading, SectionNum } from "@/ui/primitives";

/**
 * Locked-gate rendering (FR-011): only the minimal `events.getGatedPreview`
 * payload (name + hero) — full details stay server-side until the gate is
 * passed. Password gates unlock natively; application gates route to web.
 */
export const EventGatedView = ({
  preview,
  path,
  onEnterPassword,
  onOpenWebCheckout,
}: {
  preview: EventGatedPreview;
  path: CheckoutPath | null;
  onEnterPassword: () => void;
  onOpenWebCheckout: () => void;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);

  return (
    <View style={styles.container} testID="event-gated-view">
      {preview.heroImageUrl ? (
        <Image
          source={{ uri: preview.heroImageUrl }}
          accessibilityLabel={`${preview.title} hero image`}
          style={styles.hero}
          resizeMode="cover"
        />
      ) : null}

      <View style={styles.header}>
        <SectionNum index="02" label="Private event" />
        <ScreenHeading>{preview.title}</ScreenHeading>
      </View>

      <View style={styles.lockCard}>
        <View style={styles.lockRow}>
          {/* 16px glyph carrying meaning next to its label → `accentText`,
              which clears the text floor as well as the 3:1 graphic one. */}
          <Lock size={16} color={colors.accentText} />
          <Text style={styles.lockTitle}>This event is private</Text>
        </View>
        <Text style={styles.lockCopy}>
          {path === "password"
            ? "Enter the password from the organizer to see details and get tickets."
            : path === null
              ? "Checking access..."
              : "Access to this event is limited. Visit ithasfire.com for details."}
        </Text>
        {path === "password" ? (
          <SquarePrimaryButton
            label="Enter password"
            onPress={onEnterPassword}
            accessibilityHint="Opens the event password prompt."
            testID="event-gated-password-cta"
          />
        ) : path === "web" ? (
          <SquarePrimaryButton
            label="Get tickets on ithasfire.com"
            onPress={onOpenWebCheckout}
            accessibilityHint="Opens this event in the browser."
            testID="event-gated-web-cta"
          />
        ) : null}
      </View>
    </View>
  );
};

/** Colour-bearing sheet → factory + `useThemedSheet`. */
const makeSheet = (c: NativePalette) =>
  StyleSheet.create({
    container: { gap: 20 },
    hero: {
      width: "100%",
      aspectRatio: 16 / 9,
      backgroundColor: c.surfaceMuted,
    },
    header: { gap: 6 },
    lockCard: {
      borderWidth: 2,
      borderColor: c.borderColor,
      backgroundColor: c.surfaceMuted,
      padding: 20,
      gap: 12,
    },
    lockRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    lockTitle: {
      color: c.color,
      fontFamily: "Montserrat-SemiBold",
      fontSize: 13,
      fontWeight: "700",
      letterSpacing: 0.8,
      textTransform: "uppercase",
    },
    lockCopy: {
      color: c.colorMuted,
      fontFamily: "Montserrat",
      fontSize: 14,
      lineHeight: 20,
    },
  });

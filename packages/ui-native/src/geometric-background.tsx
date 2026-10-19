import { StyleSheet, View } from "react-native";

import { useColors } from "./theme";

/**
 * Decorative Swiss-geometric backdrop for the scanner shell. Diagonal lines,
 * subtle vertical rules, and a single bordered block — all rendered with
 * pointer-events disabled so they never intercept taps.
 *
 * Theme-reactive: the rules are steel-blue on Ember and low-alpha ink on Stub.
 * Styles are built inline rather than via the shared sheet because this is
 * purely decorative geometry with no reuse elsewhere.
 */
export const GeometricBackground = () => {
  const colors = useColors();
  return (
    <View style={styles.container} pointerEvents="none">
      <View
        style={[styles.diag, { top: "15%", backgroundColor: colors.geoLine }]}
      />
      <View
        style={[styles.diag, { top: "35%", backgroundColor: colors.geoLine }]}
      />
      <View
        style={[styles.diag, { top: "55%", backgroundColor: colors.geoLine }]}
      />
      <View
        style={[styles.diag, { top: "75%", backgroundColor: colors.geoLine }]}
      />
      <View
        style={[styles.vert, { left: "25%", backgroundColor: colors.geoLine }]}
      />
      <View
        style={[styles.vert, { left: "75%", backgroundColor: colors.geoLine }]}
      />
      <View style={[styles.block, { borderColor: colors.geoBlock }]} />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    overflow: "hidden",
  },
  diag: {
    position: "absolute",
    left: -50,
    right: -50,
    height: 1,
    transform: [{ rotate: "-12deg" }],
  },
  vert: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 1,
  },
  block: {
    position: "absolute",
    bottom: "10%",
    right: "8%",
    width: 120,
    height: 120,
    borderWidth: 1,
  },
});

// @ts-check
/**
 * Expo config plugin: prune Android manifest permissions the scanner
 * never exercises.
 *
 * `app.config.ts` declares only CAMERA + VIBRATE, but native config
 * plugins (chiefly @stripe/stripe-terminal-react-native, plus expo-camera
 * and assorted RN modules) inject a long tail of permissions at prebuild
 * time. The merged manifest ends up requesting overlay, system-settings,
 * external-storage, and microphone access — none of which the gate-scan /
 * Tap-to-Pay flows use. Beyond being dead weight, SYSTEM_ALERT_WINDOW,
 * WRITE_SETTINGS, and RECORD_AUDIO are exactly the permissions Google Play
 * review and the Data Safety form scrutinize, and they depress install
 * conversion ("why does a ticket scanner want to record audio?").
 *
 * This plugin force-removes them by emitting `<uses-permission
 * tools:node="remove" .../>` entries, which win during manifest merging
 * regardless of what order the upstream plugins ran in.
 *
 * Two groups:
 *   - ALWAYS_REMOVE: genuinely unused in every build tier.
 *   - TAP_TO_PAY_PERMISSIONS: Bluetooth + location, only meaningful when a
 *     Tap-to-Pay-capable binary is built (EXPO_TAP_TO_PAY_TIER != none).
 *     v1.0 ships tier `none`, so production strips these too and is left
 *     with just CAMERA / INTERNET / VIBRATE.
 *
 * Idempotent: re-running prebuild collapses duplicate removal entries
 * because we de-dupe against the existing manifest before appending.
 */
const { withAndroidManifest } = require("@expo/config-plugins");

const ALWAYS_REMOVE = [
  "android.permission.SYSTEM_ALERT_WINDOW",
  "android.permission.WRITE_SETTINGS",
  "android.permission.WRITE_EXTERNAL_STORAGE",
  "android.permission.READ_EXTERNAL_STORAGE",
  "android.permission.RECORD_AUDIO",
  "android.permission.MODIFY_AUDIO_SETTINGS",
];

// Stripe Terminal pulls these in for in-person payments / BLE readers.
// Useless on a binary that can't run Tap to Pay.
const TAP_TO_PAY_PERMISSIONS = [
  "android.permission.ACCESS_FINE_LOCATION",
  "android.permission.ACCESS_COARSE_LOCATION",
  "android.permission.BLUETOOTH_CONNECT",
  "android.permission.BLUETOOTH_SCAN",
];

const TOOLS_NS = "http://schemas.android.com/tools";

/**
 * @param {{ tapToPaySupported?: boolean }} [props]
 */
module.exports = function withAndroidPermissions(config, props = {}) {
  const tapToPaySupported = props.tapToPaySupported ?? false;
  const toRemove = tapToPaySupported
    ? ALWAYS_REMOVE
    : [...ALWAYS_REMOVE, ...TAP_TO_PAY_PERMISSIONS];

  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;

    // Ensure the `tools` namespace is declared on <manifest> so
    // `tools:node="remove"` resolves during the merge.
    manifest.$ = manifest.$ ?? {};
    manifest.$["xmlns:tools"] = manifest.$["xmlns:tools"] ?? TOOLS_NS;

    const existing = manifest["uses-permission"] ?? [];

    // Drop any positive declaration of a permission we're removing so a
    // stray `tools:node="remove"` and a normal declaration don't fight.
    const kept = existing.filter((entry) => {
      const name = entry?.$?.["android:name"];
      const isRemovalTarget = toRemove.includes(name);
      const isRemoveNode = entry?.$?.["tools:node"] === "remove";
      return !(isRemovalTarget && !isRemoveNode);
    });

    const alreadyRemoved = new Set(
      kept
        .filter((e) => e?.$?.["tools:node"] === "remove")
        .map((e) => e?.$?.["android:name"]),
    );

    for (const name of toRemove) {
      if (alreadyRemoved.has(name)) continue;
      kept.push({ $: { "android:name": name, "tools:node": "remove" } });
    }

    manifest["uses-permission"] = kept;
    return cfg;
  });
};

// @ts-check
/**
 * Expo config plugin: restrict the Android release native libs to
 * arm64-v8a only.
 *
 * The scanner's release APK is dominated by native libraries from
 * @stripe/stripe-terminal-react-native, Sentry, Hermes, and several
 * expo-* modules. By default gradle bundles all four ABIs
 * (arm64-v8a, armeabi-v7a, x86, x86_64) so the same APK installs on
 * any device. That ~4× the native-lib footprint for ABIs no real
 * deployed phone uses. Modern Android = arm64; armv7 is for pre-2019
 * devices the scanner's `minSdkVersion: 26` (Android 8) policy already
 * largely excludes; x86 / x86_64 are for emulators only.
 *
 * Implementation: insert an `ndk { abiFilters 'arm64-v8a' }` block into
 * `android/app/build.gradle`'s `defaultConfig`. We use the existing
 * `defaultConfig {` opener as an anchor and append the abiFilters
 * block right after it. Idempotent — the modification is wrapped in
 * begin/end markers so re-running prebuild won't duplicate the block.
 *
 * Caveat: the resulting APK won't run on x86 emulators. If you ever
 * need to debug on an emulator, build via `expo run:android` (which
 * uses your local Android SDK and respects the Studio AVD's ABI) or
 * temporarily disable this plugin.
 */
const {
  withAppBuildGradle,
  withGradleProperties,
} = require("@expo/config-plugins");

const DEFAULT_CONFIG_MARKER_START = "// >>> ithasfire-arm64-only";
const DEFAULT_CONFIG_MARKER_END = "// <<< ithasfire-arm64-only";
const PACKAGING_MARKER_START = "// >>> ithasfire-arm64-only-packaging";
const PACKAGING_MARKER_END = "// <<< ithasfire-arm64-only-packaging";

// `ndk { abiFilters }` in defaultConfig filters newly-compiled native
// code — important for any `.so` we build from source.
const NDK_BLOCK = [
  DEFAULT_CONFIG_MARKER_START,
  "        ndk {",
  "            abiFilters 'arm64-v8a'",
  "        }",
  DEFAULT_CONFIG_MARKER_END,
].join("\n");

// `packagingOptions.jniLibs.excludes` strips pre-built `.so` files
// shipped by AAR / native-module dependencies (Stripe Terminal,
// expo-camera, etc. all ship libs for every ABI). Without this, the
// universal APK still ships armeabi-v7a / x86 / x86_64 binaries that
// add no value on a modern arm64 phone.
const PACKAGING_BLOCK = [
  PACKAGING_MARKER_START,
  "    packagingOptions {",
  "        jniLibs {",
  "            excludes += [",
  "                'lib/armeabi-v7a/**',",
  "                'lib/x86/**',",
  "                'lib/x86_64/**',",
  "            ]",
  "        }",
  "    }",
  PACKAGING_MARKER_END,
].join("\n");

/**
 * Step 1 of 2 — set `reactNativeArchitectures=arm64-v8a` in
 * gradle.properties so RN's own packaging path (libreactnative,
 * libhermes, libjsi, libfbjni, libc++_shared) only ships the arm64
 * variants. `packagingOptions.jniLibs.excludes` doesn't reach these
 * libs because RN merges them through a separate pipeline.
 */
function setGradleProperty(modResults, key, value) {
  const idx = modResults.findIndex(
    (item) => item.type === "property" && item.key === key,
  );
  const entry = { type: "property", key, value };
  if (idx >= 0) modResults[idx] = entry;
  else modResults.push(entry);
}

function withReactNativeArchitectures(config) {
  return withGradleProperties(config, (cfg) => {
    setGradleProperty(cfg.modResults, "reactNativeArchitectures", "arm64-v8a");
    // R8 / proguard on a Stripe-Terminal-sized release APK needs more
    // headroom than the Expo template's 2 GiB default — the JVM thrashes
    // GC during the `minifyReleaseWithR8` task and the gradle daemon
    // crashes. Bumping the heap here means `prebuild --clean` rebuilds
    // come up build-ready instead of failing on first invocation.
    setGradleProperty(
      cfg.modResults,
      "org.gradle.jvmargs",
      "-Xmx6144m -XX:MaxMetaspaceSize=1024m",
    );
    return cfg;
  });
}

module.exports = function withArm64OnlyAndroid(config) {
  config = withReactNativeArchitectures(config);
  return withAppBuildGradle(config, (cfg) => {
    let contents = cfg.modResults.contents;

    if (!contents.includes(DEFAULT_CONFIG_MARKER_START)) {
      // Anchor on the `defaultConfig {` opener; the indentation matches
      // the standard Expo template. If RN ever changes the gradle
      // scaffold and this anchor disappears, the plugin throws so we
      // catch the drift in CI rather than silently shipping universal
      // APKs again.
      const anchor = "defaultConfig {";
      const idx = contents.indexOf(anchor);
      if (idx === -1) {
        throw new Error(
          "[with-arm64-only-android] Could not find `defaultConfig {` in android/app/build.gradle. " +
            "The Expo Android template changed — update this plugin's anchor.",
        );
      }
      const insertAt = idx + anchor.length;
      contents =
        contents.slice(0, insertAt) +
        "\n" +
        NDK_BLOCK +
        contents.slice(insertAt);
    }

    if (!contents.includes(PACKAGING_MARKER_START)) {
      // Inject the packaging block at the top of the `android { ... }`
      // block so it applies to every variant (debug + release).
      const anchor = "android {";
      const idx = contents.indexOf(anchor);
      if (idx === -1) {
        throw new Error(
          "[with-arm64-only-android] Could not find `android {` in android/app/build.gradle.",
        );
      }
      const insertAt = idx + anchor.length;
      contents =
        contents.slice(0, insertAt) +
        "\n" +
        PACKAGING_BLOCK +
        contents.slice(insertAt);
    }

    cfg.modResults.contents = contents;
    return cfg;
  });
};

// @ts-check
/**
 * Expo config plugin: fail-fast guard on local debug-signed release APKs.
 *
 * Out of the box, `android/app/build.gradle` ships with
 * `release { signingConfig signingConfigs.debug }` — a sane default for
 * the React Native template (EAS replaces it at build time with managed
 * credentials, and that's where every distributable build comes from).
 * It's a footgun for local devs: `./gradlew assembleRelease` produces a
 * release-mode APK signed with the *debug* keystore. That APK installs
 * fine over USB, looks like a real release build, and cannot be uploaded
 * to Play. People accidentally hand it to testers or PMs as "the prod
 * build" all the time.
 *
 * If `EAS_BUILD=true` is exported (the EAS runner sets it), the guard stands
 * down. Otherwise a release build aborts unless the dev opts in via
 * `-PallowLocalReleaseDebugSigning=true`, which is the right escape hatch for
 * sideloading a release APK onto an internal tester's phone over `adb install`.
 *
 * ## Why this is a task-graph hook and NOT a statement inside `release { }`
 *
 * The first version of this plugin injected the `throw` directly into the body
 * of the `release { }` block, on the theory that the block only runs for
 * release builds. **It doesn't.** Gradle evaluates every `buildTypes` closure
 * during the CONFIGURATION phase, for whatever task you invoked — so the guard
 * fired on `assembleDebug` too, and `expo run:android` could not build the app
 * at all. Every local Android build failed with a message about release
 * signing, and the only way through was to pass the escape hatch that
 * *licenses* debug-signed release APKs — the exact thing the guard exists to
 * prevent.
 *
 * So the check now runs in `gradle.taskGraph.whenReady`, which fires after the
 * graph is built but before any task executes: it can still abort before work
 * happens, but it can also see *which* tasks were actually requested. It is
 * emitted at the TOP LEVEL of the file rather than nested in the Android DSL,
 * because `gradle` / `project` / `findProperty` resolve unambiguously there
 * (inside `android { }` they only work via Groovy's owner fallback, which is
 * exactly the kind of fragility that produced the original bug).
 *
 * If you are tempted to move this back inside `release { }`: don't. Run
 * `./gradlew app:assembleDebug` afterwards and you will reproduce the outage.
 *
 * ## Task-name coverage
 *
 * `package` must stay in the alternation. AGP's actual APK-packaging task is
 * `packageRelease`, and `assembleRelease` DEPENDS on it rather than the other
 * way round — so without `package` the guard was bypassable with a single
 * `./gradlew :app:packageRelease`, which produces the same debug-signed
 * release APK the guard exists to prevent.
 *
 * Known limitation: with Gradle's configuration cache enabled, a cache HIT
 * skips configuration-phase callbacks including `taskGraph.whenReady`, so the
 * guard would not fire. Neither Expo nor the RN template enables it today; if
 * that changes, this needs to move to a task-level `doFirst` instead.
 */
const { withAppBuildGradle } = require("@expo/config-plugins");

const GUARD_MARKER = "// >>> hf:release-signing-guard";
const GUARD_BLOCK = `
${GUARD_MARKER}
// See scripts/with-release-signing-guard.js. This MUST stay a taskGraph hook at
// the top level — inlining it into \`release { }\` breaks every debug build,
// because Gradle evaluates buildType closures during configuration.
def hfAllowDebugSigning =
    System.getenv("EAS_BUILD")?.equals("true") ||
    findProperty("allowLocalReleaseDebugSigning") == "true"
gradle.taskGraph.whenReady { graph ->
    if (hfAllowDebugSigning) {
        return
    }
    def releaseTasks = graph.allTasks.findAll {
        it.project.path == project.path &&
        it.name ==~ /(assemble|bundle|install|publish|package)\\w*Release\\w*/
    }
    if (!releaseTasks.isEmpty()) {
        throw new GradleException(
            "[scanner] Refusing to assemble a debug-signed release APK " +
            "(requested: " + releaseTasks*.name.join(", ") + "). " +
            "Local release builds fall back to the debug keystore, which " +
            "cannot be uploaded to Play and shouldn't be handed to " +
            "testers as a production build. Use EAS for distributable " +
            "artefacts; pass '-PallowLocalReleaseDebugSigning=true' if " +
            "you genuinely want a sideload-only release APK."
        )
    }
}
// <<< hf:release-signing-guard
`;

/**
 * @type {import('@expo/config-plugins').ConfigPlugin}
 */
const withReleaseSigningGuard = (config) =>
  withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.contents.includes(GUARD_MARKER)) {
      return cfg;
    }
    // The guard is appended at the end of the file, but we still assert the
    // footgun it guards against is actually present. If a future React Native
    // template stops pinning debug signing for the release variant, this guard
    // is obsolete and should be deleted rather than silently kept alive — so
    // fail loudly instead of falling back to a no-op.
    const anchor =
      /(release\s*\{[^}]*?)(\n[ \t]*signingConfig\s+signingConfigs\.debug)/;
    if (!anchor.test(cfg.modResults.contents)) {
      throw new Error(
        "with-release-signing-guard: couldn't find the release { signingConfig signingConfigs.debug } anchor in android/app/build.gradle. The template may no longer default the release variant to debug signing — if so this plugin is obsolete and should be removed, not updated to match.",
      );
    }
    cfg.modResults.contents = `${cfg.modResults.contents.trimEnd()}\n${GUARD_BLOCK}`;
    return cfg;
  });

module.exports = withReleaseSigningGuard;

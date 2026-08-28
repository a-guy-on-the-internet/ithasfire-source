import { useEffect, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import {
  AlertTriangle,
  Fingerprint,
  LogOut,
  Moon,
  RefreshCw,
  Server,
  Sun,
  Vibrate,
  Volume2,
  VolumeX,
  X,
  Zap,
} from "lucide-react-native";
import { formatAuthErrorMessage } from "@th/errors";

import { getAppVersion } from "../lib/app-info";
import { getAppEnv } from "../lib/capabilities";
import {
  getApiBaseUrl,
  getApiBaseUrlOverride,
  getAuthOrigin,
  setApiBaseUrlOverride,
  setAuthOriginOverride,
  setWebBaseUrlOverride,
} from "../config/api";
import {
  Column,
  Panel,
  ScreenSurface,
  Text,
  TopBar,
  useColors,
  useIsDarkTheme,
  useNativeTheme,
  useThemedSheet,
  type NativePalette,
} from "@th/ui-native";
import {
  addPasskey,
  isPasskeySupported,
  listUserPasskeys,
} from "../features/auth/passkey-client";
import {
  collectExistingPasskeyNames,
  scannerPasskeyName,
} from "../features/auth/passkey-name";
import { showErrorToast, showSuccessToast } from "../lib/toast";
import { useDroppedScans } from "../lib/use-dropped-scans";
import { safeTimeString } from "../lib/format";

export const SettingsScreen = ({
  userEmail,
  userName,
  soundEnabled,
  hapticsEnabled,
  expressModeEnabled,
  onToggleSound,
  onToggleHaptics,
  onToggleExpressMode,
  onSignOut,
  onBack,
}: {
  userEmail: string;
  userName?: string | null;
  soundEnabled: boolean;
  hapticsEnabled: boolean;
  /** FR-004. Default OFF; per-device; reset on sign-out. */
  expressModeEnabled: boolean;
  onToggleSound: (next: boolean) => void;
  onToggleHaptics: (next: boolean) => void;
  onToggleExpressMode: (next: boolean) => void;
  onSignOut: () => Promise<void>;
  onBack: () => void;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const isDarkTheme = useIsDarkTheme();
  const { setTheme, isHydrated: themeHydrated } = useNativeTheme();
  const [enrolling, setEnrolling] = useState(false);
  const passkeySupported = isPasskeySupported();

  // Developer URL overrides — the whole panel is hidden on production
  // binaries (see render guard below) and the resolver also rejects
  // overrides in production as defense in depth.
  //
  // Three values flip together for environment presets (Localhost vs
  // api-dev) because passkeys derive the WebAuthn RP ID from the auth
  // origin's hostname — mixing localhost API with api-dev auth would
  // break enrollment with "RP ID cannot be validated."
  const devOverridesAllowed = getAppEnv() !== "production";
  const [apiOverride, setApiOverrideState] = useState<string>(
    getApiBaseUrlOverride() ?? "",
  );
  const [savingOverride, setSavingOverride] = useState(false);
  const [activeApi, setActiveApi] = useState<string>(getApiBaseUrl());
  const [activeAuthOrigin, setActiveAuthOrigin] =
    useState<string>(getAuthOrigin());

  const handleSaveOverride = async () => {
    setSavingOverride(true);
    try {
      const next = apiOverride.trim() || null;
      await setApiBaseUrlOverride(next);
      setActiveApi(getApiBaseUrl());
      showSuccessToast(
        next ? "API URL pinned" : "API URL reset",
        next
          ? "Sign out and back in to repoint the active session."
          : "Reverted to the build-time default. Sign out and back in to apply.",
      );
    } catch (err) {
      showErrorToast(
        "Couldn't save API URL",
        err instanceof Error ? err.message : "Try again.",
      );
    } finally {
      setSavingOverride(false);
    }
  };

  // Apply a triple-override preset (API + Web + Auth Origin) atomically.
  // Local API/Web presets still keep Auth Origin on web-dev so Android
  // Credential Manager gets a public, assetlinks-backed WebAuthn RP ID.
  const applyPreset = async (preset: {
    api: string;
    web: string;
    auth: string;
    label: string;
  }) => {
    setSavingOverride(true);
    try {
      await Promise.all([
        setApiBaseUrlOverride(preset.api),
        setWebBaseUrlOverride(preset.web),
        setAuthOriginOverride(preset.auth),
      ]);
      setApiOverrideState(preset.api);
      setActiveApi(getApiBaseUrl());
      setActiveAuthOrigin(getAuthOrigin());
      showSuccessToast(
        `Pinned to ${preset.label}`,
        "Restart the app to apply (auth origin is captured at boot).",
      );
    } catch (err) {
      showErrorToast(
        "Couldn't apply preset",
        err instanceof Error ? err.message : "Try again.",
      );
    } finally {
      setSavingOverride(false);
    }
  };

  const clearPresets = async () => {
    setSavingOverride(true);
    try {
      await Promise.all([
        setApiBaseUrlOverride(null),
        setWebBaseUrlOverride(null),
        setAuthOriginOverride(null),
      ]);
      setApiOverrideState("");
      setActiveApi(getApiBaseUrl());
      setActiveAuthOrigin(getAuthOrigin());
      showSuccessToast(
        "Overrides cleared",
        "Reverted to build-time defaults. Restart to apply.",
      );
    } catch (err) {
      showErrorToast(
        "Couldn't clear overrides",
        err instanceof Error ? err.message : "Try again.",
      );
    } finally {
      setSavingOverride(false);
    }
  };

  useEffect(() => {
    // Re-sync if another surface (e.g. a dev menu) mutates the override
    // while this screen is mounted. Cheap — runs once per focus.
    setApiOverrideState(getApiBaseUrlOverride() ?? "");
    setActiveApi(getApiBaseUrl());
    setActiveAuthOrigin(getAuthOrigin());
  }, []);

  const handleAddPasskey = async () => {
    if (enrolling) return;
    setEnrolling(true);
    try {
      // Best effort, and time-boxed inside the helper: this is the surface an
      // operator uses to add a SECOND (or third) passkey, so it is the one
      // place where a collision suffix earns its round-trip. Without it two
      // Android scanners both enrol as "Tom’s Android scanner" and the web
      // passkey list shows two indistinguishable rows — including two
      // identical "Remove Tom’s Android scanner" screen-reader labels next to
      // an unconfirmed delete. The post-sign-in enroll prompt deliberately
      // skips this fetch; see the note in `passkey-name.ts`.
      const existingNames = await collectExistingPasskeyNames(listUserPasskeys);
      const result = await addPasskey(
        scannerPasskeyName(userName, existingNames),
      );
      if (result.error) {
        // user_cancelled is silent — they tapped Cancel intentionally.
        if (result.error.code !== "user_cancelled") {
          if (typeof __DEV__ !== "undefined" && __DEV__) {
            // eslint-disable-next-line no-console
            console.warn(
              "[passkey-enroll] addPasskey failed (dev-only)",
              result.error,
            );
          }
          showErrorToast("Couldn't add passkey", result.error.message);
        }
        return;
      }
      showSuccessToast(
        "Passkey added",
        "You can use it next time you sign in.",
      );
    } catch (err) {
      showErrorToast("Couldn't add passkey", formatAuthErrorMessage(err));
    } finally {
      setEnrolling(false);
    }
  };

  return (
    <ScreenSurface testID="scanner-settings-screen">
      <TopBar title="Settings" subtitle={userEmail} onBack={onBack} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Panel>
          <Column gap={12}>
            <Text variant="caption" style={styles.sectionLabel}>
              FEEDBACK
            </Text>
            <SettingRow
              label="Sound"
              description="Play a tone on each scan outcome."
              icon={
                soundEnabled ? (
                  <Volume2 size={18} color={colors.color} />
                ) : (
                  <VolumeX size={18} color={colors.colorMuted} />
                )
              }
              active={soundEnabled}
              onToggle={() => onToggleSound(!soundEnabled)}
              testID="settings-toggle-sound"
            />
            <SettingRow
              label="Haptics"
              description="Vibrate on each scan outcome."
              icon={
                <Vibrate
                  size={18}
                  color={hapticsEnabled ? colors.color : colors.colorMuted}
                />
              }
              active={hapticsEnabled}
              onToggle={() => onToggleHaptics(!hapticsEnabled)}
              testID="settings-toggle-haptics"
            />
            {/*
              FR-004. Default OFF and it lives HERE rather than on the scan
              screen on purpose: this is the only control in the app that lets
              someone through a door with no operator gesture, so turning it on
              should be a deliberate trip to Settings, not a stray thumb during
              a rush. The description says what halts, because "auto-admit"
              alone reads as "admits everything".

              The stats strip carries a persistent ⚡ while it is on — a mode
              this consequential must never be invisible.
            */}
            <SettingRow
              label="Auto-admit valid tickets"
              description="Express mode: a valid ticket admits itself and the camera re-arms after about a second. Anything else — already scanned, wrong event, refunded, voided, listed, unreadable, or a volunteer pass — still stops and waits for you."
              icon={
                <Zap
                  size={18}
                  color={
                    expressModeEnabled ? colors.accentText : colors.colorMuted
                  }
                />
              }
              active={expressModeEnabled}
              onToggle={() => onToggleExpressMode(!expressModeEnabled)}
              testID="settings-toggle-express-mode"
            />
          </Column>
        </Panel>

        <FailedSyncPanel />

        {/*
          Appearance. Stub (warm paper) is the default, matching the web app.
          Ember is the opt-in, and it earns its place: operators run shifts in
          dark rooms, where a full-brightness cream canvas next to a dark stage
          costs them their night vision. The framing is "turn the dark theme on"
          rather than "turn the light theme off" because the default is light.

          Either way the camera view stays dark — the viewfinder and its overlay
          controls paint on the video feed, so they use the theme-invariant FIXED
          values.
        */}
        <Panel>
          <Column gap={12}>
            <Text variant="caption" style={styles.sectionLabel}>
              APPEARANCE
            </Text>
            {/*
              Gated on `themeHydrated`: until SecureStore resolves, `isDarkTheme`
              reflects the DEFAULT rather than the operator's stored choice, so
              an Ember device would flash this row as OFF and look like it had
              forgotten the preference.
            */}
            <SettingRow
              label="Dark theme"
              description="Navy instead of warm paper. Easier on your eyes in a dark venue; the camera view stays dark either way."
              icon={
                isDarkTheme ? (
                  <Moon size={18} color={colors.color} />
                ) : (
                  <Sun size={18} color={colors.colorMuted} />
                )
              }
              active={isDarkTheme}
              disabled={!themeHydrated}
              onToggle={() => setTheme(isDarkTheme ? "stub" : "ember")}
              testID="settings-toggle-theme"
            />
          </Column>
        </Panel>

        {passkeySupported ? (
          <Panel>
            <Column gap={12}>
              <Text variant="caption" style={styles.sectionLabel}>
                SECURITY
              </Text>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  void handleAddPasskey();
                }}
                disabled={enrolling}
                style={[styles.row, enrolling && styles.inert]}
                testID="settings-add-passkey-button"
              >
                <View style={styles.rowIcon}>
                  <Fingerprint size={18} color={colors.color} />
                </View>
                <Column flex gap={2}>
                  <Text variant="body" weight="bold" color={colors.color}>
                    {enrolling ? "Waiting…" : "Add a passkey"}
                  </Text>
                  <Text variant="bodySmall" color={colors.colorMuted}>
                    Skip the password next time you sign in on this device.
                  </Text>
                </Column>
              </Pressable>
            </Column>
          </Panel>
        ) : null}

        <Panel>
          <Column gap={12}>
            <Text variant="caption" style={styles.sectionLabel}>
              ACCOUNT
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                void onSignOut();
              }}
              style={styles.signOutRow}
              testID="settings-sign-out-button"
            >
              <LogOut size={18} color={colors.dangerSoft} />
              <Column flex gap={2}>
                <Text variant="body" weight="bold" color={colors.dangerSoft}>
                  Sign out
                </Text>
                <Text variant="bodySmall" color={colors.colorMuted}>
                  {userEmail}
                </Text>
              </Column>
            </Pressable>
          </Column>
        </Panel>

        {devOverridesAllowed ? (
          <Panel>
            <Column gap={12}>
              <Text variant="caption" style={styles.sectionLabel}>
                DEVELOPER
              </Text>
              <View style={styles.devRow}>
                <View style={styles.rowIcon}>
                  <Server size={18} color={colors.color} />
                </View>
                <Column flex gap={6}>
                  <Text variant="body" weight="bold" color={colors.color}>
                    Environment
                  </Text>
                  <Text variant="bodySmall" color={colors.colorMuted}>
                    Flip API + Web + Auth Origin together. Passkeys need a
                    public RP ID (web-dev), so localhost can't enroll one.
                  </Text>
                  <Text variant="caption" color={colors.colorMuted}>
                    API: {activeApi}
                  </Text>
                  <Text variant="caption" color={colors.colorMuted}>
                    Auth: {activeAuthOrigin}
                  </Text>
                  <View style={styles.presetRow}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        void applyPreset({
                          api: "http://localhost:3001",
                          web: "http://localhost:3000",
                          auth: "https://web-dev.ithasfire.com",
                          label: "Localhost",
                        });
                      }}
                      disabled={savingOverride}
                      style={[
                        styles.presetChip,
                        savingOverride && styles.inert,
                      ]}
                      testID="settings-preset-localhost"
                    >
                      <Text
                        variant="bodySmall"
                        weight="bold"
                        color={colors.color}
                      >
                        Localhost
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        void applyPreset({
                          api: "https://api-dev.ithasfire.com",
                          web: "https://web-dev.ithasfire.com",
                          // Auth origin MUST match api-dev's WebAuthn RP ID,
                          // which is derived from PUBLIC_WEB_URL (web-dev).
                          // assetlinks.json is served from both apex and
                          // web-dev (same Next.js public dir), so cross-device
                          // passkey verification works. Pointing this at the
                          // apex would (a) fail Better Auth's originCheck
                          // because dev's trustedOrigins doesn't include it
                          // and (b) mismatch the RP ID stored in the
                          // credential during /generate-register-options.
                          auth: "https://web-dev.ithasfire.com",
                          label: "api-dev",
                        });
                      }}
                      disabled={savingOverride}
                      style={[
                        styles.presetChip,
                        savingOverride && styles.inert,
                      ]}
                      testID="settings-preset-api-dev"
                    >
                      <Text
                        variant="bodySmall"
                        weight="bold"
                        color={colors.color}
                      >
                        api-dev
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        void clearPresets();
                      }}
                      disabled={savingOverride}
                      style={[
                        styles.presetChip,
                        savingOverride && styles.inert,
                      ]}
                      testID="settings-preset-clear"
                    >
                      <Text
                        variant="bodySmall"
                        weight="bold"
                        color={colors.colorMuted}
                      >
                        Clear
                      </Text>
                    </Pressable>
                  </View>
                  <Text
                    variant="bodySmall"
                    color={colors.colorMuted}
                    style={{ marginTop: 8 }}
                  >
                    Or pin a custom API URL (LAN IP, ngrok, etc.) — leaves Web +
                    Auth Origin on their current values.
                  </Text>
                  <TextInput
                    value={apiOverride}
                    onChangeText={setApiOverrideState}
                    placeholder="http://192.168.1.42:3001"
                    placeholderTextColor={colors.placeholder}
                    autoCapitalize="none"
                    autoCorrect={false}
                    inputMode="url"
                    style={styles.devInput}
                    testID="settings-api-override-input"
                  />
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      void handleSaveOverride();
                    }}
                    disabled={savingOverride}
                    style={[
                      styles.devSaveButton,
                      savingOverride && styles.inert,
                    ]}
                    testID="settings-api-override-save"
                  >
                    <Text
                      variant="bodySmall"
                      weight="bold"
                      // Must follow the FILL. `styles.inert` swaps the fill to
                      // `surfaceMuted` while saving; leaving the label on
                      // `onCta` stranded white-on-cream at 1.23:1 (Stub) and
                      // ink-on-navy at 1.33:1 (Ember) — the "SAVING…" text
                      // simply vanished. Migrating a fill to a token means
                      // migrating its foreground too.
                      color={savingOverride ? colors.colorMuted : colors.onCta}
                      style={{ letterSpacing: 1.2 }}
                    >
                      {savingOverride
                        ? "SAVING…"
                        : apiOverride.trim().length === 0
                          ? "RESET API ONLY"
                          : "PIN API ONLY"}
                    </Text>
                  </Pressable>
                </Column>
              </View>
            </Column>
          </Panel>
        ) : null}

        <Text variant="caption" style={styles.version}>
          v{getAppVersion()}
        </Text>
      </ScrollView>
    </ScreenSurface>
  );
};

/**
 * FR-010 — the failed-sync list.
 *
 * Every row here is a ticket that was admitted AT THE DOOR and that the server
 * has no record of: the operator saw the green state, the local counter moved,
 * the person walked in, and the queue gave up. Before this the row was simply
 * DELETEd and nobody ever found out.
 *
 * ## Retry-all, not per-row
 *
 * The design's open question leaned retry-all and this follows it. Per-row
 * retry asks a door operator to triage a queue whose only correct triage is
 * "all of them" — a row is here precisely because nothing recovers it
 * automatically, so there is no row anyone would rationally skip. Rows still
 * clear individually as they succeed, so one failure cannot strand nine
 * successes.
 *
 * ## The codes are shown, deliberately (NFR-005)
 *
 * These are codes the operator already scanned — the same exposure the
 * recent-scans strip carries — and without them "3 scans failed" is not
 * something anyone can act on. The panel renders NOTHING when the list is
 * empty, so there is no idle surface displaying credentials.
 */
const FailedSyncPanel = () => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  const { rows, retrying, retryAll, dismiss } = useDroppedScans();

  if (rows.length === 0) return null;

  const handleRetryAll = async () => {
    const outcome = await retryAll();
    if (outcome.remaining === 0) {
      showSuccessToast(
        "Synced",
        `${outcome.succeeded} scan${outcome.succeeded === 1 ? "" : "s"} recorded on the server.`,
      );
      return;
    }
    showErrorToast(
      `${outcome.remaining} still failing`,
      outcome.succeeded > 0
        ? `${outcome.succeeded} synced. Check your connection and try again.`
        : "Check your connection and try again.",
    );
  };

  return (
    <Panel>
      <Column gap={12}>
        <Text variant="caption" style={styles.sectionLabel}>
          FAILED TO SYNC
        </Text>
        <View style={styles.failedHeader}>
          {/*
            `warningSoft`, not `support`: this is a GLYPH on a themed surface
            and `support` measures 1.75:1 against Stub's. The rule is `support`
            is a fill, `warningSoft` is a rule/glyph/label.
          */}
          <AlertTriangle size={18} color={colors.warningSoft} />
          <Column flex gap={2}>
            <Text variant="body" weight="bold" color={colors.color}>
              {rows.length} scan{rows.length === 1 ? "" : "s"} never reached the
              server
            </Text>
            <Text variant="bodySmall" color={colors.colorMuted}>
              These people were admitted at the door but the server has no
              record. Retrying is safe — it replays the original scan, so one
              the server did receive stays a single admission.
            </Text>
          </Column>
        </View>

        {rows.map((row) => (
          <View key={row.dropId} style={styles.failedRow}>
            <Column flex gap={2}>
              <Text variant="bodySmall" weight="bold" color={colors.color}>
                {row.ticketCode}
              </Text>
              <Text variant="caption" color={colors.colorMuted}>
                {safeTimeString(row.droppedAt) ?? "—"} ·{" "}
                {row.reason === "permanent_error"
                  ? "rejected"
                  : `${row.attempts} attempts`}
              </Text>
            </Column>
            {/*
              A row the server rejected outright (BAD_REQUEST / FORBIDDEN)
              re-fails on every RETRY ALL, forever — and it sits behind a
              `⚠ N FAILED` chip that outranks everything else in the strip's
              collapse ladder BECAUSE it means "someone got in and the server
              does not know". A chip that can never return to zero teaches the
              operator to ignore it, and the next real drop is invisible again.

              Dismissal is never a silent delete: `useDroppedScans.dismiss`
              writes a Sentry event first, so the only record that an admission
              went unreconciled outlives the row.
            */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Dismiss failed scan ${row.ticketCode}`}
              accessibilityHint="Removes this row without recording it on the server. Use only when a retry will never succeed; the dismissal is logged."
              onPress={() => dismiss(row)}
              disabled={retrying}
              style={[styles.failedDismiss, retrying && styles.inert]}
              testID={`settings-dismiss-failed-scan-${row.dropId}`}
            >
              <X size={16} color={colors.colorMuted} />
            </Pressable>
          </View>
        ))}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Retry all ${rows.length} failed scans`}
          accessibilityHint="Replays each failed admission using its original scan key, so a scan the server already recorded is not counted twice."
          onPress={() => {
            void handleRetryAll();
          }}
          disabled={retrying}
          style={[styles.devSaveButton, retrying && styles.inert]}
          testID="settings-retry-failed-scans"
        >
          <View style={styles.failedRetryLabel}>
            <RefreshCw
              size={14}
              color={retrying ? colors.colorMuted : colors.onCta}
            />
            <Text
              variant="bodySmall"
              weight="bold"
              // Follows the FILL: `inert` swaps it to `surfaceMuted`, and an
              // `onCta` label there is white-on-cream at 1.23:1.
              color={retrying ? colors.colorMuted : colors.onCta}
              style={{ letterSpacing: 1.2 }}
            >
              {retrying ? "RETRYING…" : "RETRY ALL"}
            </Text>
          </View>
        </Pressable>
      </Column>
    </Panel>
  );
};

const SettingRow = ({
  label,
  description,
  icon,
  active,
  disabled = false,
  onToggle,
  testID,
}: {
  label: string;
  description: string;
  icon: React.ReactNode;
  active: boolean;
  /** Inert while the underlying value is still resolving. */
  disabled?: boolean;
  onToggle: () => void;
  testID?: string;
}) => {
  const colors = useColors();
  const styles = useThemedSheet(makeSheet);
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: active, disabled }}
      onPress={onToggle}
      disabled={disabled}
      style={[styles.row, disabled && styles.inert]}
      testID={testID}
    >
      <View style={styles.rowIcon}>{icon}</View>
      <Column flex gap={2}>
        <Text variant="body" weight="bold" color={colors.color}>
          {label}
        </Text>
        <Text variant="bodySmall" color={colors.colorMuted}>
          {description}
        </Text>
      </Column>
      <View style={[styles.pill, active ? styles.pillOn : styles.pillOff]}>
        <Text
          variant="caption"
          weight="bold"
          style={[
            styles.pillText,
            // ON = orange fill → ink label (5.5:1); OFF = muted on the dark surface.
            { color: active ? colors.onCta : colors.colorMuted },
          ]}
        >
          {active ? "ON" : "OFF"}
        </Text>
      </View>
    </Pressable>
  );
};

const makeSheet = (colors: NativePalette) =>
  StyleSheet.create({
    sectionLabel: {
      color: colors.colorMuted,
      fontSize: 10,
      letterSpacing: 2,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 8,
      minHeight: 44,
    },
    rowIcon: {
      width: 32,
      height: 32,
      alignItems: "center",
      justifyContent: "center",
    },
    pill: {
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderWidth: 1,
      minWidth: 48,
      alignItems: "center",
    },
    pillOn: {
      // `ctaFill`, not `accent` — this fill carries an `onCta` label, and on Stub
      // white-on-#E2481D is 4.06:1. `ctaFill` rests at #B93312 (5.92:1) there.
      backgroundColor: colors.ctaFill,
      borderColor: colors.ctaFill,
    },
    pillOff: {
      backgroundColor: "transparent",
      borderColor: colors.colorMuted,
    },
    pillText: {
      fontSize: 10,
      letterSpacing: 1.5,
    },
    signOutRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 8,
      minHeight: 44,
    },
    version: {
      color: colors.colorMuted,
      textAlign: "center",
      fontSize: 10,
      marginTop: 16,
    },
    devRow: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      paddingVertical: 8,
    },
    devInput: {
      borderWidth: 2,
      borderColor: colors.borderColor,
      backgroundColor: colors.surfaceRaised,
      color: colors.color,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
      minHeight: 44,
    },
    devSaveButton: {
      backgroundColor: colors.ctaFill,
      borderWidth: 2,
      borderColor: colors.ctaFill,
      paddingVertical: 10,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
    },
    scroll: {
      flex: 1,
    },
    scrollContent: {
      gap: 16,
      paddingBottom: 24,
    },
    presetRow: {
      flexDirection: "row",
      gap: 8,
      marginTop: 4,
    },
    /**
     * Inert (disabled / busy) treatment — TOKENS, never `opacity`.
     *
     * `opacity` on a filled control blends BOTH the fill and its label toward
     * the canvas, so the pair collapses: a white-on-ctaFill button at 0.5
     * measures 2.38:1 on Stub and 2.20:1 on Ember, and the on-device reading
     * for the sign-in CTA was 1.64:1. This treatment holds ~6:1 in both themes.
     */
    inert: {
      backgroundColor: colors.surfaceMuted,
      borderColor: colors.borderColorSoft,
    },
    failedHeader: {
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
      paddingVertical: 4,
    },
    failedRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 6,
      borderTopWidth: 1,
      borderTopColor: colors.borderColorSoft,
    },
    failedRetryLabel: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    /**
     * 44×44 — the row's own height is content-sized, so the target has to carry
     * the minimum itself. Icon-only and `colorMuted`: this is the row's
     * SECONDARY action (RETRY ALL is the primary one) and it must not read as
     * the thing to do.
     */
    failedDismiss: {
      width: 44,
      minHeight: 44,
      alignItems: "center",
      justifyContent: "center",
      borderWidth: 1,
      borderColor: colors.borderColorSoft,
    },
    presetChip: {
      flex: 1,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderWidth: 1,
      borderColor: colors.borderColor,
      alignItems: "center",
      justifyContent: "center",
      minHeight: 44,
    },
  });

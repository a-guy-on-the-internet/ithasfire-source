import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

// `Embers` takes an app-supplied `iconSource` — see `ui/loading-state.tsx`.
import { Embers } from "@th/ui";

import { useScannerSession } from "./features/auth/use-scanner-session";
import { setFeedbackPrefs } from "./lib/feedback";
import {
  applyScanFeedbackToggle,
  scanFeedbackEnabled,
} from "./lib/scan-feedback-plan";
import { useLocalSync } from "./lib/use-local-sync";
import { useScanQueue } from "./lib/use-scan-queue";
import {
  AccessDeniedScreen,
  HomeScreen,
  LookupScreen,
  PasskeyEnrollPromptScreen,
  SignInScreen,
  UnifiedScanScreen,
} from "./screens";
import { SettingsScreen } from "./screens/settings-screen";
import { SellTabScreen } from "./features/pos/sell-tab-screen";
import { trpc } from "./trpc";
import { AppShell, type NavTab } from "./ui/app-shell";
import { FIXED, Panel, ScreenSurface, Text } from "@th/ui-native";
import type { SelectableEvent } from "./ui/event-selector";
import { FadeRoot, SlideScreen } from "./ui/fade-screen";
import { NetworkBanner } from "./ui/network-banner";

const SPLASH_ICON = require("../assets/splash-icon.png");

/**
 * Wraps a screen rendered outside `AppShell` (sign-in, access-denied,
 * bootstrapping, no-event fallback) so the global connectivity banner is
 * still visible. Mirrors the shell's banner-above-content placement.
 */
const BypassShell = ({ children }: { children: React.ReactNode }) => (
  <SafeAreaView edges={["top"]} style={{ flex: 1 }}>
    <NetworkBanner />
    {children}
  </SafeAreaView>
);

type ActiveScreen = "home" | "scan" | "sell" | "settings" | "lookup";

const screenToTab = (screen: ActiveScreen): NavTab => {
  if (screen === "settings") return "settings";
  if (screen === "sell") return "sell";
  if (screen === "scan") return "scan";
  // Lookup is reached from Home and stays under it — it is a way of finding
  // someone when the QR won't scan, not a destination of its own.
  return "home";
};

export const ScannerApp = () => {
  const {
    user,
    isBootstrapping,
    preferences,
    resolvedEvent,
    updatePreferences,
    signInWithPassword,
    signUpWithPassword,
    signInWithPasskey,
    signInWithOAuth,
    signOut,
    accessDenied,
    sessionContext,
  } = useScannerSession();
  const [activeScreen, setActiveScreen] = useState<ActiveScreen>("home");
  const authed = !!user && !accessDenied;

  // True for the duration of the post-sign-in passkey-enrollment prompt.
  // Set to true when the operator signs in via password or OAuth (and they
  // haven't already dismissed the prompt). Cleared on passkey sign-in (no need
  // to prompt — they already have one) and after enrollment / skip.
  const [showPasskeyPrompt, setShowPasskeyPrompt] = useState(false);
  // Brand-new account vs returning operator. Drives the prompt's title
  // and body copy: post-signup gets "SECURE THIS ACCOUNT" framing,
  // post-signin gets "ADD A PASSKEY / skip the password next time".
  const [passkeyPromptVariant, setPasskeyPromptVariant] = useState<
    "post-signin" | "post-signup"
  >("post-signin");
  const dismissPasskeyPrompt = useCallback(async () => {
    setShowPasskeyPrompt(false);
    if (preferences) {
      await updatePreferences({ ...preferences, passkeyPromptDismissed: true });
    }
  }, [preferences, updatePreferences]);

  const handleSignInWithPassword = useCallback(
    async (email: string, password: string) => {
      await signInWithPassword(email, password);
      if (preferences && !preferences.passkeyPromptDismissed)
        setShowPasskeyPrompt(true);
    },
    [signInWithPassword, preferences],
  );

  // Same post-sign-in passkey nudge applies to brand-new sign-ups — they
  // just created their account with an email + password, no passkey yet.
  // Marks the variant as `post-signup` so the prompt copy reflects the
  // freshly-created account framing.
  const handleSignUpWithPassword = useCallback(
    async (email: string, password: string, name: string) => {
      await signUpWithPassword(email, password, name);
      if (preferences && !preferences.passkeyPromptDismissed) {
        setPasskeyPromptVariant("post-signup");
        setShowPasskeyPrompt(true);
      }
    },
    [signUpWithPassword, preferences],
  );

  const handleSignInWithOAuth = useCallback(
    async (provider: "google" | "apple") => {
      await signInWithOAuth(provider);
      if (preferences && !preferences.passkeyPromptDismissed)
        setShowPasskeyPrompt(true);
    },
    [signInWithOAuth, preferences],
  );

  // Operator just signed in with a passkey — they obviously have one, so tear
  // down any pending prompt state and persist the dismissal so we never nudge
  // them again on this device.
  const handleSignInWithPasskey = useCallback(async () => {
    await signInWithPasskey();
    setShowPasskeyPrompt(false);
    if (preferences && !preferences.passkeyPromptDismissed) {
      await updatePreferences({ ...preferences, passkeyPromptDismissed: true });
    }
  }, [signInWithPasskey, preferences, updatePreferences]);

  // NOTE: there was a `pendingMagicLinkPrompt` effect here that surfaced the
  // passkey nudge after a magic-link deep link landed. It was unreachable — the
  // only thing that set the flag was `handleSendMagicLink`, which was never
  // passed to `SignInScreen` (that screen has no magic-link prop), so the flag
  // was permanently false and the effect never fired. Removed with the handler.
  //
  // The deep-link CONSUMER in `App.tsx` is untouched and still works: a magic
  // link sent from the web app signs the operator in here. It just lands as a
  // normal cold-start session, which is the correct behaviour anyway.

  const { accessibleEvents, refresh: refreshManifests } = useLocalSync(authed);
  // `failedCount` is FR-010's terminal drops — admits the server never recorded.
  const { queueDepth, failedCount, refreshDepth } = useScanQueue(authed);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  // Keep the screen awake only while authenticated — operators run
  // shifts that last hours and don't want the lock screen interrupting
  // a scan, but the sign-in / access-denied surfaces are passive: the
  // operator isn't actively reading them, so default screen-sleep
  // saves battery. We use the imperative activate/deactivate rather
  // than `useKeepAwake()` because the hook can't be conditional, and
  // we want the deactivation to actually run on sign-out.
  useEffect(() => {
    if (!authed) return;
    void activateKeepAwakeAsync();
    return () => {
      void deactivateKeepAwake();
    };
  }, [authed]);

  // Push feedback prefs into the shared module so non-React callers can
  // consult them without prop drilling.
  useEffect(() => {
    if (!preferences) return;
    setFeedbackPrefs({
      soundEnabled: preferences.soundEnabled,
      hapticsEnabled: preferences.hapticsEnabled,
    });
  }, [preferences]);

  // Pick up admits from other scanners as soon as the operator returns to the
  // home screen. The 60s background poll covers idle drift; this kicks an
  // immediate fetch on focus so the admitted bar isn't a minute behind.
  useEffect(() => {
    if (activeScreen === "home" && authed) refreshManifests();
  }, [activeScreen, authed, refreshManifests]);

  // FR-010 — re-read the queue/failed counts on tab change so a retry done in
  // Settings is reflected on Home immediately rather than up to 15s later.
  // Not a new poll (NFR-003): it fires on navigation, not on a timer.
  useEffect(() => {
    if (authed) refreshDepth();
  }, [activeScreen, authed, refreshDepth]);

  // ── Derived values (must be computed before any early return) ────────
  // These hooks must run on every render to satisfy Rules of Hooks. They
  // depend on data that may be empty/null during bootstrap, which is fine —
  // the early returns below decide what to actually render.
  const selectableEvents = useMemo<SelectableEvent[]>(
    () =>
      accessibleEvents.map((e) => ({
        eventId: e.eventId,
        eventName: e.eventName,
        startAt:
          e.startAt instanceof Date ? e.startAt.toISOString() : e.startAt,
        endAt: e.endAt instanceof Date ? e.endAt.toISOString() : e.endAt,
        status: e.status,
      })),
    [accessibleEvents],
  );

  const defaultEventId = resolvedEvent?.eventId ?? preferences?.eventId ?? null;
  const eventId = selectedEventId ?? defaultEventId;
  const eventName = useMemo(() => {
    if (eventId) {
      const match = accessibleEvents.find((e) => e.eventId === eventId);
      if (match) return match.eventName;
    }
    return resolvedEvent?.eventName ?? null;
  }, [eventId, accessibleEvents, resolvedEvent]);

  // Sell tab visibility — hide when no eligible TicketTypes (FR-001).
  // Gated on eventId being in `accessibleEvents` so we don't fire a
  // 404-bound query during the bootstrap window when `preferences.eventId`
  // is a stale ID from before a DB reseed (server-side reconciliation in
  // `useScannerSession` lands a tick later).
  const eventIdIsAccessible =
    !!eventId && accessibleEvents.some((e) => e.eventId === eventId);
  const sellableQuery = trpc.pos.listSellableItems.useQuery(
    { eventId: eventId ?? "" },
    {
      enabled: eventIdIsAccessible && authed,
      staleTime: 30_000,
      retry: false,
    },
  );
  const sellableData = sellableQuery.data as
    | { ticketTypes: Array<unknown> }
    | undefined;
  const hasSellableItems = (sellableData?.ticketTypes?.length ?? 0) > 0;
  const sellTabHidden = !eventId || !hasSellableItems;

  if (isBootstrapping || !preferences) {
    // Continuation of the splash — same white flame on black bg as the
    // native splash and App.tsx font-load splash, so the operator sees
    // one continuous loading state instead of three swaps.
    return (
      <FadeRoot key="bootstrap">
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: FIXED.splashBackground,
          }}
        >
          <Embers size={220} tint={FIXED.splashTint} iconSource={SPLASH_ICON} />
        </View>
      </FadeRoot>
    );
  }

  if (!user) {
    return (
      <FadeRoot key="signin">
        <BypassShell>
          <SignInScreen
            onSignIn={handleSignInWithPassword}
            onSignUp={handleSignUpWithPassword}
            onSignInWithPasskey={handleSignInWithPasskey}
            onSignInWithOAuth={handleSignInWithOAuth}
          />
        </BypassShell>
      </FadeRoot>
    );
  }

  if (accessDenied) {
    return (
      <FadeRoot key="denied">
        <BypassShell>
          <AccessDeniedScreen userEmail={user.email} onSignOut={signOut} />
        </BypassShell>
      </FadeRoot>
    );
  }

  // Post-sign-in nudge: offer passkey enrollment to operators who got in
  // via password / magic-link / OAuth. One-shot — the prompt screen
  // dismisses by flipping `passkeyPromptDismissed` in preferences.
  if (showPasskeyPrompt) {
    return (
      <FadeRoot key="passkey-prompt">
        <BypassShell>
          <PasskeyEnrollPromptScreen
            // Name only — the screen derives the credential label (device
            // suffix included). Deliberately NOT `?? user.email`: an email
            // address is not a device name.
            userName={user.name}
            variant={passkeyPromptVariant}
            onComplete={() => void dismissPasskeyPrompt()}
            onSkip={() => void dismissPasskeyPrompt()}
          />
        </BypassShell>
      </FadeRoot>
    );
  }

  const handleTabPress = (tab: NavTab) => {
    if (tab === "home") {
      setActiveScreen("home");
    } else if (tab === "sell") {
      setActiveScreen("sell");
    } else if (tab === "scan") {
      setActiveScreen("scan");
    } else if (tab === "settings") {
      setActiveScreen("settings");
    }
  };

  const renderScreen = () => {
    switch (activeScreen) {
      case "scan":
        return eventId ? (
          <UnifiedScanScreen
            eventId={eventId}
            eventName={eventName}
            sessionContext={sessionContext}
            // FR-004 — default OFF, per-device, opted into from Settings.
            expressModeEnabled={preferences.expressModeEnabled}
            // Sound & haptics — the rail switch writes BOTH channels through
            // the same persisted preferences Settings edits one at a time.
            feedbackEnabled={scanFeedbackEnabled(preferences)}
            onToggleFeedback={(next) =>
              void updatePreferences(
                applyScanFeedbackToggle(preferences, next),
              )
            }
            onBack={() => setActiveScreen("home")}
            // FR-005: the stats strip is a shortcut to the full counter, which
            // lives on Home. Same destination as back today, but a separate
            // prop so the two intents can diverge without a silent behaviour
            // change.
            onOpenCounts={() => setActiveScreen("home")}
          />
        ) : (
          <NoEventFallback />
        );
      case "sell":
        return eventId ? (
          <SellTabScreen eventId={eventId} sessionContext={sessionContext} />
        ) : (
          <NoEventFallback />
        );
      case "lookup":
        return eventId ? (
          <LookupScreen
            eventId={eventId}
            eventName={eventName}
            sessionContext={sessionContext}
            onBack={() => setActiveScreen("home")}
          />
        ) : (
          <NoEventFallback />
        );
      case "settings":
        return (
          <SettingsScreen
            userEmail={user.email}
            // Name only, same as the enroll prompt above — the screen derives
            // the credential label. Never the email.
            userName={user.name}
            soundEnabled={preferences.soundEnabled}
            hapticsEnabled={preferences.hapticsEnabled}
            expressModeEnabled={preferences.expressModeEnabled}
            onToggleSound={(v) =>
              void updatePreferences({ ...preferences, soundEnabled: v })
            }
            onToggleHaptics={(v) =>
              void updatePreferences({ ...preferences, hapticsEnabled: v })
            }
            onToggleExpressMode={(v) =>
              void updatePreferences({ ...preferences, expressModeEnabled: v })
            }
            onSignOut={signOut}
            onBack={() => setActiveScreen("home")}
          />
        );
      default:
        return (
          <HomeScreen
            eventId={eventId}
            eventName={eventName}
            userEmail={user.email}
            queueDepth={queueDepth}
            failedCount={failedCount}
            selectableEvents={selectableEvents}
            selectedEventId={eventId}
            onSelectEvent={setSelectedEventId}
            onOpenUnifiedScan={() => setActiveScreen("scan")}
            onOpenLookup={() => setActiveScreen("lookup")}
            onOpenSettings={() => setActiveScreen("settings")}
            onSignOut={signOut}
          />
        );
    }
  };

  return (
    <FadeRoot key="app">
      <AppShell
        activeTab={screenToTab(activeScreen)}
        onTabPress={handleTabPress}
        hiddenTabs={sellTabHidden ? ["sell"] : undefined}
        platformAdminOverride={!!sessionContext?.viaPlatformAdmin}
        selectableEvents={selectableEvents}
        selectedEventId={eventId}
        onSelectEvent={setSelectedEventId}
        testID="scanner-app-shell"
      >
        <SlideScreen key={activeScreen}>{renderScreen()}</SlideScreen>
      </AppShell>
    </FadeRoot>
  );
};

const NoEventFallback = () => (
  // Rendered inside `AppShell` via `renderScreen()`, so the global
  // NetworkBanner is already overhead — don't double up here.
  <ScreenSurface>
    <Panel>
      <Text variant="body" weight="bold">
        No event available
      </Text>
      <Text variant="bodySmall" tone="muted">
        You don't have scanner access to any active events. Ask an org admin to
        assign you to an event.
      </Text>
    </Panel>
  </ScreenSurface>
);

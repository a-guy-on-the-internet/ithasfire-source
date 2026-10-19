"use client";

import "react-native-gesture-handler";
import "react-native-reanimated";

import { Suspense, useEffect, type ReactNode } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import Animated, {
  FadeInDown,
  FadeOutUp,
  LinearTransition,
  SlideInLeft,
  SlideInRight,
  SlideOutLeft,
  SlideOutRight,
} from "react-native-reanimated";
import { NotificationProvider } from "@th/ui";

import { TrpcProvider } from "@/trpc";
import { EventCardTierRevealProvider } from "@/components/event-card/EventCardTierRevealProvider";
import { LastVisitedUrlTracker } from "@/components/analytics/LastVisitedUrlTracker";
import { AppThemeProvider } from "@/components/theme/AppThemeProvider";
import type { ThemeMode } from "@/lib/theme-mode";
import { ActiveThemeInjector } from "@/components/theme/ActiveThemeInjector";
import { ThemeAccountSyncer } from "@/components/theme/ThemeAccountSyncer";
import { AppOverlayProvider } from "@/components/layout/AppOverlayProvider";
import { GlobalMutationErrorNotifier } from "@/components/errors/GlobalMutationErrorNotifier";
import { GlobalQueryErrorLogger } from "@/components/errors/GlobalQueryErrorLogger";
import { ConsentProvider } from "@/components/gdpr/ConsentProvider";
import { DocumentTitleProvider } from "@/components/providers/DocumentTitleProvider";
import { AppLocaleProvider } from "@/i18n/locale-provider";
import type { AppLocale } from "@/i18n/config";

const attachReanimatedBridge = () => {
  if (typeof window === "undefined") {
    return;
  }

  const globalObject = globalThis as {
    __TH_REANIMATED__?: Record<string, unknown> | undefined;
  };

  if (globalObject.__TH_REANIMATED__) {
    return;
  }

  globalObject.__TH_REANIMATED__ = {
    default: Animated,
    createAnimatedComponent: Animated.createAnimatedComponent?.bind(Animated),
    FadeInDown,
    FadeOutUp,
    SlideInRight,
    SlideOutRight,
    SlideInLeft,
    SlideOutLeft,
    Layout: LinearTransition,
  };
};

export type AppProvidersProps = {
  children: ReactNode;
  serverLocale?: AppLocale;
  /** Server-resolved appearance mode (from the `th-theme` cookie). */
  initialThemeMode?: ThemeMode;
  /**
   * The route pins `initialThemeMode` regardless of the viewer's preference
   * (embeds — see `lib/route-context.ts`). Resolved server-side.
   */
  themeLocked?: boolean;
};

export const AppProviders = ({
  children,
  serverLocale,
  initialThemeMode,
  themeLocked,
}: AppProvidersProps) => {
  useEffect(() => {
    attachReanimatedBridge();
  }, []);
  const content = (
    <GestureHandlerRootView style={{ flex: 1, minHeight: "100%" }}>
      <AppThemeProvider initialMode={initialThemeMode} locked={themeLocked}>
        <Suspense fallback={null}>
          <LastVisitedUrlTracker />
        </Suspense>
        <AppLocaleProvider serverLocale={serverLocale}>
          <TrpcProvider>
            <ActiveThemeInjector />
            <ThemeAccountSyncer />
            <NotificationProvider>
              <GlobalMutationErrorNotifier />
              <GlobalQueryErrorLogger />
              <ConsentProvider>
                <AppOverlayProvider>
                  <EventCardTierRevealProvider>
                    <DocumentTitleProvider>{children}</DocumentTitleProvider>
                  </EventCardTierRevealProvider>
                </AppOverlayProvider>
              </ConsentProvider>
            </NotificationProvider>
          </TrpcProvider>
        </AppLocaleProvider>
      </AppThemeProvider>
    </GestureHandlerRootView>
  );

  return content;
};

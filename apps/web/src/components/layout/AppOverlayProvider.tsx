"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "@bprogress/next/app";

import { OverlayHost } from "@th/ui";

import {
  UnifiedAuthOverlay,
  type AuthPanel,
} from "@/components/auth/UnifiedAuthOverlay";
import { useIsMobile } from "@/hooks/useIsMobile";
import { getSignInUrl, getSignUpUrl } from "@/lib/auth/urls";
import { appendRedirectParam, sanitizeRedirectPath } from "@/lib/redirect";

export type SignInOverlayOptions = {
  redirect?: string | null;
};

export type SignUpOverlayOptions = {
  redirect?: string | null;
};

type ActiveOverlay = {
  panel: AuthPanel;
  redirect?: string | null;
  /** Pre-filled email for standalone verify-email entries. */
  email?: string;
} | null;

export type ShowOverlayPanelOptions = {
  redirect?: string | null;
  /**
   * Pre-fill the email field when opening directly at the verify-email
   * panel from outside the sign-up flow (e.g. checkout gating).
   */
  email?: string;
};

type AppOverlayContextValue = {
  showSignInOverlay: (options?: SignInOverlayOptions) => void;
  showSignUpOverlay: (options?: SignUpOverlayOptions) => void;
  showOverlayPanel: (
    panel: AuthPanel,
    options?: ShowOverlayPanelOptions | string | null,
  ) => void;
  hideOverlay: () => void;
  /** True while an auth overlay (sign-in/sign-up/verify-email/etc.) is open. */
  isOverlayOpen: boolean;
};

const AppOverlayContext = createContext<AppOverlayContextValue | null>(null);

export const AppOverlayProvider = ({ children }: { children: ReactNode }) => {
  const router = useRouter();
  const isMobile = useIsMobile();
  const [activeOverlay, setActiveOverlay] = useState<ActiveOverlay>(null);

  const normalizeRedirect = useCallback(
    (redirect?: string | null) => sanitizeRedirectPath(redirect ?? null),
    [],
  );

  const routeToAuthPage = useCallback(
    (panel: "sign-in" | "sign-up", redirect?: string | null) => {
      const safeRedirect = normalizeRedirect(redirect);
      const baseUrl = panel === "sign-up" ? getSignUpUrl() : getSignInUrl();
      const destination = appendRedirectParam(baseUrl, safeRedirect);

      setActiveOverlay(null);
      router.push(destination);
    },
    [normalizeRedirect, router],
  );

  const shouldUseStandaloneSignIn = useCallback(() => {
    if (typeof window === "undefined") return isMobile;
    return isMobile || window.matchMedia("(max-width: 599px)").matches;
  }, [isMobile]);

  const showSignInOverlay = useCallback(
    (options?: SignInOverlayOptions) => {
      if (shouldUseStandaloneSignIn()) {
        routeToAuthPage("sign-in", options?.redirect ?? null);
        return;
      }

      setActiveOverlay({
        panel: "sign-in",
        redirect: normalizeRedirect(options?.redirect ?? null),
      });
    },
    [normalizeRedirect, routeToAuthPage, shouldUseStandaloneSignIn],
  );

  const showSignUpOverlay = useCallback(
    (options?: SignUpOverlayOptions) => {
      if (shouldUseStandaloneSignIn()) {
        routeToAuthPage("sign-up", options?.redirect ?? null);
        return;
      }

      setActiveOverlay({
        panel: "sign-up",
        redirect: normalizeRedirect(options?.redirect ?? null),
      });
    },
    [normalizeRedirect, routeToAuthPage, shouldUseStandaloneSignIn],
  );

  const showOverlayPanel = useCallback(
    (
      panel: AuthPanel,
      options?: ShowOverlayPanelOptions | string | null,
    ) => {
      // Backwards-compat: callers historically passed a redirect string.
      const resolved: ShowOverlayPanelOptions =
        typeof options === "string" || options === null || options === undefined
          ? { redirect: (options as string | null | undefined) ?? null }
          : options;

      if (
        (panel === "sign-in" || panel === "sign-up") &&
        shouldUseStandaloneSignIn()
      ) {
        routeToAuthPage(panel, resolved.redirect ?? null);
        return;
      }

      setActiveOverlay({
        panel,
        redirect: normalizeRedirect(resolved.redirect ?? null),
        email: resolved.email,
      });
    },
    [normalizeRedirect, routeToAuthPage, shouldUseStandaloneSignIn],
  );

  const hideOverlay = useCallback(() => {
    setActiveOverlay(null);
  }, []);

  // Detect post-OAuth onboarding query param and auto-open the welcome panel.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("onboarding") === "oauth") {
      setActiveOverlay({ panel: "welcome-profile", redirect: null });
      // Clean the URL so a refresh doesn't re-trigger.
      const url = new URL(window.location.href);
      url.searchParams.delete("onboarding");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  }, []);

  const isOverlayOpen = activeOverlay !== null;

  const contextValue = useMemo<AppOverlayContextValue>(
    () => ({
      showSignInOverlay,
      showSignUpOverlay,
      showOverlayPanel,
      hideOverlay,
      isOverlayOpen,
    }),
    [
      hideOverlay,
      showSignInOverlay,
      showSignUpOverlay,
      showOverlayPanel,
      isOverlayOpen,
    ],
  );

  return (
    <AppOverlayContext.Provider value={contextValue}>
      <OverlayHost>
        {children}
        {activeOverlay ? (
          <UnifiedAuthOverlay
            initialPanel={activeOverlay.panel}
            redirectOverride={activeOverlay.redirect ?? undefined}
            externalEmail={activeOverlay.email}
            onRequestCloseAction={hideOverlay}
          />
        ) : null}
      </OverlayHost>
    </AppOverlayContext.Provider>
  );
};

AppOverlayProvider.displayName = "AppOverlayProvider";

export const useAppOverlay = () => {
  const context = useContext(AppOverlayContext);
  if (!context) {
    throw new Error("useAppOverlay must be used within an AppOverlayProvider");
  }

  return context;
};

// Centralised auth URL helpers.
// These are used by auth gates, redirect helpers, and standalone pages
// when they need to programmatically navigate to sign-in or sign-up.
//
// The overlay system (AppOverlayProvider / UnifiedAuthOverlay) is the
// primary auth UI on most pages, but standalone routes still exist for
// direct URL access and SSR-aware auth gating.

export const getSignInUrl = () => "/sign-in";

export const getSignUpUrl = () => "/sign-up";

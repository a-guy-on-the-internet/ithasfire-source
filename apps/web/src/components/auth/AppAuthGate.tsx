"use client";

import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { useRouter } from "@bprogress/next/app";
import { Spinner } from "@th/ui";

import { authClient } from "@/lib/auth/auth-client";
import { getSignInUrl } from "@/lib/auth/urls";
import { useCurrentUrl } from "@/hooks/useCurrentUrl";

type AppAuthGateProps = {
  children: ReactNode;
};

/** Centered loading / redirect spinner shown while auth state resolves. */
const AuthGateSpinner = ({ label }: { label: string }) => (
  <div
    role="status"
    aria-live="polite"
    aria-busy="true"
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      minHeight: "60vh",
      gap: 16,
    }}
  >
    <Spinner size="lg" indicatorColor="var(--colorMuted, #5C544A)" />
    <p
      style={{
        margin: 0,
        fontSize: 14,
        color: "var(--colorMuted, #5C544A)",
      }}
    >
      {label}
    </p>
  </div>
);

export const AppAuthGate = ({ children }: AppAuthGateProps) => {
  const router = useRouter();
  const redirectUrl = useCurrentUrl({ absolute: false });
  const { data: session, isPending } = authClient.useSession();
  const isSignedIn = Boolean(session?.user);

  const destination = useMemo(() => {
    const signInUrl = getSignInUrl();
    return redirectUrl
      ? `${signInUrl}?redirect=${encodeURIComponent(redirectUrl)}`
      : signInUrl;
  }, [redirectUrl]);

  useEffect(() => {
    if (isPending) {
      return;
    }

    if (isSignedIn) {
      return;
    }

    // IMPORTANT: Never navigate during render; doing so can cause replaceState spam
    // when auth state churns (dev double mount, token refresh, etc.).
    router.push(destination);
  }, [destination, isPending, isSignedIn, router]);

  if (isPending) {
    return <AuthGateSpinner label="Loading..." />;
  }

  if (!isSignedIn) {
    return <AuthGateSpinner label="Redirecting to sign in..." />;
  }

  return <>{children}</>;
};

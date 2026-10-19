import type { Metadata } from "next";
import type { ReactNode } from "react";
import { redirect } from "next/navigation";

import { ModerateShell } from "./_components/ModerateShell";
import { getServerSession } from "@/lib/auth/get-server-session";
import { getSignInUrl } from "@/lib/auth/urls";
import { appendRedirectParam } from "@/lib/redirect";
import { checkModeratorAccessServer } from "@/server/moderator-access";

export const metadata: Metadata = {
  title: "Community Moderation",
  description: "Review community listing edit suggestions.",
  robots: { index: false, follow: false },
};

/**
 * /moderate/** — community-moderator surfaces (community-managed-event-
 * listings spec FR-008/FR-010). Deliberately a LIGHT shell: no AdminShell /
 * PlatformShell chrome, just a gated band layout with constrained content.
 *
 * Server-side gate (defense in depth ahead of `ModerateShell`'s existing
 * client-side check — this route previously had NO server-side check at
 * all, so an anonymous curl got the full shell): anonymous visitors bounce
 * to sign-in; signed-in non-moderators bounce to `/access-denied`; signed-in
 * moderators missing an enrolled second factor (passkey/TOTP — step-up 2FA
 * gate) bounce to `/enroll-2fa` instead of rendering the shell, mirroring
 * `ModerateShell`'s own `isError || !allowed` / missing-2FA branches.
 */
export default async function ModerateLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await getServerSession();
  if (!session) {
    redirect(appendRedirectParam(getSignInUrl(), "/moderate"));
  }

  const access = await checkModeratorAccessServer();
  if (!access.allowed) {
    redirect("/access-denied");
  }
  if (!access.secondFactorEnrolled) {
    redirect(appendRedirectParam("/enroll-2fa", "/moderate"));
  }

  return <ModerateShell>{children}</ModerateShell>;
}

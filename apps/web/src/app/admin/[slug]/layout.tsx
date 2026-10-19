import type { ReactNode } from "react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminShellFrame } from "./_components/AdminShellFrame";
import { ADMIN_SECTIONS } from "./_components/admin-nav-sections";
import { EventNavProvider } from "./_components/event-nav-context";
import { AdminPageSectionsProvider } from "./_components/admin-page-sections";

import type { AccountContext } from "@th/ui";
import { getServerSession } from "@/lib/auth/get-server-session";
import { getSignInUrl } from "@/lib/auth/urls";
import { appendRedirectParam } from "@/lib/redirect";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params?: Promise<{ slug: string }>;
}) {
  const resolvedParams = await (params ?? Promise.resolve({ slug: "" }));
  const rawSlug = resolvedParams.slug;

  // Server-side auth gate: an anonymous request gets bounced to sign-in
  // before any admin HTML ships (previously this layout had NO server-side
  // check at all — an anonymous curl got the full shell, gated only by
  // client-side tRPC queries after hydration). This is a coarse "does ANY
  // session exist" check only, distinct from the per-org role placeholder
  // below — it does not attempt to resolve org membership server-side.
  const session = await getServerSession();
  if (!session) {
    redirect(
      appendRedirectParam(getSignInUrl(), `/admin/${rawSlug}`.replace(/\/+$/, "")),
    );
  }

  // IMPORTANT: Avoid server-side canonicalization redirects in this layout.
  // In some dev/runtime combinations, redirect digests from layouts can cause
  // client-side replaceState churn (particularly when the destination also
  // renders a redirect).
  //
  // We still *treat* `%40alice` and `@alice` as equivalent for authorization
  // checks by decoding only for comparison, without redirecting.
  let slug = rawSlug;
  try {
    slug = decodeURIComponent(rawSlug);
  } catch {
    slug = rawSlug;
  }
  if (slug.startsWith("@")) {
    slug = `@${slug.replace(/^@+/, "")}`;
  }

  // IMPORTANT: Admin SSR does not call the API to resolve ORG ROLE/MEMBERSHIP.
  // (It now calls the API once above, only to confirm a session exists at all.)
  // The client-side AdminShell uses `useEventOwnerEntities()` which already attaches
  // an API bearer token, making role-scoped auth reliable and avoiding RSC
  // request-scope issues.
  const accountContext: AccountContext = {
    id: `admin:${slug}`,
    label: slug,
    type: "org",
    role: "ADMIN",
    // SSR placeholder errs OPEN: the real membership role isn't known until the
    // client AdminShell loads it, so show every role's items rather than
    // pre-hiding. AdminShell narrows `roles` to the actual membership role.
    roles: ["OWNER", "ADMIN", "EDITOR", "FINANCE", "VIEWER", "SCANNER"],
    defaultRoute: "dashboard",
  };

  return (
    // EventNavProvider bridges the rail (in AdminShell) and the event edit
    // surface (deep child): scroll-spy state up, section-jump requests down.
    <EventNavProvider>
      {/* AdminPageSectionsProvider is the workspace twin of EventNavProvider:
          a workspace page (Payouts) registers its in-page sections so rail
          anchors like `payouts#ledger` scroll in place and light up. */}
      <AdminPageSectionsProvider>
        {/* `AdminShellFrame`, not `AdminShell` directly: a printable document
            nested under /admin (the volunteer badge sheet) must render bare, or
            the admin rail prints on the paper. See the component's header. */}
        <AdminShellFrame
          slug={slug}
          sections={ADMIN_SECTIONS}
          accountContext={accountContext}
        >
          {children}
        </AdminShellFrame>
      </AdminPageSectionsProvider>
    </EventNavProvider>
  );
}

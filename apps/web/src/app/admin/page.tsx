import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { AdminRoot } from "./_components/AdminRoot";
import { getServerSession } from "@/lib/auth/get-server-session";
import { getSignInUrl } from "@/lib/auth/urls";
import { appendRedirectParam } from "@/lib/redirect";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function AdminIndexPage() {
  // Server-side auth gate — see admin/[slug]/layout.tsx for the same coarse
  // "does ANY session exist" check. This route previously had none at all.
  const session = await getServerSession();
  if (!session) {
    redirect(appendRedirectParam(getSignInUrl(), "/admin"));
  }

  return <AdminRoot />;
}

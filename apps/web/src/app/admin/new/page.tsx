import type { Metadata } from "next";

import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AdminNewIndexPage() {
  // This route exists mainly to reserve `/admin/new` and funnel users toward a
  // stable experience.
  redirect("/unauthorized");
}

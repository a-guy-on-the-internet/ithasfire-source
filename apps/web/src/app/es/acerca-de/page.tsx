import type { Metadata } from "next";

import { AboutRouteBody, aboutMetadata } from "@/app/about/_lib/about-route";

// Spanish twin of `/about` (spanish-seo FR-001, R21).
export const metadata: Metadata = aboutMetadata("es");

export default function SpanishAboutPage() {
  return <AboutRouteBody />;
}

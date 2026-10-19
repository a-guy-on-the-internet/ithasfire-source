import type { Metadata } from "next";

import { AboutRouteBody, aboutMetadata } from "./_lib/about-route";

// Shared with the Spanish twin `/es/acerca-de` (spanish-seo R21).
export const metadata: Metadata = aboutMetadata("en");

export default function AboutPage() {
  return <AboutRouteBody />;
}

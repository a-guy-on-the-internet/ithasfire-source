import type { Metadata } from "next";

import {
  ContactRouteBody,
  contactMetadata,
} from "@/app/contact/_lib/contact-route";

// Spanish twin of `/contact` (spanish-seo FR-001, R21).
export const metadata: Metadata = contactMetadata("es");

export default function SpanishContactPage() {
  return <ContactRouteBody />;
}

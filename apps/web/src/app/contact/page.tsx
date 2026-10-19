import type { Metadata } from "next";

import { ContactRouteBody, contactMetadata } from "./_lib/contact-route";

// Shared with the Spanish twin `/es/contacto` (spanish-seo R21).
export const metadata: Metadata = contactMetadata("en");

export default function ContactPage() {
  return <ContactRouteBody />;
}

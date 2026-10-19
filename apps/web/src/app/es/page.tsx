import type { Metadata } from "next";

import { HomeRouteBody, homeMetadata } from "@/app/_lib/home-route";

// Spanish twin of `/` (spanish-seo FR-001, R21): the same loader and
// components, with the locale from the URL.

// Same as the English twin; see the note there and the `/es` rule in
// `next.config.ts`.
export const revalidate = 300;

export function generateMetadata(): Metadata {
  return homeMetadata("es");
}

export default async function SpanishHome() {
  return HomeRouteBody({ locale: "es" });
}

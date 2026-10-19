import { notFound, permanentRedirect } from "next/navigation";

import { parseMisworded } from "@/i18n/public-paths";

/**
 * Every other path under /es/ (spanish-seo R16). A page written with English
 * path words (`/es/about`, `/es/events/category/music/nashville-tn`) 308s to
 * its Spanish words; the slug is carried as is, and the Spanish category page
 * then resolves it (`music` → `musica`). Anything else is a 404 in Spanish.
 *
 * Next matches static and single-segment routes before a catch-all, so this
 * never shadows the real /es/ pages.
 */

type Props = {
  params: Promise<{ rest: string[] }>;
};

export default async function SpanishFallbackRoute({ params }: Props) {
  const { rest } = await params;
  const pathname = `/es/${rest.map((s) => encodeURIComponent(s)).join("/")}`;
  const misworded = parseMisworded(pathname);
  if (misworded) permanentRedirect(misworded.path);
  notFound();
}

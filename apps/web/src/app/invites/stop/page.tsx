import type { Metadata } from "next";

import { getHelpTranslator } from "@/app/help/_lib/server-i18n";

import { InviteStopPage } from "./_components/InviteStopPage";

/**
 * `GET /invites/stop?token=<opt-out token>`: the invite email's "Stop invites
 * from <organiser>" link. Public (no session: the signed token is the whole
 * credential), so it sits outside `applyPrivateRouteGate` and on AppChrome's
 * no-auth-gate list. `next.config.ts` sends it `no-store`, `no-referrer` and
 * `X-Robots-Tag: noindex`; the page says noindex too.
 *
 * The token is read in the browser and stripped from the address bar there
 * (InviteStopPage), never rendered into the server HTML.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getHelpTranslator();
  return {
    title: t("invitesStop.pageTitle"),
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

export default function InvitesStopRoute() {
  return <InviteStopPage />;
}

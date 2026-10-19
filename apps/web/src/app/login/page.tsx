import { Suspense } from "react";
import type { Metadata } from "next";

import { getHelpTranslator } from "@/app/help/_lib/server-i18n";
import { LoginPageContent } from "./login-content";

/**
 * Rendered per request ON PURPOSE, so the sign-in card is in the server HTML.
 *
 * `LoginCard` reads `useSearchParams()` (for `?redirect_url=`). On a
 * statically prerendered route that makes Next bail the card out to the
 * client: the server HTML carried the heading and the Suspense fallback
 * (`null`), and the card arrived after hydration. The column is centred in a
 * 100vh stack, so the heading then jumped ~160px up at 320px — 0.395 CLS on a
 * production build. A dynamic route renders `useSearchParams()` on the server
 * like any other hook, so first paint is the finished page.
 *
 * `/sign-in` avoids the jump differently, and that way does not transfer: it
 * renders `null` until it has mounted and the session check has settled, so
 * there is nothing on screen to move. Doing that here would blank the heading
 * too.
 *
 * Keep the heading and the card inside ONE Suspense boundary (this one). A
 * boundary of the card's own still gets streamed as a separate segment and
 * revealed after the heading has painted — the same jump, moved from
 * hydration to streaming.
 *
 * The card's form is `inert` until hydrated (see `LoginCard`), so a press on
 * the server-rendered form cannot submit it natively.
 */
export const dynamic = "force-dynamic";

/**
 * The tab title in the server HTML. `absolute` because `useDocumentTitle` in
 * the content sets the bare title (no site suffix) on mount; matching it means
 * the tab does not change once React takes over.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getHelpTranslator();
  return { title: { absolute: t("auth.loginTitle") } };
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageContent />
    </Suspense>
  );
}

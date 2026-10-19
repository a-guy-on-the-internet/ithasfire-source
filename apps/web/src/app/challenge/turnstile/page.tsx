import type { Metadata } from "next";

import { getHelpTranslator } from "@/app/help/_lib/server-i18n";

import { TurnstileChallenge } from "./_components/TurnstileChallenge";
import { parseChallengeReturn } from "./_lib/return-url";

/**
 * `GET /challenge/turnstile?return=<deep link>` — the native app's Turnstile
 * step for `events.validatePassword`. The app opens it with
 * `expo-web-browser`'s `openAuthSessionAsync`; on success the page navigates to
 * `<return>?turnstileToken=…`, on failure it offers `<return>?turnstileError=
 * unavailable`.
 *
 * `return` is validated HERE, on the server, against the app-scheme allowlist
 * in `parseChallengeReturn`; the client only ever sees an approved value or
 * `null`. Rendered bare (no navbar, no auth gate, no cart recovery — see
 * `AppChrome`'s `/challenge/turnstile` bypass): it opens in an in-app browser
 * sheet, signed out.
 *
 * Per-request and uncacheable: `force-dynamic` keeps Next's own
 * `private, no-cache, no-store` Cache-Control, and no `next.config.ts` header
 * rule matches `/challenge`. The referrer policy is deliberately the site
 * default, like every other Turnstile page: the widget's iframe may check the
 * embedding hostname, and this URL never carries the token.
 */
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getHelpTranslator();
  return {
    title: t("challenge.title"),
    robots: { index: false, follow: false },
  };
}

type Props = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function TurnstileChallengePage({ searchParams }: Props) {
  const params = await searchParams;
  return <TurnstileChallenge returnUrl={parseChallengeReturn(params.return)} />;
}

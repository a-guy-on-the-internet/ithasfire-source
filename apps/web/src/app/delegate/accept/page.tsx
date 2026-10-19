import type { Metadata } from "next";
import { AcceptDelegateInvite } from "./_components/AcceptDelegateInvite";

export const metadata: Metadata = {
  title: "Accept Delegate Invitation",
  // Token-bearing URL: never index it.
  robots: { index: false, follow: false },
};

type Props = {
  searchParams: Promise<{ token?: string }>;
};

/**
 * Delegate invitation landing page. The principal copies this link from
 * Team → Add delegate and sends it to the person they want as a delegate;
 * the delegation is created only when that person opens it while signed in
 * with the invited email (security review F3, 2026-09-29).
 *
 * Token-authorised, so deliberately NOT in `PRIVATE_ROUTE_PREFIXES`
 * (a signed-out visitor must reach the sign-in prompt below).
 */
export default async function AcceptDelegateInvitePage({ searchParams }: Props) {
  const params = await searchParams;
  return <AcceptDelegateInvite token={params.token ?? null} />;
}

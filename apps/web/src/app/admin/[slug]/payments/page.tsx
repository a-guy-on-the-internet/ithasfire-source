import { redirect } from "next/navigation";

import { payoutsHref } from "../payouts/_lib/payouts-href";

/**
 * `/admin/:slug/payments` is a pure redirector. Payments (the Stripe Connect
 * card and the payout schedule) merged into the Payouts page, whose Stripe
 * account and Payout schedule sections now hold them.
 *
 * The query string MUST survive: a Stripe onboarding started before the merge
 * shipped carries `returnUrl/refreshUrl` = `/admin/<slug>/payments?…`, and the
 * account holder lands back here from Stripe. A fragment never reaches a server
 * redirect; the browser keeps the original one when the Location carries none
 * (RFC 9110 §10.2.2), so `/payments#stripe` still lands on `#stripe`.
 */
type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminPaymentsRedirect({
  params,
  searchParams,
}: PageProps) {
  const { slug } = await params;
  redirect(payoutsHref({ slug, searchParams: await searchParams }));
}

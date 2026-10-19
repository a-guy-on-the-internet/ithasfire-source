import { redirect } from "next/navigation";

interface Props {
  searchParams: Promise<{ token?: string }>;
}

/**
 * Compat redirect. Invite emails sent before 2026-08-04 linked to
 * /invitations/accept — a route that never existed (the real page is
 * /invite/accept), so those emails 404'd. The URL builder is fixed
 * (packages/core/src/use-cases/orgs/invite-member.ts), and this page keeps
 * every already-delivered email working. Do not remove while any
 * pre-2026-08-04 invitation could still be unexpired.
 */
export default async function LegacyAcceptInvitationRedirect({
  searchParams,
}: Props) {
  const params = await searchParams;
  const token = params.token;
  redirect(token ? `/invite/accept?token=${encodeURIComponent(token)}` : "/invite/accept");
}

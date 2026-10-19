// Pure: who a Stripe Connect read/write is for, and how that becomes router
// input. Split out of `use-stripe-account.ts` so it can be tested without the
// hook's tRPC/UI imports.

export type StripeAccountOwner =
  | { kind: "org"; orgId: string }
  | { kind: "human"; humanId: string };

/**
 * "The signed-in human", without an id. The router fills `humanId` from the
 * session (`withActorHumanOwnerDefault`), so the account-settings Payouts
 * block asks for "my account" without first fetching its own id; core refuses
 * any `humanId` other than the actor's either way. Kept out of
 * `StripeAccountOwner` because the Payouts page also feeds its owner to
 * schedule reads that need a concrete id.
 */
export type StripeAccountSelf = { kind: "human"; humanId?: undefined };

/** The owner as router input: org id, explicit human id, or `{}` = me. */
export function ownerInputOf(
  owner: StripeAccountOwner | StripeAccountSelf,
): { orgId: string } | { humanId: string } | Record<string, never> {
  if (owner.kind === "org") return { orgId: owner.orgId };
  return owner.humanId ? { humanId: owner.humanId } : {};
}

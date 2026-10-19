import type { Repos } from "@th/ports/repos";
import type { TaxRateFillQueuePort } from "@th/ports/tax-rate-fill-queue";

/**
 * Attach the background tax-rate fill queue to the repos bag as
 * `repos.taxRateFills` — see `TaxRateFillQueuePort` for why it rides the
 * repos (the listing loaders reach it through the repos every caller hands
 * them, instead of a dependency threaded through every listing use case).
 *
 * Apply it OUTERMOST, after any decorator that rebuilds the bag, or the
 * property is lost. `null` = no queue (no Cloud Tasks configured): the repos
 * come back unchanged and listings simply queue nothing.
 *
 * Only the root bag carries it; a transaction's repos do not, so nothing
 * inside a transaction can make the (network) enqueue call.
 */
export function withTaxRateFillQueue(
  repos: Repos,
  queue: TaxRateFillQueuePort | null,
): Repos {
  if (!queue) return repos;
  const decorated: Repos & { taxRateFills: TaxRateFillQueuePort } = {
    ...repos,
    taxRateFills: queue,
  };
  return decorated;
}

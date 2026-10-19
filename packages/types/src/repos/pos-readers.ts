/**
 * POS reader registry types.
 *
 * A `PosReader` is the org-ownership record for a Stripe Terminal reader that
 * is physically registered on the PLATFORM Stripe account. See
 * `packages/db/prisma/pos.prisma` for why ownership can't live in Stripe.
 */

export interface PosReaderRecord {
  id: string;
  orgId: string;
  /** Stripe Terminal reader id (`tmr_xxx`) on the platform account. */
  stripeReaderId: string;
  label: string;
  placeId: string | null;
  deviceType: string | null;
  pairedByHumanId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePosReaderInput {
  orgId: string;
  stripeReaderId: string;
  label: string;
  placeId?: string | null;
  deviceType?: string | null;
  pairedByHumanId: string;
}

export interface ListPosReadersByOrgInput {
  orgId: string;
}

export interface GetPosReaderByIdInput {
  id: string;
}

export interface GetPosReaderByStripeIdInput {
  stripeReaderId: string;
}

export interface UpdatePosReaderInput {
  id: string;
  label?: string;
  placeId?: string | null;
}

export interface DeletePosReaderInput {
  id: string;
}

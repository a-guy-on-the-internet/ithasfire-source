import type {
  CreatePosReaderInput,
  DeletePosReaderInput,
  GetPosReaderByIdInput,
  GetPosReaderByStripeIdInput,
  ListPosReadersByOrgInput,
  PosReaderRecord,
  UpdatePosReaderInput,
} from "@th/types/repos/pos-readers";

export interface PosReadersRepo {
  /**
   * Readers currently paired to an org, newest first. Callers render this
   * directly — it is the org's reader inventory.
   */
  listByOrg(input: ListPosReadersByOrgInput): Promise<PosReaderRecord[]>;

  /**
   * Fetch by our id. Returns the row regardless of org — callers MUST compare
   * `orgId` themselves before driving the reader (see pos.prisma).
   */
  getById(input: GetPosReaderByIdInput): Promise<PosReaderRecord | null>;

  /**
   * Fetch by Stripe reader id. Used at pair time to detect hardware that is
   * already claimed by another org.
   */
  getByStripeReaderId(
    input: GetPosReaderByStripeIdInput,
  ): Promise<PosReaderRecord | null>;

  create(input: CreatePosReaderInput): Promise<PosReaderRecord>;

  update(input: UpdatePosReaderInput): Promise<PosReaderRecord>;

  /** Hard delete. Stripe-side deregistration is the caller's job. */
  delete(input: DeletePosReaderInput): Promise<void>;
}

export type {
  CreatePosReaderInput,
  DeletePosReaderInput,
  GetPosReaderByIdInput,
  GetPosReaderByStripeIdInput,
  ListPosReadersByOrgInput,
  PosReaderRecord,
  UpdatePosReaderInput,
};

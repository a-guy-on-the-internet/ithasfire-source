import type {
  CreatePlaceClaimEmailChallengeInput,
  PlaceClaimEmailChallengeRecord,
} from "@th/types/repos/place-claim-email-challenges";

export interface PlaceClaimEmailChallengesRepo {
  create(
    input: CreatePlaceClaimEmailChallengeInput,
  ): Promise<PlaceClaimEmailChallengeRecord>;
  getById(id: string): Promise<PlaceClaimEmailChallengeRecord | null>;
  /**
   * Returns the most recent un-expired, unverified challenge for this
   * (place, human) pair, if any. Used to rate-limit issuance.
   */
  getActiveForPlaceHuman(input: {
    placeId: string;
    humanId: string;
    now: Date;
  }): Promise<PlaceClaimEmailChallengeRecord | null>;
  /** Marks the challenge satisfied so submit-place-claim can consume it. */
  markVerified(input: {
    id: string;
    verifiedAt: Date;
  }): Promise<PlaceClaimEmailChallengeRecord>;
  /** Bumps the failed-attempt counter (returns the new count). */
  incrementAttempts(id: string): Promise<number>;
  /** Force-expires a challenge (sets expiresAt to `now`). */
  expire(input: { id: string; now: Date }): Promise<void>;
}

export type {
  CreatePlaceClaimEmailChallengeInput,
  PlaceClaimEmailChallengeRecord,
} from "@th/types/repos/place-claim-email-challenges";

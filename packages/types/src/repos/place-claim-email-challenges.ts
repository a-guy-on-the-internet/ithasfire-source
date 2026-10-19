export interface PlaceClaimEmailChallengeRecord {
  id: string;
  placeId: string;
  humanId: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  verifiedAt: Date | null;
  attempts: number;
  createdAt: Date;
}

export interface CreatePlaceClaimEmailChallengeInput {
  placeId: string;
  humanId: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
}

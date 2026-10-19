export type ConsentChoice = "ALL" | "ESSENTIAL" | "RESET";
export type ConsentSource = "BANNER" | "FOOTER_MANAGE";

export interface ConsentRecordInput {
  anonymousId: string;
  humanId: string | null;
  choice: ConsentChoice;
  source: ConsentSource;
  privacyPolicyVersion: string;
  cookiePolicyVersion: string;
  ipHash: string | null;
  userAgent: string | null;
}

export interface ConsentRecordRow extends ConsentRecordInput {
  id: string;
  createdAt: Date;
}

export interface ConsentRepo {
  add(input: ConsentRecordInput): Promise<{ id: string }>;
  listByHumanId(humanId: string): Promise<ConsentRecordRow[]>;
  listByAnonymousId(anonymousId: string): Promise<ConsentRecordRow[]>;
}

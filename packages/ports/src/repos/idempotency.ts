export interface IdempotencyRepo {
  seen(key: string): Promise<boolean>;
  remember(key: string): Promise<void>;
}

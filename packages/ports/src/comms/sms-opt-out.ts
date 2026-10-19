// SmsProviderOptOutPort — thin wrapper over the SMS provider's opt-out state
// (AWS SNS CheckIfPhoneNumberIsOptedOut / ListPhoneNumbersOptedOut) so core
// reconciliation logic never imports the AWS SDK directly.
// See docs/specs/2026-05-18/completed/sms-opt-out-sns.spec.yaml.

export interface SmsProviderOptOutPort {
  /**
   * Whether the provider has suppressed future sends to this number (e.g. the
   * recipient replied STOP to the origination identity). Numbers are E.164.
   */
  isOptedOut(phoneE164: string): Promise<boolean>;
  /**
   * Full list of provider-suppressed numbers, paginated transparently. Used by
   * a reconciliation job to fold provider state into the app ledger.
   */
  listOptedOut(): Promise<string[]>;
}

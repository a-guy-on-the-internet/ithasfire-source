/**
 * Can this API send a text message?
 *
 * One predicate, two readers: `createAuthDeps()` builds the SNS adapter from
 * this config, and `features.getFeatureGates` reports `sms` from the same
 * answer so the web hides every SMS option exactly when the adapter would be
 * missing. Derived from the environment, never stored: it is not a platform
 * setting and has no /platform toggle. It needs the AWS keys AND at least one
 * origination number (`snsSmsConfig`, shared with jobs), so the options never
 * appear while every send would fail.
 */
import {
  snsSmsConfig,
  type SnsSmsConfig,
  type SnsSmsEnv,
} from "@th/adapters/comms/sns-sms-config";

export type SmsCredentialsEnv = SnsSmsEnv;

export type SmsCredentials = SnsSmsConfig["credentials"];

/**
 * The SNS credentials, or null when the API cannot send texts (prod:
 * `enable_aws = false`, or keys without an origination number).
 */
export function smsCredentials(e: SmsCredentialsEnv): SmsCredentials | null {
  return snsSmsConfig(e)?.credentials ?? null;
}

export function isSmsConfigured(e: SmsCredentialsEnv): boolean {
  return snsSmsConfig(e) !== null;
}

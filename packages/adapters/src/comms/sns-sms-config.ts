/**
 * When can this process send a text message through SNS?
 *
 * One predicate for both composition roots (API `lib/sms-capability.ts`,
 * jobs `lib/container.ts`): AWS keys AND at least one registered origination
 * number. Keys alone are not enough: without an origination number a US send
 * has no registered sender and fails, so the SMS options would show while
 * every send failed. A registered US number (10DLC or toll-free); one number
 * in both variables is the expected setup.
 */
export type SnsSmsEnv = {
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  AWS_SMS_ORIGINATION_OTP?: string;
  AWS_SMS_ORIGINATION_NOTIFICATIONS?: string;
};

export type SnsSmsConfig = {
  credentials: { accessKeyId: string; secretAccessKey: string };
  originationNumbers: { otp?: string; notification?: string };
};

/** The SNS SMS config, or null when this process cannot send texts. */
export function snsSmsConfig(e: SnsSmsEnv): SnsSmsConfig | null {
  if (!e.AWS_ACCESS_KEY_ID || !e.AWS_SECRET_ACCESS_KEY) return null;
  const otp = e.AWS_SMS_ORIGINATION_OTP || undefined;
  const notification = e.AWS_SMS_ORIGINATION_NOTIFICATIONS || undefined;
  if (!otp && !notification) return null;
  return {
    credentials: {
      accessKeyId: e.AWS_ACCESS_KEY_ID,
      secretAccessKey: e.AWS_SECRET_ACCESS_KEY,
    },
    originationNumbers: { otp, notification },
  };
}

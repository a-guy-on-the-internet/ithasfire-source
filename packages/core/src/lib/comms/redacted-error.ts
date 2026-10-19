import { redactPhoneNumbers } from "@th/ports/comms/sms";

/**
 * The error with phone-number-looking digits redacted from its message and
 * stack: provider error text (AWS SNS among them) can echo the destination,
 * and this copy is what reaches logs and the error tracker. Name survives for
 * grouping.
 *
 * `alsoRedact` removes exact values the phone pattern would miss, such as a
 * 6-digit passcode, which is too short to look like a phone number.
 */
export function redactedError(
  error: unknown,
  alsoRedact: readonly string[] = [],
): Error {
  const source =
    error instanceof Error ? error : new Error(String(error ?? "unknown"));
  const scrub = (text: string) =>
    alsoRedact.reduce(
      (out, secret) => (secret ? out.split(secret).join("[redacted]") : out),
      redactPhoneNumbers(text),
    );
  const copy = new Error(scrub(source.message));
  // Only when it differs: a plain Error keeps `name` on the prototype, so
  // the copy stays deep-equal to an unredacted plain Error.
  if (source.name !== copy.name) copy.name = source.name;
  copy.stack = source.stack ? scrub(source.stack) : undefined;
  return copy;
}

import { describe, it, expect, vi } from "vitest";
import { execOrThrow, redisKeyHash } from "../exec-or-throw";

// A key shaped like the transfer-claim idempotency key, which carries a
// bearer token. Neither the token nor any written value may reach the error.
const TOKEN = "tok_9f3c2a7d1e8b4c6a";
const KEY = `claim-transfer:${TOKEN}:client-1`;
const VALUE = '{"secret":"s3cr3t"}';

/** An ioredis-shaped reply error: ioredis attaches the command arguments. */
function replyError(message: string) {
  return Object.assign(new Error(message), {
    command: { name: "set", args: [KEY, VALUE] },
  });
}

function multiWith(exec: () => Promise<unknown>) {
  return { exec: vi.fn(exec) } as any;
}

async function caught(p: Promise<unknown>): Promise<Error> {
  const err = await p.then(
    () => null,
    (e: unknown) => e as Error,
  );
  expect(err).toBeInstanceOf(Error);
  return err!;
}

/** Everything a logger or Sentry could serialise off the thrown error. */
function everything(err: Error): string {
  return [err.message, err.stack ?? "", JSON.stringify(err), String(err.cause ?? "")].join("\n");
}

describe("execOrThrow", () => {
  it("resolves when every queued command succeeded", async () => {
    const multi = multiWith(async () => [
      [null, "OK"],
      [null, "OK"],
    ]);
    await expect(execOrThrow(multi, "demo write", KEY)).resolves.toBeUndefined();
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  it("throws when exec resolves null (transaction aborted)", async () => {
    const err = await caught(execOrThrow(multiWith(async () => null), "demo write", KEY));
    expect(err.message).toBe(`redis demo write aborted (keyHash=${redisKeyHash(KEY)})`);
  });

  it("throws when a tuple carries an error, keeping only the Redis error code", async () => {
    const multi = multiWith(async () => [
      [null, "OK"],
      [replyError("OOM command not allowed when used memory > 'maxmemory'."), null],
    ]);
    const err = await caught(execOrThrow(multi, "demo write", KEY));
    expect(err.message).toBe(
      `redis demo write failed at command 1 [OOM] (keyHash=${redisKeyHash(KEY)})`,
    );
    expect(err.cause).toBeUndefined();
  });

  it("sanitises a rejected exec (EXECABORT with previousErrors)", async () => {
    const abort = Object.assign(
      new Error("EXECABORT Transaction discarded because of previous errors."),
      { previousErrors: [replyError("ERR something about " + VALUE)] },
    );
    const err = await caught(
      execOrThrow(
        multiWith(async () => {
          throw abort;
        }),
        "demo write",
        KEY,
      ),
    );
    expect(err.message).toBe(
      `redis demo write rejected [EXECABORT] (keyHash=${redisKeyHash(KEY)})`,
    );
    expect(err).not.toHaveProperty("previousErrors");
  });

  it("never puts the key's token segment or any value in the error", async () => {
    const cases: Array<() => Promise<unknown>> = [
      async () => null,
      async () => [[replyError(`ERR unknown command, with args beginning with: '${KEY}' '${VALUE}'`), null]],
      async () => {
        throw Object.assign(replyError("Command aborted due to connection close"), { name: "AbortError" });
      },
    ];
    for (const exec of cases) {
      const text = everything(await caught(execOrThrow(multiWith(exec), "demo write", KEY)));
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(KEY);
      expect(text).not.toContain("s3cr3t");
    }
  });

  it("maps client-side ioredis errors to fixed codes without echoing the message", async () => {
    const cases: Array<[string, string]> = [
      ["Command timed out", "TIMEOUT"],
      ["Connection is closed.", "CONNECTION_CLOSED"],
    ];
    for (const [message, code] of cases) {
      const err = await caught(
        execOrThrow(
          multiWith(async () => {
            throw new Error(message + " " + VALUE);
          }),
          "demo write",
          KEY,
        ),
      );
      expect(err.message).toBe(
        `redis demo write rejected [${code}] (keyHash=${redisKeyHash(KEY)})`,
      );
      expect(everything(err)).not.toContain("s3cr3t");
    }
  });

  it("hashes the key to a stable 12-hex fingerprint", () => {
    expect(redisKeyHash(KEY)).toMatch(/^[0-9a-f]{12}$/);
    expect(redisKeyHash(KEY)).toBe(redisKeyHash(KEY));
    expect(redisKeyHash(KEY)).not.toBe(redisKeyHash(`${KEY}x`));
  });
});

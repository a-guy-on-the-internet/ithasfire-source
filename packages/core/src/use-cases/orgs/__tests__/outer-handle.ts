import { expect, vi } from "vitest";

type Mock = ReturnType<typeof vi.fn>;
type RepoMocks = Record<string, Record<string, unknown>>;

const refusingMocks = new WeakMap<object, Array<[name: string, mock: Mock]>>();

/**
 * The repos handle a use case holds OUTSIDE its transaction, built with mocks
 * of its own so a test can tell the two handles apart.
 *
 * Every method `txSide` has gets a fresh mock here that throws when called:
 * a lock, a role read or a write that belongs on the transaction's handle and
 * lands on this one fails the test that made it. `answered` lists the reads a
 * use case does make before or after its transaction; those mocks are used as
 * given.
 *
 * Add `tx` to the result yourself, passing `txSide` to the callback.
 */
export function makeOuterHandle(
  txSide: RepoMocks,
  answered: RepoMocks = {},
): Record<string, Record<string, Mock>> {
  const refusing: Array<[string, Mock]> = [];
  const handle: Record<string, Record<string, Mock>> = {};

  for (const repo of new Set([
    ...Object.keys(txSide),
    ...Object.keys(answered),
  ])) {
    const methods: Record<string, Mock> = {};
    for (const method of Object.keys(txSide[repo] ?? {})) {
      const name = `${repo}.${method}`;
      const mock: Mock = vi.fn();
      mock.mockImplementation(() => {
        throw new Error(`${name} was called outside the transaction`);
      });
      methods[method] = mock;
      refusing.push([name, mock]);
    }
    handle[repo] = methods;
  }

  for (const [repo, methods] of Object.entries(answered)) {
    for (const [method, mock] of Object.entries(methods)) {
      handle[repo]![method] = mock as Mock;
    }
  }

  refusingMocks.set(
    handle,
    refusing.filter(([name]) => {
      const [repo, method] = name.split(".") as [string, string];
      return answered[repo]?.[method] === undefined;
    }),
  );
  return handle;
}

/** Nothing but the `answered` reads ran on a handle from {@link makeOuterHandle}. */
export function expectOuterHandleUnused(handle: object): void {
  const refusing = refusingMocks.get(handle);
  if (!refusing) {
    throw new Error("Not a handle from makeOuterHandle");
  }
  for (const [name, mock] of refusing) {
    expect(mock, `${name} outside the transaction`).not.toHaveBeenCalled();
  }
}

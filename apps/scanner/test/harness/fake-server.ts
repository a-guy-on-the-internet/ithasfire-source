import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The server, as the screen sees it: every call returns a DEFERRED promise
 * that the test settles by hand, in whatever order the race needs.
 *
 * Replaces `src/trpc.ts` (see `setup.ts`). Only the procedures the scan
 * screen's tree calls exist; a new one fails loudly as `undefined`.
 */

export type ServerCall<I, O> = {
  readonly input: I;
  readonly settled: boolean;
  resolve: (value: O) => void;
  reject: (error: unknown) => void;
};

export class Endpoint<I, O> {
  readonly calls: Array<ServerCall<I, O>> = [];

  constructor(readonly name: string) {}

  /** What the screen calls. */
  handle(input: I): Promise<O> {
    return new Promise<O>((resolve, reject) => {
      const call = {
        input,
        settled: false,
        resolve: (value: O) => {
          if (call.settled) throw new Error(`${this.name}: call already settled`);
          call.settled = true;
          resolve(value);
        },
        reject: (error: unknown) => {
          if (call.settled) throw new Error(`${this.name}: call already settled`);
          call.settled = true;
          reject(error);
        },
      };
      this.calls.push(call);
    });
  }

  pending(): Array<ServerCall<I, O>> {
    return this.calls.filter((c) => !c.settled);
  }

  /** The OLDEST unsettled call matching `match` (any call when omitted). */
  take(match?: (input: I) => boolean): ServerCall<I, O> {
    const call = this.pending().find((c) => !match || match(c.input));
    if (!call) {
      throw new Error(
        `${this.name}: no pending call${match ? " matching" : ""} — ${this.calls.length} call(s) so far, all settled`,
      );
    }
    return call;
  }

  reset(): void {
    this.calls.length = 0;
  }
}

export type LookupInput = { eventId: string; raw: string };
export type AdmitInput = { eventId: string; ticketCode: string; clientKey: string };
export type AdmitResponse = {
  outcome: string;
  reason?: string | null;
  scannedAt?: Date | string | null;
  previousScannedAt?: Date | string | null;
};

export const server = {
  lookup: new Endpoint<LookupInput, unknown>("scan.resolvePayload"),
  admit: new Endpoint<AdmitInput, AdmitResponse>("tickets.scanTicket"),
  revert: new Endpoint<{ ticketId: string }, unknown>("tickets.revertTicketScan"),
  checkIn: new Endpoint<{ signupId: string }, unknown>("volunteer.signups.checkIn"),
  mintScanToken: new Endpoint<{ signupId: string; kind: string }, { token: string }>(
    "volunteer.signups.mintScanToken",
  ),
  reset(): void {
    this.lookup.reset();
    this.admit.reset();
    this.revert.reset();
    this.checkIn.reset();
    this.mintScanToken.reset();
  },
};

/**
 * A `useMutation` with react-query's observable semantics where the screen
 * depends on them: `isPending` is true while the LATEST `mutateAsync` is in
 * flight (the rail disables on it), and `mutateAsync` rejects with the error.
 */
const mutationHook =
  <I, O>(endpoint: Endpoint<I, O>) =>
  () => {
    const [isPending, setPending] = useState(false);
    const latest = useRef(0);
    const mounted = useRef(true);
    useEffect(
      () => () => {
        mounted.current = false;
      },
      [],
    );
    const mutateAsync = useCallback((input: I): Promise<O> => {
      const id = (latest.current += 1);
      setPending(true);
      const done = () => {
        if (mounted.current && latest.current === id) setPending(false);
      };
      return endpoint.handle(input).then(
        (value) => {
          done();
          return value;
        },
        (error: unknown) => {
          done();
          throw error;
        },
      );
    }, []);
    return { mutateAsync, isPending };
  };

/** Stable across renders, like the real `useUtils()` proxy. */
const utils = {
  scan: {
    resolvePayload: {
      fetch: (input: LookupInput) => server.lookup.handle(input),
    },
  },
};

export const trpc = {
  useUtils: () => utils,
  tickets: {
    scanTicket: { useMutation: mutationHook(server.admit) },
    revertTicketScan: { useMutation: mutationHook(server.revert) },
  },
  volunteer: {
    signups: {
      checkIn: { useMutation: mutationHook(server.checkIn) },
      mintScanToken: { useMutation: mutationHook(server.mintScanToken) },
    },
  },
};

/** A tRPC client error as the screen classifies it: `err.data.code`. */
export const trpcError = (code: string, message = `${code} from server`) =>
  Object.assign(new Error(message), { data: { code } });

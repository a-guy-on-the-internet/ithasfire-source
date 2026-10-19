/**
 * The two things the audio upload hook has to do BESIDES uploading, both of
 * which were missing and both of which were invisible to every existing test:
 *
 *   1. Wake the `events.resolveAudio` poller after finalize. `useEventMediaMaps`
 *      parks that query's `refetchInterval` at `false` whenever nothing is
 *      pending, and React Query only recomputes the interval on a query STATE
 *      change — so an editor that mounted with no audio never polls again
 *      unless something invalidates. Measured symptom: zero `resolveAudio`
 *      requests in the 379s after an upload; the block sat on its skeleton
 *      until a full page reload.
 *   2. Stamp `uploadStartedAt` on the returned attrs. The node view's 5-minute
 *      "Still working" branch keys off that attribute, and without it at
 *      insert time the branch is unreachable in exactly the scenario it exists
 *      for (nothing ever comes back).
 *
 * MOCKS: `@/trpc` is stubbed with only the three members the hook touches —
 * `useUtils`, `requestAudioUpload.useMutation`, `finalizeAudioUpload.useMutation`.
 * Everything inside the hook (ordering, the failure bail-out) is the shipped
 * code. Browser globals (`crypto.subtle`, `fetch`) are stubbed because jsdom
 * ships neither in a usable form.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AudioBlockAttributes } from "../prose-editor";

const requestMutateAsync = vi.fn();
const finalizeMutateAsync = vi.fn();
const resolveAudioInvalidate = vi.fn();

/** Ordered log of the side effects we care about sequencing. */
let calls: string[] = [];

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      events: { resolveAudio: { invalidate: resolveAudioInvalidate } },
    }),
    events: {
      requestAudioUpload: {
        useMutation: () => ({ mutateAsync: requestMutateAsync }),
      },
      finalizeAudioUpload: {
        useMutation: () => ({ mutateAsync: finalizeMutateAsync }),
      },
    },
  },
}));

const { useEventAudioUpload } = await import("../useEventAudioUpload");

const EVENT_ID = "evt_wake_up";
const NOW = new Date("2026-09-03T12:00:00.000Z");

/**
 * A hand-rolled File. jsdom's own `File`/`Blob.arrayBuffer` support varies by
 * version and the hook only reads `name`/`type`/`size`/`arrayBuffer`.
 */
const makeFile = (name = "Basement Take.mp3"): File =>
  ({
    name,
    type: "audio/mpeg",
    size: 4_096,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
  }) as unknown as File;

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  calls = [];

  requestMutateAsync.mockImplementation(() => {
    calls.push("request");
    return Promise.resolve({
      audioUploadId: "aud_1",
      uploadUrl: "https://r2.example/put",
    });
  });
  finalizeMutateAsync.mockImplementation(() => {
    calls.push("finalize");
    return Promise.resolve({ status: "UPLOADED" });
  });
  resolveAudioInvalidate.mockImplementation(() => {
    calls.push("invalidate");
    return Promise.resolve();
  });
  fetchMock.mockImplementation(() => {
    calls.push("put");
    return Promise.resolve({ ok: true, status: 200, statusText: "OK" });
  });

  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("crypto", {
    subtle: {
      digest: () => Promise.resolve(new Uint8Array([1, 2, 3, 4]).buffer),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function mountHook(onError?: (err: Error) => void) {
  return renderHook(() => useEventAudioUpload({ eventId: EVENT_ID, onError }));
}

/**
 * Runs the upload inside `act` and hands back the resolved attrs.
 *
 * The promise is captured rather than a `let attrs = null` being assigned
 * inside the callback: TypeScript's control-flow analysis can't see writes
 * made from a closure, so the latter narrows to `never` at the assertion.
 */
async function upload(
  uploadAudio: (file: File) => Promise<AudioBlockAttributes | null>,
  file: File,
): Promise<AudioBlockAttributes | null> {
  let pending!: Promise<AudioBlockAttributes | null>;
  await act(async () => {
    pending = uploadAudio(file);
    await pending;
  });
  return pending;
}

describe("useEventAudioUpload", () => {
  it("invalidates events.resolveAudio for this event after a successful finalize", async () => {
    const { result } = mountHook();

    await upload(result.current.uploadAudio, makeFile());

    // THE fix for the parked poller. Without this the query never changes
    // state, so its `refetchInterval` callback is never re-evaluated and the
    // block spins forever.
    expect(resolveAudioInvalidate).toHaveBeenCalledTimes(1);
    expect(resolveAudioInvalidate).toHaveBeenCalledWith({ eventId: EVENT_ID });
  });

  it("invalidates only AFTER finalize has committed the upload", async () => {
    const { result } = mountHook();

    await upload(result.current.uploadAudio, makeFile());

    // Invalidating earlier would refetch before the row is UPLOADED, land a
    // response with nothing pending, and re-park the timer immediately.
    expect(calls).toEqual(["request", "put", "finalize", "invalidate"]);
  });

  it("does not invalidate when the storage upload fails", async () => {
    fetchMock.mockImplementation(() => {
      calls.push("put");
      return Promise.resolve({
        ok: false,
        status: 403,
        statusText: "Forbidden",
      });
    });
    const onError = vi.fn();
    const { result } = mountHook(onError);

    const attrs = await upload(result.current.uploadAudio, makeFile());

    expect(attrs).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(finalizeMutateAsync).not.toHaveBeenCalled();
    expect(resolveAudioInvalidate).not.toHaveBeenCalled();
  });

  it("does not invalidate when there is no event id", async () => {
    const onError = vi.fn();
    const { result } = renderHook(() =>
      useEventAudioUpload({ eventId: "", onError }),
    );

    await upload(result.current.uploadAudio, makeFile());

    expect(resolveAudioInvalidate).not.toHaveBeenCalled();
  });

  it("returns uploadStartedAt so the inserted node can time itself out", async () => {
    const { result } = mountHook();

    const attrs = await upload(result.current.uploadAudio, makeFile());

    // The node view's `isTimedOut` effect bails out on a null
    // `uploadStartedAt`, so the "Still working · Nm" branch is dead code
    // without this value being present at insert time.
    expect(attrs).toMatchObject({
      audioUploadId: "aud_1",
      title: "Basement Take",
      status: "UPLOADED",
      uploadStartedAt: NOW.toISOString(),
    });
  });

  it("stamps uploadStartedAt from the START of the upload, not the finish", async () => {
    // A slow presign must not shorten the perceived processing time — the
    // 5-minute timeout should measure from when the organiser hit upload.
    requestMutateAsync.mockImplementation(() => {
      calls.push("request");
      vi.setSystemTime(new Date(NOW.getTime() + 90_000));
      return Promise.resolve({
        audioUploadId: "aud_1",
        uploadUrl: "https://r2.example/put",
      });
    });

    const { result } = mountHook();

    const attrs = await upload(result.current.uploadAudio, makeFile());

    expect(attrs?.uploadStartedAt).toBe(NOW.toISOString());
  });
});

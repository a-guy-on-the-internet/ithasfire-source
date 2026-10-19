import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  SECRET,
  cleanJpeg,
  phoneJpeg,
} from "../../../lib/images/__tests__/image-fixtures";
import {
  IMAGE_STRIP_BUSY,
  IMAGE_STRIP_CONCURRENCY,
  IMAGE_STRIP_MAX_WAITING,
  strippedImageKey,
  stripUploadedImage,
  withImageStripSlot,
} from "../strip-uploaded-image";

describe("strippedImageKey", () => {
  const bytes = Buffer.from("stripped bytes");

  it("keeps the directory and extension; the name is 32 hex chars", () => {
    expect(strippedImageKey("events/e1/images/abc.jpg", bytes)).toMatch(
      /^events\/e1\/images\/[0-9a-f]{32}\.jpg$/,
    );
    expect(strippedImageKey("events/e1/images/a.b.webp", bytes)).toMatch(
      /^events\/e1\/images\/[0-9a-f]{32}\.webp$/,
    );
    expect(strippedImageKey("events/e.1/images/noext", bytes)).toMatch(
      /^events\/e\.1\/images\/[0-9a-f]{32}$/,
    );
    expect(strippedImageKey("events/e1/images/.hidden", bytes)).toMatch(
      /^events\/e1\/images\/[0-9a-f]{32}$/,
    );
  });

  it("is sha256(uploadKey NUL bytes), truncated", () => {
    const key = "events/e1/images/abc.jpg";
    const digest = createHash("sha256")
      .update(Buffer.concat([Buffer.from(`${key}\0`), bytes]))
      .digest("hex")
      .slice(0, 32);
    expect(strippedImageKey(key, bytes)).toBe(`events/e1/images/${digest}.jpg`);
  });

  it("is deterministic, never the upload key, and does not contain it", () => {
    const key = "events/e1/images/0b9f6a1e-1111.jpg";
    expect(strippedImageKey(key, bytes)).toBe(strippedImageKey(key, bytes));
    expect(strippedImageKey(key, bytes)).not.toBe(key);
    expect(strippedImageKey(key, bytes)).not.toContain("0b9f6a1e");
  });

  it("changes with the bytes and with the upload key", () => {
    const key = "events/e1/images/abc.jpg";
    expect(strippedImageKey(key, Buffer.from("other"))).not.toBe(strippedImageKey(key, bytes));
    expect(strippedImageKey("events/e1/images/abd.jpg", bytes)).not.toBe(
      strippedImageKey(key, bytes),
    );
  });
});

function storage(content: Buffer) {
  return {
    getObject: vi.fn(async () => ({ content })),
    putObject: vi.fn(async ({ key }: { key: string }) => ({ url: `https://cdn/${key}` })),
    getObjectUrl: vi.fn(async ({ key }: { key: string }) => ({ url: `https://cdn/${key}` })),
  };
}

describe("stripUploadedImage", () => {
  it("writes the stripped bytes to the derived key and returns them", async () => {
    const { file } = phoneJpeg({ orientation: 6 });
    const fileStorage = storage(file);

    const result = await stripUploadedImage(
      { fileStorage: fileStorage as any },
      { uploadKey: "events/e1/images/abc.jpg", contentType: "image/jpeg", public: true },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The written bytes are only visible through the storage fake: the
    // result carries none.
    const written = fileStorage.putObject.mock.calls[0]![0] as unknown as {
      content: Buffer;
    };
    const expectedKey = strippedImageKey("events/e1/images/abc.jpg", written.content);
    expect(result.key).toBe(expectedKey);
    expect(result.publicUrl).toBe(`https://cdn/${expectedKey}`);
    expect(result.sizeBytes).toBe(written.content.length);
    expect(result.removed).toContain("APP1:Exif");
    expect(result.removedCount).toBe(result.removed.length);
    for (const secret of Object.values(SECRET)) {
      expect(written.content.includes(Buffer.from(secret))).toBe(false);
    }
    expect(fileStorage.getObject).toHaveBeenCalledWith({ key: "events/e1/images/abc.jpg" });
    expect(fileStorage.putObject).toHaveBeenCalledWith({
      key: expectedKey,
      content: written.content,
      options: { contentType: "image/jpeg", public: true },
    });
    expect(fileStorage.getObjectUrl).toHaveBeenCalledWith({
      key: expectedKey,
      options: { public: true },
    });
  });

  it("returns plain data only: dimensions, never the file's bytes", async () => {
    const fileStorage = storage(cleanJpeg());
    const result = await stripUploadedImage(
      { fileStorage: fileStorage as any },
      { uploadKey: "k/plain.jpg", contentType: "image/jpeg", public: true },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Security R1: a buffer in the result outlives the strip slot and
    // escapes its memory bound. The type declares `bytes?: never` (enforced
    // by `pnpm typecheck` on the source); this checks the runtime object: no
    // field holds a Buffer or any typed array.
    expect("bytes" in result).toBe(false);
    for (const value of Object.values(result)) {
      expect(ArrayBuffer.isView(value)).toBe(false);
    }
    expect(result.dimensions).toEqual({ width: expect.any(Number), height: expect.any(Number) });
  });

  it("still writes a copy for a clean file (the upload key is never published)", async () => {
    const fileStorage = storage(cleanJpeg());
    const result = await stripUploadedImage(
      { fileStorage: fileStorage as any },
      { uploadKey: "k/a.jpg", contentType: "image/jpeg", public: true },
    );
    expect(result).toMatchObject({
      ok: true,
      key: strippedImageKey("k/a.jpg", cleanJpeg()),
      removed: [],
      removedCount: 0,
    });
    expect(fileStorage.putObject).toHaveBeenCalledTimes(1);
  });

  it("returns ok:false for unparseable bytes and writes nothing", async () => {
    const fileStorage = storage(Buffer.from("not an image"));
    const result = await stripUploadedImage(
      { fileStorage: fileStorage as any },
      { uploadKey: "k/a.jpg", contentType: "image/jpeg", public: true },
    );
    expect(result).toMatchObject({ ok: false, superseded: false });
    if (result.ok || result.superseded) return;
    expect(result.error.name).toBe("ImageMetadataStripError");
    expect(fileStorage.putObject).not.toHaveBeenCalled();
  });

  it("lets storage failures throw", async () => {
    const fileStorage = storage(cleanJpeg());
    fileStorage.putObject.mockRejectedValueOnce(new Error("r2 down"));
    await expect(
      stripUploadedImage(
        { fileStorage: fileStorage as any },
        { uploadKey: "k/a.jpg", contentType: "image/jpeg", public: true },
      ),
    ).rejects.toThrow("r2 down");
  });

  it("asks stillNeeded inside the slot and reads nothing when it says no", async () => {
    const fileStorage = storage(cleanJpeg());
    const stillNeeded = vi.fn(async () => false);
    const result = await stripUploadedImage(
      { fileStorage: fileStorage as any },
      { uploadKey: "k/s.jpg", contentType: "image/jpeg", public: true, stillNeeded },
    );
    expect(result).toEqual({ ok: false, superseded: true });
    expect(stillNeeded).toHaveBeenCalledTimes(1);
    expect(fileStorage.getObject).not.toHaveBeenCalled();
    expect(fileStorage.putObject).not.toHaveBeenCalled();
  });

  it("concurrent calls for one upload share one read and one result", async () => {
    const fileStorage = storage(cleanJpeg());
    const args = { uploadKey: "k/shared.jpg", contentType: "image/jpeg", public: true };
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        stripUploadedImage({ fileStorage: fileStorage as any }, args),
      ),
    );
    expect(fileStorage.getObject).toHaveBeenCalledTimes(1);
    expect(fileStorage.putObject).toHaveBeenCalledTimes(1);
    expect(new Set(results).size).toBe(1);

    // Settled: the next call is a fresh run.
    await stripUploadedImage({ fileStorage: fileStorage as any }, args);
    expect(fileStorage.getObject).toHaveBeenCalledTimes(2);
  });

  it("a failed shared run fails every joiner, then clears", async () => {
    const fileStorage = storage(cleanJpeg());
    fileStorage.getObject.mockRejectedValueOnce({ code: "not_found", message: "gone" });
    const args = { uploadKey: "k/fail.jpg", contentType: "image/jpeg", public: true };
    const outcomes = await Promise.allSettled([
      stripUploadedImage({ fileStorage: fileStorage as any }, args),
      stripUploadedImage({ fileStorage: fileStorage as any }, args),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected"]);
    await expect(
      stripUploadedImage({ fileStorage: fileStorage as any }, args),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe("withImageStripSlot", () => {
  it(`refuses beyond ${IMAGE_STRIP_MAX_WAITING} waiters with a retryable RATE_LIMITED`, async () => {
    const gates: Array<() => void> = [];
    const hold = () =>
      withImageStripSlot(async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return "done";
      });

    // Fill the slots, then the queue exactly.
    const held = Array.from({ length: IMAGE_STRIP_CONCURRENCY + IMAGE_STRIP_MAX_WAITING }, hold);
    await new Promise((r) => setTimeout(r, 0));

    const ran = vi.fn(async () => "never");
    await expect(withImageStripSlot(ran)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: IMAGE_STRIP_BUSY,
      meta: { reason: IMAGE_STRIP_BUSY, retryable: true },
    });
    expect(ran).not.toHaveBeenCalled();

    // Drain everything (slots hand over to waiters as they free up).
    for (let i = 0; i < 100; i += 1) {
      gates.splice(0).forEach((open) => open());
      await new Promise((r) => setTimeout(r, 0));
    }
    await expect(Promise.all(held)).resolves.toHaveLength(held.length);

    // The queue is free again.
    await expect(withImageStripSlot(async () => "ok")).resolves.toBe("ok");
  });

  it("a refused overflow call leaves nothing behind: the same upload strips normally later", async () => {
    const gates: Array<() => void> = [];
    const held = Array.from({ length: IMAGE_STRIP_CONCURRENCY + IMAGE_STRIP_MAX_WAITING }, () =>
      withImageStripSlot(() => new Promise<void>((resolve) => gates.push(resolve))),
    );
    await new Promise((r) => setTimeout(r, 0));

    const fileStorage = storage(cleanJpeg());
    const args = { uploadKey: "k/refused-then-ok.jpg", contentType: "image/jpeg", public: true };
    await expect(
      stripUploadedImage({ fileStorage: fileStorage as any }, args),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", message: IMAGE_STRIP_BUSY });
    expect(fileStorage.getObject).not.toHaveBeenCalled();

    for (let i = 0; i < 100; i += 1) {
      gates.splice(0).forEach((open) => open());
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(held);

    // Had the refused run stayed in the in-flight map, this call would join
    // it and get the stale refusal back without reading anything.
    await expect(
      stripUploadedImage({ fileStorage: fileStorage as any }, args),
    ).resolves.toMatchObject({ ok: true });
    expect(fileStorage.getObject).toHaveBeenCalledTimes(1);
  });

  it("stripUploadedImage passes the refusal through, and a joiner of a running strip is never refused", async () => {
    const gates: Array<() => void> = [];
    const slow = {
      getObject: vi.fn(async () => {
        await new Promise<void>((resolve) => gates.push(resolve));
        return { content: cleanJpeg() };
      }),
      putObject: vi.fn(async ({ key }: { key: string }) => ({ url: `https://cdn/${key}` })),
      getObjectUrl: vi.fn(async ({ key }: { key: string }) => ({ url: `https://cdn/${key}` })),
    };
    const strip = (uploadKey: string) =>
      stripUploadedImage(
        { fileStorage: slow as any },
        { uploadKey, contentType: "image/jpeg", public: true },
      );

    const total = IMAGE_STRIP_CONCURRENCY + IMAGE_STRIP_MAX_WAITING;
    const running = Array.from({ length: total }, (_, i) => strip(`k/q-${i}.jpg`));
    await new Promise((r) => setTimeout(r, 0));

    await expect(strip("k/q-overflow.jpg")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // Same upload as one already running: joins it, no queue slot needed.
    const joiner = strip("k/q-0.jpg");

    for (let i = 0; i < 200 && (gates.length > 0 || slow.getObject.mock.calls.length < total); i += 1) {
      gates.splice(0).forEach((open) => open());
      await new Promise((r) => setTimeout(r, 0));
    }
    const results = await Promise.all([...running, joiner]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(slow.getObject).toHaveBeenCalledTimes(total);
  });

  it(`runs at most ${IMAGE_STRIP_CONCURRENCY} at once, and every queued call still runs`, async () => {
    let running = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const task = () =>
      withImageStripSlot(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => gates.push(resolve));
        running -= 1;
        return "done";
      });

    const all = Promise.all(Array.from({ length: 7 }, task));
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 0));
      gates.splice(0).forEach((open) => open());
    }
    await expect(all).resolves.toEqual(Array(7).fill("done"));
    expect(peak).toBe(IMAGE_STRIP_CONCURRENCY);
  });

  it("frees the slot when the task throws", async () => {
    const failures = Array.from({ length: IMAGE_STRIP_CONCURRENCY + 1 }, () =>
      withImageStripSlot(async () => {
        throw new Error("boom");
      }),
    );
    await Promise.allSettled(failures);
    await expect(withImageStripSlot(async () => "ok")).resolves.toBe("ok");
  });
});

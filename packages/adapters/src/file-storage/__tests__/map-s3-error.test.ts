import { describe, expect, it } from "vitest";

import { mapS3Error } from "../map-s3-error";

const awsError = (
  name: string,
  httpStatusCode?: number,
  message = "boom",
): Error => {
  const err = new Error(message);
  Object.assign(err, { name, $metadata: { httpStatusCode } });
  return err;
};

describe("mapS3Error", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // The bucket/object distinction. S3 answers NoSuchBucket with 404, the SAME
  // status as a missing key, so a status-first classifier cannot tell "this
  // object is gone" from "the store is misconfigured". Consumers read
  // `not_found` as a terminal DATA state and degrade quietly — image moderation
  // terminally orphans the row, deleteObject reports a deletion that never
  // happened, headObject says a just-written object is absent. A config fault
  // must never be able to wear that costume.
  // ───────────────────────────────────────────────────────────────────────────

  it.each(["NoSuchBucket", "InvalidBucketName"])(
    "classifies %s as dependency_failed even though it is a 404",
    (name) => {
      expect(mapS3Error(awsError(name, 404))).toMatchObject({
        code: "dependency_failed",
      });
    },
  );

  it("still classifies a missing KEY as not_found", () => {
    expect(mapS3Error(awsError("NoSuchKey", 404))).toEqual({
      code: "not_found",
      message: "object_not_found",
    });
    expect(mapS3Error(awsError("NotFound", 404))).toMatchObject({
      code: "not_found",
    });
    // A bare 404 with no recognised name is still an absent object.
    expect(mapS3Error(awsError("Whatever", 404))).toMatchObject({
      code: "not_found",
    });
  });

  it("preserves the pre-existing classifications", () => {
    expect(mapS3Error(awsError("ExpiredToken", 400))).toMatchObject({
      code: "dependency_failed",
    });
    expect(mapS3Error(awsError("SignatureDoesNotMatch", 403))).toMatchObject({
      code: "dependency_failed",
    });
    expect(mapS3Error(awsError("Conflict", 409))).toMatchObject({
      code: "conflict",
    });
    expect(mapS3Error(awsError("InternalError", 503))).toMatchObject({
      code: "transient",
    });
    expect(mapS3Error(awsError("BadRequest", 400))).toMatchObject({
      code: "invalid_input",
    });
    expect(mapS3Error(awsError("Mystery"))).toMatchObject({
      code: "dependency_failed",
    });
  });

  it("falls back to the error name when there is no message", () => {
    const err = Object.assign(new Error(""), {
      name: "InternalError",
      $metadata: { httpStatusCode: 503 },
    });
    expect(mapS3Error(err)).toEqual({
      code: "transient",
      message: "InternalError",
    });
  });

  it("reads the legacy `Code` field when `name` is absent", () => {
    // Some responses populate `Code` rather than `name`.
    expect(mapS3Error({ Code: "NoSuchBucket", $metadata: {} })).toMatchObject({
      code: "dependency_failed",
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The REALISTIC legacy shape. `err.name ?? err.Code` reads like it covers
  // `Code`, but `??` only falls through on null/undefined and every Error
  // instance has a `name` (default "Error"). So `Code` was consulted ONLY for a
  // plain object with no `name` at all — which is not what the SDK produces.
  // The fixture above passes for exactly that reason and proves nothing about
  // the shape the fallback exists for.
  // ───────────────────────────────────────────────────────────────────────────

  it("classifies on `Code` even when a GENERIC `name` is present", () => {
    const err = Object.assign(new Error("The specified bucket does not exist"), {
      name: "S3ServiceException",
      Code: "NoSuchBucket",
      $metadata: { httpStatusCode: 404 },
    });

    // Before the both-fields fix this fell straight through to the 404 branch
    // and returned `not_found`, which image moderation turns into a terminal,
    // invisible ORPHANED row.
    expect(mapS3Error(err)).toMatchObject({ code: "dependency_failed" });
  });

  it("classifies credential failures on `Code` behind a generic `name` too", () => {
    const err = Object.assign(new Error("token has expired"), {
      name: "S3ServiceException",
      Code: "ExpiredToken",
      $metadata: { httpStatusCode: 400 },
    });

    // Same blind spot, one line up: without the fix this landed on the
    // `>= 400 && < 500` branch as `invalid_input`.
    expect(mapS3Error(err)).toMatchObject({ code: "dependency_failed" });
  });

  it("a generic `name` with no interesting `Code` still classifies by status", () => {
    // The both-fields change must not swallow the ordinary path.
    const err = Object.assign(new Error("nope"), {
      name: "S3ServiceException",
      Code: "NoSuchKey",
      $metadata: { httpStatusCode: 404 },
    });
    expect(mapS3Error(err)).toMatchObject({ code: "not_found" });
  });
});

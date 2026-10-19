import type { ApiKeyScope } from "@th/ports/authn";

/**
 * Procedure tags for API keys (scoped-api-keys spec FR-006, R5, NFR-002,
 * NFR-005).
 *
 * A procedure is unreachable by a scoped key until its meta carries a `key`
 * tag (default deny). The tag names:
 *
 * - `permission`: what the procedure does, one name per procedure
 *   (`"orders.list"`). Not read by today's rule: it is there so the
 *   fine-grained role x procedure model (R13, the next step) is a rule change,
 *   not a re-tag (NFR-005);
 * - `subjects`: the key subjects that may call it;
 * - `level`: the access the key needs. A mutation always needs `READ_WRITE`,
 *   whatever the tag says, and NFR-002's test refuses a mutation tagged
 *   `READ`.
 *
 * `{ selfRenewal: true }` is the FR-009 exception: key-only (a session is
 * refused), every subject, no level check. Only `apiKeys.renewSelf`
 * ({@link SELF_RENEWAL_PATH}) may carry it; the gate refuses it anywhere else
 * and NFR-002's test fails on it.
 *
 * Attach with `.meta({ key: { ... } })` before `.input()`.
 */
export type KeySubject = Extract<ApiKeyScope, { kind: "scoped" }>["subject"];
export type KeyAccessLevel = Extract<
  ApiKeyScope,
  { kind: "scoped" }
>["access"];

export type KeyProcedureTag =
  | {
      permission: string;
      subjects: readonly [KeySubject, ...KeySubject[]];
      level: KeyAccessLevel;
    }
  | { selfRenewal: true };

/** The tRPC meta every procedure may carry (`initTRPC.meta<ProcedureMeta>()`). */
export type ProcedureMeta = {
  /** Free text for humans; pre-existing on ~20 procedures. */
  description?: string;
  key?: KeyProcedureTag;
};

/** The one procedure a key may call to renew itself (FR-009, built in step 5). */
export const SELF_RENEWAL_PATH = "apiKeys.renewSelf";

export const KEY_SUBJECTS: readonly KeySubject[] = [
  "ORG",
  "PERSONAL",
  "STAFF",
  "PLATFORM_WIDE",
];

const PERMISSION_PATTERN = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export const isSelfRenewalTag = (
  tag: KeyProcedureTag | undefined,
): tag is { selfRenewal: true } =>
  !!tag && "selfRenewal" in tag && tag.selfRenewal === true;

/**
 * Everything wrong with one procedure's key tag, as human-readable lines
 * (empty = fine). NFR-002's test runs this over every procedure; the gate
 * refuses a key call on any procedure whose tag has a problem, so a bad tag
 * fails closed at runtime too. `isDenylisted` is passed in so this file stays
 * free of the list itself.
 */
export function keyTagProblems(input: {
  path: string;
  type: "query" | "mutation" | "subscription";
  tag: KeyProcedureTag | undefined;
  isDenylisted: (path: string) => boolean;
}): string[] {
  const { path, type, tag } = input;
  if (!tag) return [];
  if (isSelfRenewalTag(tag)) {
    return path === SELF_RENEWAL_PATH
      ? []
      : [`${path}: only ${SELF_RENEWAL_PATH} may carry selfRenewal`];
  }
  const problems: string[] = [];
  if (input.isDenylisted(path)) {
    problems.push(`${path}: denylisted (FR-008) but tagged for keys`);
  }
  if (type === "mutation" && tag.level !== "READ_WRITE") {
    problems.push(`${path}: a mutation tagged ${tag.level}; needs READ_WRITE`);
  }
  if (type === "subscription") {
    problems.push(`${path}: subscriptions are not taggable for keys`);
  }
  if (!Array.isArray(tag.subjects) || tag.subjects.length === 0) {
    problems.push(`${path}: no subjects`);
  } else {
    for (const subject of tag.subjects) {
      if (!KEY_SUBJECTS.includes(subject)) {
        problems.push(`${path}: unknown subject ${String(subject)}`);
      }
    }
    if (new Set(tag.subjects).size !== tag.subjects.length) {
      problems.push(`${path}: a subject is listed twice`);
    }
    // R19: a platform-wide key is read-only, public data only.
    if (tag.subjects.includes("PLATFORM_WIDE") && type !== "query") {
      problems.push(`${path}: PLATFORM_WIDE is read-only (R19)`);
    }
  }
  if (tag.level !== "READ" && tag.level !== "READ_WRITE") {
    problems.push(`${path}: unknown level ${String(tag.level)}`);
  }
  if (
    typeof tag.permission !== "string" ||
    !PERMISSION_PATTERN.test(tag.permission)
  ) {
    problems.push(
      `${path}: permission must look like "router.action" (NFR-005)`,
    );
  }
  return problems;
}

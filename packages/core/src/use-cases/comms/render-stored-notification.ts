import type { ReporterPort } from "@th/ports/reporter";
import type { NotificationRecord } from "@th/ports/repos/notifications";

import { isLocalizedVariant } from "./copy";
import type { NotificationLocale } from "./locale";
import { GENERIC_VARIANT, renderNotification } from "./renderers";
import type { ChannelTemplateRef } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// In-app notification text in the reader's language (owner ruling 2026-10-03,
// option A: render at READ time).
//
// WRITE: `notify` stores the variant and the payload it rendered from on the
// in-app row (`buildInAppTemplateRef`). The row's title/body stay the English
// render — the fallback for old clients, search, and anything below.
//
// READ: the inbox re-runs the same renderer on the stored payload in the
// reader's locale and swaps in title, body and the action's label only
// (`renderStoredNotifications`). Route/href, kind, read state etc. are always
// the stored ones. Only variants in `LOCALIZED_VARIANTS` (copy/index.ts) are
// re-rendered.
//
// The two halves live in one file because they are one contract: what the
// write side stores is exactly what the read side knows how to render.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The version of the stored-payload contract, written by
 * `buildInAppTemplateRef` and required by the read side. Only rows carrying
 * exactly this version are re-rendered; a row from any other version keeps its
 * stored English text. Bump it per the rules on `renderNotification`.
 */
export const IN_APP_TEMPLATE_VERSION = "1";

/**
 * Upper bound on a stored payload, as serialized JSON. The largest renderer
 * schemas top out around 5 KB (a 4000-char booking pitch plus ids and URLs);
 * a payload past this is not one we expect, so the row is stored without it
 * (it stays English) and `notify` reports it.
 */
export const IN_APP_TEMPLATE_MAX_CHARS = 16_384;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** Why a payload that should have been stored was not. */
export type InAppTemplateSkipReason =
  | "not_plain_object"
  | "unserializable"
  | "oversized";

export type InAppTemplateRefResult =
  | { template: ChannelTemplateRef; skipped: null }
  | {
      template: null;
      skipped: InAppTemplateSkipReason;
      /** Serialized size, for `oversized` only. */
      chars?: number;
    };

/**
 * The template ref `notify` stores on an in-app row so it can be re-rendered
 * in another language at read time.
 *
 * - The generic variant stores nothing, by design (not a skip): its text is
 *   entirely caller-supplied, so re-rendering it can only reproduce the
 *   stored text.
 * - A payload that is not a plain JSON object, will not serialize, or is
 *   larger than `IN_APP_TEMPLATE_MAX_CHARS` stores nothing and comes back with
 *   a `skipped` reason: the row would silently stay English forever, so the
 *   caller reports it.
 *
 * The payload goes through a JSON round trip so what the read side re-parses
 * is byte-for-byte what the database will hand back (no `undefined` keys).
 */
export function buildInAppTemplateRef(
  variant: string,
  payload: unknown,
): InAppTemplateRefResult {
  if (variant === GENERIC_VARIANT) return { template: null, skipped: null };
  const source = payload ?? {};
  if (!isPlainRecord(source)) {
    return { template: null, skipped: "not_plain_object" };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(source);
  } catch {
    return { template: null, skipped: "unserializable" };
  }
  if (serialized.length > IN_APP_TEMPLATE_MAX_CHARS) {
    return { template: null, skipped: "oversized", chars: serialized.length };
  }
  return {
    template: {
      key: variant,
      version: IN_APP_TEMPLATE_VERSION,
      variables: JSON.parse(serialized) as Record<string, unknown>,
    },
    skipped: null,
  };
}

/** The fields of a stored row this helper reads or rewrites. */
export type StoredNotificationRow = Pick<
  NotificationRecord,
  | "id"
  | "title"
  | "body"
  | "action"
  | "metadata"
  | "templateKey"
  | "templateVersion"
  | "templateVariables"
  | "createdAt"
>;

export type RenderStoredNotificationDeps = {
  reportError?: ReporterPort;
};

/**
 * True for rows written by `buildInAppTemplateRef` for a variant that has
 * copy in every locale: the current contract version, a variant listed in
 * `LOCALIZED_VARIANTS`, and a template key equal to the variant `sendInApp`
 * recorded in the row's metadata. The last check keeps any other template that
 * might sit on an in-app row (a caller-supplied one on the generic variant)
 * from being mistaken for a renderer payload.
 */
function isRenderableRow(
  row: StoredNotificationRow,
): row is StoredNotificationRow & { templateKey: string } {
  return (
    typeof row.templateKey === "string" &&
    row.templateVersion === IN_APP_TEMPLATE_VERSION &&
    isLocalizedVariant(row.templateKey) &&
    row.metadata?.variant === row.templateKey
  );
}

type PayloadParseFailure = {
  code: "invalid_input";
  message: "invalid_notification_payload";
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>;
};

function isPayloadParseFailure(err: unknown): err is PayloadParseFailure {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { message?: unknown }).message === "invalid_notification_payload" &&
    Array.isArray((err as { issues?: unknown }).issues)
  );
}

/**
 * What gets reported for a failed re-render. Always a real `Error` whose
 * message names the variant, so Sentry groups by it. A payload that no longer
 * parses carries the failing PATHS only: zod issues can echo the received
 * values, and those are the stored payload (which can hold a withheld
 * address).
 */
function describeRenderFailure(
  err: unknown,
  templateKey: string,
): { error: unknown; issuePaths?: string[] } {
  if (isPayloadParseFailure(err)) {
    return {
      error: new Error(
        `renderStoredNotification: stored payload for "${templateKey}" no longer parses`,
      ),
      issuePaths: err.issues.map((issue) =>
        issue.path.map((part) => String(part)).join("."),
      ),
    };
  }
  if (err instanceof Error) return { error: err };
  return {
    error: new Error(
      `renderStoredNotification: re-render of "${templateKey}" failed`,
    ),
  };
}

type RenderFailure = { err: unknown; row: StoredNotificationRow & { templateKey: string } };

/**
 * One row: the localized row, or the stored row plus the failure. Never throws.
 */
function renderOne<T extends StoredNotificationRow>(
  row: T,
  locale: NotificationLocale,
): { row: T; failure: RenderFailure | null } {
  if (locale === "en" || !isRenderableRow(row)) return { row, failure: null };

  try {
    const rendered = renderNotification(
      row.templateKey,
      row.templateVariables ?? {},
      { now: row.createdAt, locale },
    );
    const inApp = rendered.inApp;
    if (!inApp) {
      throw new Error(
        `renderStoredNotification: variant "${row.templateKey}" rendered no in-app payload`,
      );
    }
    return {
      row: {
        ...row,
        title: inApp.title,
        body: inApp.body,
        // Only the label: the stored route/href is what the row was sent with.
        action:
          row.action && inApp.action
            ? { ...row.action, label: inApp.action.label }
            : row.action,
      },
      failure: null,
    };
  } catch (err) {
    return { row, failure: { err, row } };
  }
}

function report(
  deps: RenderStoredNotificationDeps,
  failure: RenderFailure,
  locale: NotificationLocale,
  affectedRows: number,
): void {
  const { error, issuePaths } = describeRenderFailure(
    failure.err,
    failure.row.templateKey,
  );
  // A throwing reporter must never turn a fallback into a failed inbox.
  try {
    deps.reportError?.(error, {
      tags: {
        useCase: "comms.renderStoredNotification",
        locale,
        templateKey: failure.row.templateKey,
        // The router throttles on tags: so a report after a version bump is
        // not suppressed by one from before it.
        templateVersion: failure.row.templateVersion ?? "none",
      },
      extra: {
        notificationId: failure.row.id,
        templateKey: failure.row.templateKey,
        templateVersion: failure.row.templateVersion,
        affectedRows,
        ...(issuePaths ? { issuePaths } : {}),
      },
    });
  } catch {
    // Intentionally empty: nowhere left to report to.
  }
}

/**
 * Returns the rows with title, body and action label in `locale`.
 *
 * - `locale` "en", or a row without a renderable template (old rows, another
 *   contract version, a variant not in `LOCALIZED_VARIANTS`): returned as is.
 * - A re-render that fails (variant gone, stored payload no longer parses,
 *   renderer throws or has no in-app output): that row is returned as is, AND
 *   the failure is reported — a silent fallback would hide a broken contract
 *   behind English text indefinitely.
 *
 * The inbox polls this every 30 s, so reports are throttled to ONE per
 * template key per call (the locale is fixed per call), carrying the number of
 * rows it affected. Never throws.
 */
export function renderStoredNotifications<T extends StoredNotificationRow>(
  deps: RenderStoredNotificationDeps,
  rows: readonly T[],
  locale: NotificationLocale,
): T[] {
  const failures = new Map<string, { first: RenderFailure; count: number }>();
  const out = rows.map((row) => {
    const result = renderOne(row, locale);
    if (result.failure) {
      const key = result.failure.row.templateKey;
      const seen = failures.get(key);
      if (seen) seen.count += 1;
      else failures.set(key, { first: result.failure, count: 1 });
    }
    return result.row;
  });
  for (const { first, count } of failures.values()) {
    report(deps, first, locale, count);
  }
  return out;
}

/** Single-row form of `renderStoredNotifications`. */
export function renderStoredNotification<T extends StoredNotificationRow>(
  deps: RenderStoredNotificationDeps,
  row: T,
  locale: NotificationLocale,
): T {
  return renderStoredNotifications(deps, [row], locale)[0]!;
}

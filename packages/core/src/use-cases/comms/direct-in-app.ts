import type { z } from "zod";

import type { LoggerPort } from "@th/ports/logger";
import type { ReporterPort } from "@th/ports/reporter";
import type {
  CreateNotificationInput,
  NotificationAction,
  NotificationKind,
} from "@th/ports/repos/notifications";

import type { NotificationCategory } from "./categories";
import type { NotificationLocale } from "./locale";
import { buildInAppTemplateRef } from "./render-stored-notification";
import type { RenderNotificationResult } from "./renderers";
import { getNotificationRenderer } from "./renderers";
import { normalizeTemplateRef } from "./shared";

// ─────────────────────────────────────────────────────────────────────────────
// For producers that write an in-app row DIRECTLY (`notifications.create`)
// rather than through `notify`. Renders the row's English text from a
// registered in-app-only variant (direct-money-safety-renderers.ts,
// direct-community-renderers.ts) and builds the template `notify` stores
// (`buildInAppTemplateRef`, normalized like `sendInApp` does), so the inbox can
// re-render the row in the reader's language (render-stored-notification.ts).
//
// The producer keeps everything else about its delivery: it spreads
// `title`/`body`/`kind`/`action`/`template` into its own `create()` call and
// sets `metadata.variant` to `variant` (the read side requires
// `metadata.variant === templateKey`).
//
// Import cycle note: the renderer files import ONLY THE TYPE below from here
// (erased at build time); this module looks renderers up at runtime. It must
// not re-export renderers: producers import the renderer they use directly.
// ─────────────────────────────────────────────────────────────────────────────

/** The shape both direct-renderer files declare their variants with. */
export type DirectRendererDefinition<TSchema extends z.ZodTypeAny> = {
  variant: string;
  category: NotificationCategory;
  schema: TSchema;
  render(
    input: z.infer<TSchema>,
    ctx: { now: Date; locale: NotificationLocale },
  ): RenderNotificationResult;
};

export type DirectInAppNotice = {
  variant: string;
  title: string;
  body: string;
  kind: NotificationKind;
  action: NotificationAction | null;
  /** Undefined when the payload could not be stored (reported). */
  template: CreateNotificationInput["template"];
};

export type DirectInAppNoticeDeps = {
  logger?: LoggerPort;
  reportError?: ReporterPort | null;
};

/**
 * Renders `payload` in English through `definition` and builds its stored
 * template.
 *
 * Throws when `definition` is not the registered renderer for its variant
 * (the inbox could never re-render the row), or when the payload does not fit
 * the variant's schema (a producer bug): callers render inside their existing
 * best-effort handling.
 *
 * A payload that cannot be stored (not a plain object, unserializable, or
 * oversized) is a deliberate fallback, as in `notify`: the row is still
 * written, English for every reader, and the skip is logged and reported
 * (guarded, so a throwing reporter changes nothing).
 */
export function buildDirectInAppNotice<TSchema extends z.ZodTypeAny>(
  deps: DirectInAppNoticeDeps,
  definition: DirectRendererDefinition<TSchema>,
  payload: z.input<TSchema>,
  context: { useCase: string; now?: Date },
): DirectInAppNotice {
  if (getNotificationRenderer(definition.variant) !== definition) {
    throw new Error(
      `buildDirectInAppNotice: variant "${definition.variant}" is not registered in renderers.ts`,
    );
  }

  const parsed = definition.schema.parse(payload) as z.infer<TSchema>;
  const inApp = definition.render(parsed, {
    now: context.now ?? new Date(),
    locale: "en",
  }).inApp;
  if (!inApp) {
    throw new Error(
      `buildDirectInAppNotice: variant "${definition.variant}" rendered no in-app payload`,
    );
  }

  const built = buildInAppTemplateRef(definition.variant, payload);
  if (built.skipped) {
    const chars = "chars" in built ? built.chars : undefined;
    deps.logger?.warn("comms.direct_in_app.template_skipped", {
      variant: definition.variant,
      useCase: context.useCase,
      reason: built.skipped,
      chars,
    });
    try {
      deps.reportError?.(
        new Error(
          `${context.useCase}: in-app template for "${definition.variant}" not stored (${built.skipped})`,
        ),
        {
          tags: {
            useCase: context.useCase,
            variant: definition.variant,
            reason: built.skipped,
          },
          extra: { chars },
        },
      );
    } catch {
      // A throwing reporter must never fail the notification.
    }
  }

  return {
    variant: definition.variant,
    title: inApp.title ?? "",
    body: inApp.body,
    kind: inApp.kind,
    action: inApp.action ?? null,
    template: normalizeTemplateRef(built.template),
  };
}

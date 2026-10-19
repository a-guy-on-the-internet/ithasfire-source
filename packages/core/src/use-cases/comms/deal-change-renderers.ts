import { z } from "zod";

import { formatCents } from "../../lib/currency-utils";
import type { NotificationCategory } from "./categories";
import { formatEventStart } from "./copy/common";
import { DEAL_CHANGE_COPY, type DealChangeCopy } from "./copy/deals";
import { NOTIFICATION_LOCALES, type NotificationLocale } from "./locale";
import type { RenderNotificationResult } from "./renderers";

// ─────────────────────────────────────────────────────────────────────────────
// The frozen-deal change notice (freeze-the-deal FR-006). Sent by
// `deals/_shared/deal-freeze.ts` `notifyDealChange`, after the change commits,
// to every payee on the deal before OR after the change (a payee the change
// removed included), the person who made it excepted. Email + in-app.
//
// The payload is STRUCTURED (amounts, percents, enums), never English
// sentences, so the inbox can re-render it in the reader's language. Each
// line is one thing that changed, before → after; null = not on the deal on
// that side (added / removed).
// ─────────────────────────────────────────────────────────────────────────────

export const DEAL_FROZEN_CHANGE_VARIANT = "deal.frozen-change" as const;

/** At most this many lines ride in the payload; the rest are counted. */
export const DEAL_CHANGE_MAX_LINES = 40;
/** The in-app body lists this many lines, then "and N more". */
const IN_APP_LINES = 5;

const centsSchema = z.number().int().nonnegative();

export const dealChangeValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("SHARE"),
      amountType: z.enum(["FIXED", "PERCENT", "FIXED_AND_PERCENT"]),
      amountCents: centsSchema.nullable(),
      percent: z.number().int().min(0).max(100).nullable(),
      basis: z.enum(["GROSS", "NET_POOL"]),
      resolution: z.enum(["SUM", "GREATER_OF"]).nullable(),
      capPercent: z.number().int().min(0).max(100).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("COST"),
      amountCents: centsSchema.nullable(),
      percent: z.number().int().min(0).max(100).nullable(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("SCHEDULE"),
      schedule: z.enum([
        "ASAP",
        "WEEK_OF_EVENT",
        "ONE_WEEK_AFTER",
        "TWO_WEEKS_AFTER",
        "FOUR_WEEKS_AFTER",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("RESALE_SHARE"),
      type: z.enum(["PERCENT", "FLAT"]),
      bps: z.number().int().min(0).max(10_000).nullable(),
      cents: centsSchema.nullable(),
      payer: z.enum(["SELLER", "BUYER"]),
    })
    .strict(),
  z.object({ kind: z.literal("GUARANTEE"), cents: centsSchema }).strict(),
]);

export type DealChangeValue = z.infer<typeof dealChangeValueSchema>;

export const dealChangeLineSchema = z
  .object({
    section: z.enum(["TICKETS", "RESALE", "BOOKING"]),
    /** The payee the line pays (a cost: who it is credited to). */
    payeeName: z.string().max(300).nullable(),
    /** A clause's display label or a cost's label; verbatim. */
    label: z.string().max(300).nullable(),
    before: dealChangeValueSchema.nullable(),
    after: dealChangeValueSchema.nullable(),
  })
  .strict();

export type DealChangeLine = z.infer<typeof dealChangeLineSchema>;

export const dealChangeNoticePayloadSchema = z
  .object({
    dealChangeId: z.uuid(),
    eventId: z.uuid(),
    eventTitle: z.string().min(1).max(500),
    actorName: z.string().max(300).nullable(),
    changedAtIso: z.string().min(1),
    timezone: z.string().max(100).nullable(),
    /** Absolute link to where the payee sees the deal; null = no link yet. */
    dealUrl: z.url().nullable(),
    lines: z.array(dealChangeLineSchema).max(DEAL_CHANGE_MAX_LINES),
    /** Changed lines left out of `lines` (over the cap). */
    moreLines: z.number().int().nonnegative(),
    /**
     * ISO 4217 (lowercase) the amounts are in: the deal's settlement
     * currency. Absent on payloads stored before it was carried → USD.
     */
    currency: z.string().regex(/^[a-z]{3}$/u).optional(),
    /** Per recipient: the language the EMAIL is written in. Absent → English. */
    emailLocale: z.enum(NOTIFICATION_LOCALES).optional(),
    /**
     * Per recipient: true when the change took them OFF the deal (they were
     * on it before, not after), so the email does not say they are on it.
     */
    recipientRemoved: z.boolean().optional(),
  })
  .strict();

export type DealChangeNoticePayload = z.infer<typeof dealChangeNoticePayloadSchema>;

// ── Formatting ───────────────────────────────────────────────────────────────

function money(cents: number, currency: string): string {
  // Money formatting is not localized (copy/money.ts); the currency is the
  // deal's settlement currency.
  return formatCents(cents, currency);
}

function percentText(value: number): string {
  return `${value}%`;
}

/** Basis points as a percent, without trailing zeros: 250 → "2.5%". */
function bpsText(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

export function formatDealChangeValue(
  copy: DealChangeCopy,
  value: DealChangeValue | null,
  side: "before" | "after",
  currency = "usd",
): string {
  if (value === null) return side === "before" ? copy.notOnDeal : copy.removed;
  switch (value.kind) {
    case "SHARE": {
      const percentOf =
        value.percent !== null
          ? copy.percentOf({ percent: percentText(value.percent), basis: value.basis })
          : null;
      let text: string;
      if (value.amountType === "FIXED") {
        text = money(value.amountCents ?? 0, currency);
      } else if (value.amountType === "PERCENT") {
        text = percentOf ?? percentText(0);
      } else {
        const fixed = money(value.amountCents ?? 0, currency);
        const pct = percentOf ?? percentText(0);
        text =
          value.resolution === "GREATER_OF"
            ? copy.fixedVersusPercent({ fixed, percentOf: pct })
            : copy.fixedPlusPercent({ fixed, percentOf: pct });
      }
      return value.capPercent !== null
        ? copy.capped({ value: text, capPercent: value.capPercent })
        : text;
    }
    case "COST":
      return value.amountCents !== null
        ? money(value.amountCents, currency)
        : copy.percentOf({ percent: percentText(value.percent ?? 0), basis: "GROSS" });
    case "SCHEDULE":
      return copy.schedule(value.schedule);
    case "RESALE_SHARE":
      return copy.resaleShare({
        amount: value.type === "PERCENT" ? bpsText(value.bps ?? 0) : money(value.cents ?? 0, currency),
        payer: value.payer,
      });
    case "GUARANTEE":
      return money(value.cents, currency);
  }
}

function lineSubject(copy: DealChangeCopy, line: DealChangeLine): string {
  const kind = (line.after ?? line.before)?.kind;
  const payee = line.payeeName ?? copy.unnamedPayee;
  let what: string;
  switch (kind) {
    case "SCHEDULE":
      what = copy.schedulePrefix;
      break;
    case "RESALE_SHARE":
      what = copy.resaleSharePrefix;
      break;
    case "GUARANTEE":
      what = copy.guaranteePrefix;
      break;
    case "COST":
      what = copy.cost({ label: line.label ?? "", payeeName: payee });
      break;
    default:
      what = line.label ? `${payee} (${line.label})` : payee;
  }
  return `${copy.sections[line.section]}, ${what}`;
}

/**
 * One changed line in parts, for a page that lays them out itself (the deal
 * page's change history): the same words `formatDealChangeLine` joins.
 */
export function dealChangeLineParts(
  copy: DealChangeCopy,
  line: DealChangeLine,
  currency = "usd",
): { subject: string; before: string; after: string } {
  return {
    subject: lineSubject(copy, line),
    before: formatDealChangeValue(copy, line.before, "before", currency),
    after: formatDealChangeValue(copy, line.after, "after", currency),
  };
}

/** "Ticket sales, Paper Moth: 10% of ticket money → 15% of ticket money". */
export function formatDealChangeLine(
  copy: DealChangeCopy,
  line: DealChangeLine,
  currency = "usd",
): string {
  return `${lineSubject(copy, line)}: ${formatDealChangeValue(copy, line.before, "before", currency)} → ${formatDealChangeValue(copy, line.after, "after", currency)}`;
}

function linesText(
  copy: DealChangeCopy,
  input: DealChangeNoticePayload,
  max: number,
): string[] {
  if (input.lines.length === 0) return [copy.noVisibleLines];
  const currency = input.currency ?? "usd";
  const shown = input.lines
    .slice(0, max)
    .map((l) => `• ${formatDealChangeLine(copy, l, currency)}`);
  const hidden = input.lines.length - Math.min(max, input.lines.length) + input.moreLines;
  if (hidden > 0) shown.push(copy.more(hidden));
  return shown;
}

function routeOf(absoluteUrl: string | null): string | null {
  if (!absoluteUrl) return null;
  try {
    const url = new URL(absoluteUrl);
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

// ── Renderer ─────────────────────────────────────────────────────────────────

type DealChangeRendererDefinition = {
  variant: typeof DEAL_FROZEN_CHANGE_VARIANT;
  category: NotificationCategory;
  schema: typeof dealChangeNoticePayloadSchema;
  render(
    input: DealChangeNoticePayload,
    ctx: { now: Date; locale: NotificationLocale },
  ): RenderNotificationResult;
};

export const dealFrozenChangeRenderer: DealChangeRendererDefinition = {
  variant: DEAL_FROZEN_CHANGE_VARIANT,
  // Money a person is owed changed: never something they can opt out of
  // the way they opt out of announcements.
  category: "transactional",
  schema: dealChangeNoticePayloadSchema,
  render(input, ctx): RenderNotificationResult {
    const copy = DEAL_CHANGE_COPY[ctx.locale];
    // The email is written in the recipient's stored language, carried per
    // recipient in the payload (the render itself always runs in English).
    const emailLocale: NotificationLocale = input.emailLocale ?? "en";
    const mail = DEAL_CHANGE_COPY[emailLocale];
    const changeCount = input.lines.length + input.moreLines;
    const tags = ["deal", "deal-frozen-change"];
    const metadata = { eventId: input.eventId, dealChangeId: input.dealChangeId };
    const route = routeOf(input.dealUrl);
    const when = formatEventStart(emailLocale, input.changedAtIso, input.timezone);

    const title = mail.title({ eventTitle: input.eventTitle });
    const summary = mail.body({ actorName: input.actorName, eventTitle: input.eventTitle, changeCount });

    return {
      category: "transactional",
      // One notice per change per recipient (the idempotency key carries the
      // recipient); the fingerprint is the change.
      fingerprint: { variant: DEAL_FROZEN_CHANGE_VARIANT, dealChangeId: input.dealChangeId },
      inApp: {
        title: copy.title({ eventTitle: input.eventTitle }),
        body: [
          copy.body({ actorName: input.actorName, eventTitle: input.eventTitle, changeCount }),
          ...linesText(copy, input, IN_APP_LINES),
        ].join("\n"),
        kind: "INFO",
        action: route ? { label: copy.viewDealLabel, route } : null,
        expiresAt: null,
        tags,
        metadata,
        template: null,
      },
      email: {
        subject: title,
        text: [
          title,
          summary,
          linesText(mail, input, DEAL_CHANGE_MAX_LINES).join("\n"),
          mail.changedBy({ actorName: input.actorName ?? mail.someone, when }),
          ...(input.dealUrl ? [`${mail.viewDealLabel}: ${input.dealUrl}`] : []),
          input.recipientRemoved ? mail.footerWasOnDeal : mail.footerOnDeal,
        ].join("\n\n"),
        tags,
        metadata,
      },
    };
  },
};

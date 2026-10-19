"use client";

import type { ReactNode } from "react";
import { YStack } from "tamagui";
import { Badge, Text, useFormatters, useTranslations } from "@th/ui";

import { fmtCurrency, fmtDateShort } from "@/lib/format";
import { ACCENT_FILL, BORDER, ON_ACCENT_FILL } from "@/lib/design-tokens";

import {
  answerLead,
  formatPayoutNight,
  minimumVerdict,
  readyNowDiffers,
  sendCaption,
  type PayoutHeadline,
} from "./payout-headline";

// ─────────────────────────────────────────────────────────────────────────────
// The answer (board B, "Answer first", owner 2026-10-14): one sentence that
// says how much goes out tonight and how much more is coming, with the next
// run's date under it, and "Owed to you" beside it. "Ready now" joins the
// side only when it differs from what we send (`readyNowDiffers`).
//
// The answer cell is the page's one accent fill, on the AA rung
// (`ACCENT_FILL` + `ON_ACCENT_FILL`, 5.92:1) because it carries text — bare
// `$accent` has no AA foreground in either polarity. It drops to the plain
// surface when nothing measured is going out (on hold, or unknown): an
// accent "We send it" over a zero that is not the rule working would shout
// the wrong thing.
//
// Stacking is container-driven, not media-query-driven: the admin rail eats
// viewport width, so a 1040px window is not 1040px of content. Each cell's
// flex-basis is `(STACK_BELOW - 100%) * 999`: negative (so 0, and the grow
// ratio splits the row) above the threshold, huge (so each cell takes its
// own line) below it. No intermediate state leaves an empty cell showing the
// rule colour through the gap.
// ─────────────────────────────────────────────────────────────────────────────

const ANSWER_STACK_BELOW_PX = 640;
const STACK_BASIS = `calc((${ANSWER_STACK_BELOW_PX}px - 100%) * 999)`;

const EM_DASH = "—";

const frameStyle = {
  display: "flex",
  // The answer sentence sizes itself to this frame (`.th-payout-answer` in
  // globals.css), not to the viewport: the admin rail eats viewport width.
  containerType: "inline-size",
  flexWrap: "wrap",
  gap: 2,
  backgroundColor: "var(--borderColor, #211C16)",
  border: "2px solid var(--borderColor, #211C16)",
} as const;

// Padding comes from `.th-payout-answer-main` (globals.css), which steps it
// down on a phone-width frame.
const mainCellStyle = {
  flex: `1.6 1 ${STACK_BASIS}`,
  minWidth: 0,
  backgroundColor: "var(--surface, #FDFAF3)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
} as const;

const accentMainCellStyle = {
  ...mainCellStyle,
  backgroundColor: ACCENT_FILL,
  color: ON_ACCENT_FILL,
} as const;

const sideCellStyle = {
  flex: `1 1 ${STACK_BASIS}`,
  minWidth: 0,
  padding: "16px 20px",
  backgroundColor: "var(--surface, #FDFAF3)",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 14,
} as const;

/**
 * The sentence with each amount it names wrapped in a nowrap span. Splits on
 * the exact formatted strings, longest first, so "$12.00" never matches
 * inside "$112.00". The text content is unchanged.
 */
export function answerParts(text: string, amounts: string[]): ReactNode[] {
  const unique = [...new Set(amounts.filter((a) => a.length > 0))].sort(
    (a, b) => b.length - a.length,
  );
  if (unique.length === 0) return [text];
  const escaped = unique.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp("(" + escaped.join("|") + ")", "g");
  return text
    .split(pattern)
    .filter((part) => part !== "")
    .map((part, i) =>
      unique.includes(part) ? (
        <span key={i} className="th-payout-answer-amount">
          {part}
        </span>
      ) : (
        part
      ),
    );
}

/** The loading placeholder, in the answer's own frame so nothing reflows. */
export function PayoutAnswerSkeleton() {
  return (
    <div style={{ ...frameStyle, opacity: 0.35 }} aria-hidden>
      <div style={{ ...mainCellStyle, height: 132, backgroundColor: BORDER }} />
      <div style={{ ...sideCellStyle, height: 132, backgroundColor: BORDER }} />
    </div>
  );
}

/**
 * A figure never breaks mid-number. Instead it steps down the type scale by
 * formatted length so a seven-digit amount still fits a cell on a phone (146px
 * of content box at a 320px viewport; see `figureSizeXs`): 32px ($7, the h3 rung) up to nine characters,
 * 24px ($6) to eleven, 20px ($5) beyond.
 */
const figureStyle = {
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap",
} as const;

export function figureSizeFor(formatted: string): {
  fontSize: "$7" | "$6" | "$5";
  lineHeight: "$7" | "$6" | "$5";
} {
  if (formatted.length <= 9) return { fontSize: "$7", lineHeight: "$7" };
  if (formatted.length <= 11) return { fontSize: "$6", lineHeight: "$6" };
  return { fontSize: "$5", lineHeight: "$5" };
}

/**
 * One rung down on a phone ($xs, 480px and under). A nine-character figure at
 * the $7 rung is 169px wide; the cell's content box at a 320px viewport is
 * 146px, so it ran into the border. Desktop keeps `figureSizeFor` untouched.
 */
export function figureSizeXs(formatted: string): {
  fontSize: "$6" | "$5";
  lineHeight: "$6" | "$5";
} {
  const { fontSize } = figureSizeFor(formatted);
  return fontSize === "$7"
    ? { fontSize: "$6", lineHeight: "$6" }
    : { fontSize: "$5", lineHeight: "$5" };
}

/** One labelled figure in the side cell. */
function SideFigure({
  label,
  value,
  unknown = false,
  chip,
  sub,
  testId,
}: {
  label: string;
  value: string;
  /** Paints the figure red — only for an UNKNOWN figure, never a zero. */
  unknown?: boolean;
  chip?: ReactNode;
  sub?: string | null;
  testId: string;
}) {
  return (
    <YStack gap="$1" minWidth={0} data-testid={testId}>
      <Text variant="overline" tone="muted">
        {label}
      </Text>
      {/* `tag="span"`: the h3 SCALE, not an h3 heading — figures must not
          become headings in the screen-reader outline. */}
      <Text
        variant="h3"
        tag="span"
        weight="bold"
        tone={unknown ? "error" : "default"}
        {...figureSizeFor(value)}
        $xs={figureSizeXs(value)}
        style={figureStyle}
        data-testid={`${testId}-value`}
      >
        {value}
      </Text>
      {chip}
      {sub ? (
        <Text variant="caption" tone="muted">
          {sub}
        </Text>
      ) : null}
    </YStack>
  );
}

export function PayoutPanel({
  headline,
  payoutsBlocked = false,
  later = null,
}: {
  headline: PayoutHeadline;
  /** Stripe status LOADED and payouts not enabled: the batch will skip. */
  payoutsBlocked?: boolean;
  /**
   * Money still maturing after tonight (`comingLater`), org path only. Null
   * when it cannot be said honestly — the clause is then left out.
   */
  later?: { cents: number; by: Date | null } | null;
}) {
  const t = useTranslations();
  const fmt = useFormatters();
  // A figure never wraps inside the sentence: a space inside a formatted
  // amount ("4.282,51 US$") becomes a no-break space, and each amount the
  // sentence names is set nowrap + tabular (`answerParts`).
  const amounts: string[] = [];
  const money = (cents: number) => {
    const formatted = fmtCurrency(fmt, cents, headline.currency).replace(
      / /g,
      " ",
    );
    amounts.push(formatted);
    return formatted;
  };

  const verdict = minimumVerdict(headline);
  const lead = answerLead(headline, payoutsBlocked);

  // The caption names the night of the next batch run when the server said,
  // and always carries "before any holds or fees" (owner ruling 2026-10-12):
  // the figure forecasts the batch's INPUT, not what lands.
  const nightLabel =
    headline.nextPayoutRunNight !== null
      ? formatPayoutNight(fmt, headline.nextPayoutRunNight)
      : null;
  const caption = sendCaption(t, verdict, nightLabel, payoutsBlocked);
  // "Tonight" only when the server named the run's night. A schedule the
  // server cannot name (`nextPayoutRun: null`) gets "the next run" instead,
  // never a guessed evening.
  const tonight = nightLabel !== null;
  const nothingKey = tonight
    ? "admin.payoutsAnswerSendsNothing"
    : "admin.payoutsAnswerNextRun";

  // ── The sentence ─────────────────────────────────────────────────────────
  const sentence: string[] = [];
  if (lead.kind === "sends") {
    sentence.push(
      String(
        t(
          !tonight
            ? "admin.payoutsAnswerNextRun"
            : lead.cents > 0
              ? "admin.payoutsAnswerSends"
              : "admin.payoutsAnswerSendsNothing",
          { amount: money(lead.cents) },
        ),
      ),
    );
    if (later) {
      sentence.push(
        String(
          later.by
            ? t("admin.payoutsAnswerLaterBy", {
                amount: money(later.cents),
                date: fmtDateShort(fmt, later.by),
              })
            : t("admin.payoutsAnswerLater", { amount: money(later.cents) }),
        ),
      );
    }
  } else if (lead.kind === "on-hold") {
    sentence.push(String(t(nothingKey, { amount: money(0) })));
    if (lead.readyCents !== null) {
      sentence.push(
        String(
          t("admin.payoutsAnswerWaitingForStripe", {
            amount: money(lead.readyCents),
          }),
        ),
      );
    }
  } else {
    sentence.push(
      String(
        t(
          tonight
            ? "admin.payoutsAnswerUnknown"
            : "admin.payoutsAnswerUnknownNextRun",
        ),
      ),
    );
  }

  const label = String(
    t(
      lead.kind === "sends" && tonight
        ? "admin.payoutsAnswerLabelTonight"
        : lead.kind === "on-hold"
          ? "admin.payoutsAnswerLabelOnHold"
          : "admin.payoutsSendLabel",
    ),
  );

  const accent = lead.kind === "sends";

  // ── Ready now, only when it differs from what we send ────────────────────
  const showReady = readyNowDiffers(verdict, payoutsBlocked);
  // The payable, or an honest blank. A negative payable is a carried-forward
  // debt and is shown signed, never clamped.
  const readyKnown = headline.payableResolved && headline.payableCents !== null;
  const readyValue = readyKnown ? money(headline.payableCents!) : EM_DASH;

  // Money sitting beside the balance, never inside it: reserve withheld from
  // past transfers, and cents held against open disputes. Nothing when there
  // is none.
  const withheld = [
    headline.reserveCents > 0
      ? String(
          t("admin.payoutsReserveHeld", {
            amount: money(headline.reserveCents),
          }),
        )
      : null,
    headline.pendingHoldCents > 0
      ? String(
          t("admin.payoutsDisputeHeld", {
            amount: money(headline.pendingHoldCents),
          }),
        )
      : null,
  ].filter((line): line is string => line !== null);

  return (
    <YStack gap="$2">
      <div style={frameStyle} data-testid="payout-panel">
        <div
          className="th-payout-answer-main"
          style={accent ? accentMainCellStyle : mainCellStyle}
          data-testid="payout-send"
          data-state={lead.kind}
        >
          <Text variant="overline" tone={accent ? "inherit" : "muted"}>
            {label}
          </Text>
          {/* A sentence, not a heading: sentence case, sized to the frame
              (board `.ans .big`). Plain <p> so no heading variant can
              uppercase it; the type lives in globals.css. */}
          <p className="th-payout-answer" data-testid="payout-answer">
            {answerParts(sentence.join(" "), amounts)}
          </p>
          {/* Full-strength white on the accent rung: an opacity-muted white
              would slide under AA, so the accent cell mutes nothing. */}
          <Text variant="caption" tone={accent ? "inherit" : "muted"}>
            {caption}
          </Text>
        </div>
        <div style={sideCellStyle}>
          <SideFigure
            testId="payout-owed"
            label={String(t("admin.payoutsOwedLabel"))}
            value={money(headline.balanceCents)}
          />
          {showReady && (
            <SideFigure
              testId="payout-ready"
              label={String(t("admin.payoutsReadyLabel"))}
              value={readyValue}
              unknown={!readyKnown}
              chip={
                readyKnown ? null : (
                  <Badge tone="danger" size="sm" alignSelf="flex-start">
                    {String(t("admin.payoutsCouldntCheck"))}
                  </Badge>
                )
              }
              sub={
                readyKnown && headline.payableCents! < 0
                  ? String(t("admin.payoutsReadyDebtSub"))
                  : null
              }
            />
          )}
        </div>
      </div>
      {withheld.length > 0 && (
        <Text
          variant="caption"
          tone="muted"
          style={{ fontVariantNumeric: "tabular-nums" }}
          data-testid="payout-withheld"
        >
          {withheld.join(" · ")}
        </Text>
      )}
    </YStack>
  );
}

"use client";

import { Timer } from "lucide-react";
import { Text, useFormatters, useTranslations } from "@th/ui";

import { holdActLabel } from "@/app/admin/[slug]/_components/event-calendar-holds";

import { holdPositionKey } from "./booking-holds";
import { describeHoldDay, type HoldDayCell } from "./hold-date-grid";
import styles from "./HoldDatePicker.module.css";

// ─────────────────────────────────────────────────────────────────────────────
// THE FOCUSED DAY'S LINE — ordered positions, act names, the reply clock, and
// where this act would land.
//
// STAFF-SIDE ONLY, and deliberately: `holdActLabel` reads names the calendar
// overlay already resolves for owner-gated surfaces. The act's own view (FR-013)
// shows its position and never the line.
//
// NOT A LIVE REGION — a deliberate departure from the prototype. The grid is a
// roving-tabindex month, so every arrow key already announces a cell whose
// accessible name carries the count, the offered position and the asked-for
// flag. Announcing the rail on top of that reads a four-line list after every
// single arrow press, which makes the grid unusable with a screen reader. The
// rail is visual detail for a sighted booker; the sentence a screen-reader
// user needs is already on the cell.
// ─────────────────────────────────────────────────────────────────────────────

export function HoldDayRail({
  cell,
  testIdBase,
}: {
  cell: HoldDayCell | null;
  testIdBase: string;
}) {
  const t = useTranslations();
  const fmt = useFormatters();

  if (!cell) return null;

  const described = describeHoldDay(cell);
  const ordinal = (position: number) =>
    String(t(holdPositionKey(position), { position: String(position) }));

  return (
    <div className={styles.rail} data-testid={`${testIdBase}-rail`} data-date={cell.date}>
      <Text variant="h6" weight="bold">
        {fmt.dateTime(new Date(`${cell.date}T12:00:00Z`), {
          weekday: "long",
          day: "numeric",
          month: "long",
          timeZone: "UTC",
        })}
      </Text>

      {described.kind === "past" ? (
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.bkHoldPickRailPast"))}
        </Text>
      ) : null}
      {described.kind === "dark" ? (
        // The rail is where the dark night's rule gets explained: the server
        // allows the hold, so the picker does too — opening for it is a
        // decision the venue makes later, not one this form can make for them.
        <Text variant="bodySmall" tone="muted">
          {String(t("admin.bkHoldPickRailDark"))}
        </Text>
      ) : null}
      {described.kind === "taken" ? (
        <Text variant="bodySmall" tone="muted">
          {described.label
            ? String(t("admin.bkHoldPickRailTaken", { label: described.label }))
            : String(t("admin.bkHoldPickRailTakenUnnamed"))}
        </Text>
      ) : null}

      {described.kind !== "taken" && described.kind !== "past" ? (
        <div className={styles.railSection}>
          <Text variant="overline" tone="muted">
            {String(t("admin.bkHoldPickRailLine"))}
          </Text>
          {cell.line.length === 0 && cell.minePosition === null ? (
            <Text variant="bodySmall" tone="muted">
              {String(t("admin.bkHoldPickRailEmpty"))}
            </Text>
          ) : (
            <>
              {cell.line.map((hold) => {
                const isMine = hold.position === cell.minePosition;
                return (
                  <div
                    key={hold.id}
                    className={styles.lineRow}
                    data-testid={`${testIdBase}-rail-hold-${hold.id}`}
                  >
                    <Text variant="overline" tone="muted" flexShrink={0} width={26} style={{ fontVariantNumeric: "tabular-nums" }}>
                      {ordinal(hold.position)}
                    </Text>
                    <Text
                      variant="bodySmall"
                      weight={isMine ? "semibold" : "regular"}
                      flex={1}
                      minWidth={0}
                      truncate
                    >
                      {isMine
                        ? String(t("admin.bkHoldPickRailYouHeld"))
                        : (holdActLabel(hold) ?? String(t("admin.ecHoldUnnamedAct")))}
                    </Text>
                    {hold.status === "CHALLENGED" ? (
                      <span className={styles.lineClock}>
                        <Timer
                          size={11}
                          strokeWidth={2}
                          role="img"
                          aria-label={String(t("admin.ecHoldChallenged"))}
                          color="var(--warning, #92400E)"
                        />
                      </span>
                    ) : null}
                  </div>
                );
              })}
              {cell.offeredPosition !== null ? (
                <div className={styles.lineRow} data-testid={`${testIdBase}-rail-you`}>
                  <Text
                    variant="overline"
                    flexShrink={0}
                    width={26}
                    color="var(--accentText, #A8300F)"
                    style={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    {ordinal(cell.offeredPosition)}
                  </Text>
                  <Text variant="bodySmall" weight="semibold" flex={1} minWidth={0} truncate>
                    {String(t("admin.bkHoldPickRailYouWould"))}
                  </Text>
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}

      {cell.preferred ? (
        <div className={styles.railSection}>
          <Text variant="overline" tone="muted">
            {String(t("admin.bkHoldPickRailAskedLabel"))}
          </Text>
          <Text variant="bodySmall" tone="muted">
            {String(t("admin.bkHoldPickRailAsked"))}
          </Text>
        </div>
      ) : null}
    </div>
  );
}

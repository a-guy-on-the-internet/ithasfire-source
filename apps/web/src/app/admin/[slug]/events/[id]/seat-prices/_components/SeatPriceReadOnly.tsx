"use client";

import { YStack } from "tamagui";

import { Text, useTranslations } from "@th/ui";

import { BORDER } from "@/lib/design-tokens";

import { SeatPriceNotice } from "./SeatPriceNotice";
import type { FormatCents } from "./seat-price-labels";
import { listStoredPrices, type SeatPriceModel } from "./seat-price-model";

export type SeatPriceReadOnlyProps = {
  model: SeatPriceModel;
  formatCents: FormatCents;
  /** The event was cancelled, as opposed to having run its course. */
  cancelled: boolean;
};

/**
 * A closed event (`editable: false`: cancelled, completed or archived). The
 * write refuses every change, so there are no checkboxes and no fields: only
 * the custom prices that were stored, with their notes.
 */
export function SeatPriceReadOnly({
  model,
  formatCents,
  cancelled,
}: SeatPriceReadOnlyProps) {
  const t = useTranslations();
  const lines = listStoredPrices(model);

  return (
    <YStack gap="$3" maxWidth={560} data-testid="seat-price-read-only">
      <SeatPriceNotice
        title={String(
          t(
            cancelled
              ? "admin.seatPricesClosedCancelledTitle"
              : "admin.seatPricesClosedTitle",
          ),
        )}
      >
        {String(t("admin.seatPricesClosedBody"))}
      </SeatPriceNotice>

      {lines.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            borderTop: `1px solid ${BORDER}`,
          }}
        >
          {lines.map((line) => (
            <li
              key={line.key}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) auto",
                columnGap: 12,
                rowGap: 2,
                padding: "8px 0",
                borderBottom: `1px solid ${BORDER}`,
              }}
            >
              <Text variant="bodySmall">
                {line.sectionName} · {line.seatLabels.join(", ")}
              </Text>
              <Text
                fontFamily="$mono"
                fontSize={13}
                letterSpacing={0.4}
                weight="semibold"
              >
                {line.priceCents === null
                  ? String(t("admin.seatPricesUnreadableRow"))
                  : formatCents(line.priceCents)}
              </Text>
              {line.note ? (
                <Text
                  variant="caption"
                  tone="muted"
                  style={{ gridColumn: "1 / -1" }}
                >
                  {line.note}
                </Text>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <Text variant="caption" tone="muted">
        {String(
          t(
            lines.length > 0
              ? "admin.seatPricesClosedRest"
              : "admin.seatPricesClosedNone",
          ),
        )}
      </Text>
    </YStack>
  );
}

SeatPriceReadOnly.displayName = "SeatPriceReadOnly";

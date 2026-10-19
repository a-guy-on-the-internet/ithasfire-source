import { Column, Row, Text } from "@react-email/components";
import { type ReactElement, type ReactNode } from "react";

import { INK, bodyText, monoLabel } from "./printed-styles";
import { Spaced } from "./Spaced";

export type LedgerRow = { label: string; value: ReactNode };

/**
 * Key/value rows under a 2px ink rule, 1px ink rule between rows, mono label
 * column at ~34%. Rules sit on the `<td>`s (the first row's cells carry the
 * 2px top rule) because Outlook desktop is unreliable on table/div borders.
 * Renders nothing when there are no rows.
 */
export const Ledger = ({
  rows,
}: {
  rows: ReadonlyArray<LedgerRow>;
}): ReactElement | null => {
  if (rows.length === 0) return null;
  return (
    <Spaced top={24}>
      {rows.map(({ label, value }, index) => {
        const cell = {
          padding: "12px 0",
          verticalAlign: "top" as const,
          borderBottom: `1px solid ${INK}`,
          ...(index === 0 ? { borderTop: `2px solid ${INK}` } : {}),
        };
        return (
          <Row key={label}>
            <Column style={{ ...cell, width: "34%", paddingRight: "12px" }}>
              <Text style={monoLabel(11)}>{label}</Text>
            </Column>
            <Column style={cell}>
              <Text style={{ ...bodyText, fontSize: "15px" }}>{value}</Text>
            </Column>
          </Row>
        );
      })}
    </Spaced>
  );
};

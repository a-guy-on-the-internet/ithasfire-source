import { Column, Row, Text } from "@react-email/components";
import { type CSSProperties, type ReactElement } from "react";

import { tokens } from "../../theme/tokens";
import { ACCENT, INK, LINE, MUTED, monoLabel } from "./printed-styles";

/** Where an application is, as the three-segment bar shows it. */
export type ApplicationStage =
  | "review"
  | "back_in_review"
  | "approved"
  | "declined"
  | "waitlist";

type Segment = {
  label: string;
  fill: string;
  /** "Where it is now": white with a 2px accent border. */
  outline?: boolean;
  /** The current step's label is ink and heavier. */
  strong?: boolean;
};

const WHITE = "#FFFFFF";

/** Filled = done, outlined = where it is now, grey = not yet. */
const segmentsFor = (stage: ApplicationStage): Segment[] => {
  const done = { fill: ACCENT };
  const notYet = { fill: LINE };
  const now = { fill: WHITE, outline: true };
  switch (stage) {
    case "review":
      return [
        { label: "Applied", ...done },
        { label: "In review", ...now, strong: true },
        { label: "Decision", ...notYet },
      ];
    case "back_in_review":
      return [
        { label: "Applied", ...done },
        { label: "Back in review", ...now, strong: true },
        { label: "Decision", ...notYet },
      ];
    case "approved":
      return [
        { label: "Applied", ...done },
        { label: "In review", ...done },
        { label: "Approved", ...done, strong: true },
      ];
    case "declined":
      return [
        { label: "Applied", ...done },
        { label: "In review", ...done },
        { label: "Not approved", fill: INK, strong: true },
      ];
    case "waitlist":
      return [
        { label: "Applied", ...done },
        { label: "In review", ...done },
        // Amber is a segment FILL only; the label under it stays ink.
        { label: "Waitlist", fill: tokens.colors.support, strong: true },
      ];
  }
};

/**
 * The bar is table cells end to end: each segment is a `<td>` whose height,
 * fill and border sit on the cell itself, because Outlook desktop drops
 * borders and heights on `<div>`/`<p>`. A filled segment is 10px tall; the
 * outlined one is 6px plus a 2px border top and bottom, so all three line up.
 *
 * Each cell holds an `&nbsp;` (empty cells collapse in some clients), so its
 * line box is pinned to the cell height: `line-height` and `font-size` equal
 * the height, and `mso-line-height-rule: exactly` stops Outlook desktop from
 * growing the line to its default minimum and fattening the bar.
 */
export const StatusBar = ({
  stage,
}: {
  stage: ApplicationStage;
}): ReactElement => {
  const segments = segmentsFor(stage);
  const spacer = (
    segment: Segment,
  ): CSSProperties & { msoLineHeightRule: string } => {
    const px = `${segment.outline ? 6 : 10}px`;
    return {
      height: px,
      lineHeight: px,
      fontSize: px,
      msoLineHeightRule: "exactly",
      backgroundColor: segment.fill,
      border: segment.outline ? `2px solid ${ACCENT}` : "none",
    };
  };
  return (
    <Row>
      {segments.map((segment, index) => (
        <Column
          key={segment.label}
          style={{
            width: "33.33%",
            paddingRight: index < segments.length - 1 ? "4px" : 0,
            verticalAlign: "top",
          }}
        >
          <table
            role="presentation"
            width="100%"
            cellPadding={0}
            cellSpacing={0}
            border={0}
          >
            <tbody>
              <tr>
                <td height={segment.outline ? 6 : 10} style={spacer(segment)}>
                  &nbsp;
                </td>
              </tr>
            </tbody>
          </table>
          <Text
            style={{
              ...monoLabel(
                11,
                segment.strong ? INK : MUTED,
                segment.strong ? 600 : 500,
              ),
              marginTop: "8px",
            }}
          >
            {segment.label}
          </Text>
        </Column>
      ))}
    </Row>
  );
};

import { Column, Row, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { INK, bodyText, monoLabel } from "./printed-styles";
import { Spaced } from "./Spaced";

/**
 * "From the organizer": the organizer's own words, verbatim, behind a 4px ink
 * left rule (on the `<td>`, not a `<p>`, for Outlook). Renders nothing when
 * there is no note. `pre-line` keeps the organizer's own line breaks.
 */
export const OrganizerNote = ({
  note,
}: {
  note?: string | null;
}): ReactElement | null => {
  if (!note) return null;
  return (
    <Spaced top={24}>
      <Row>
        <Column style={{ borderLeft: `4px solid ${INK}`, paddingLeft: "16px" }}>
          <Text style={monoLabel(11)}>From the organizer</Text>
          <Text
            style={{ ...bodyText, marginTop: "6px", whiteSpace: "pre-line" }}
          >
            {note}
          </Text>
        </Column>
      </Row>
    </Spaced>
  );
};

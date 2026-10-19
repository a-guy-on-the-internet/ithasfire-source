import { Button, Column, Link, Row, Text } from "@react-email/components";
import { type ReactElement } from "react";

import { INK, SANS, bodyText, linkStyle } from "./printed-styles";
import { Spaced } from "./Spaced";

export type PrintedCtaKind = "primary" | "secondary" | "link";

const WHITE = "#FFFFFF";

/**
 * The printed frame's one call to action.
 *
 * - `primary`: full-width ink fill, white uppercase label.
 * - `secondary`: full-width white with a 2px ink border.
 * - `link`: an accent text link.
 *
 * Buttons are "bulletproof": the fill and border live on the wrapping `<td>`
 * as well as the `<a>`'s fill, so Outlook desktop (which ignores borders and
 * block display on `<a>`) still draws a full-width bordered or filled bar.
 */
export const PrintedCta = ({
  kind,
  label,
  href,
}: {
  kind: PrintedCtaKind;
  label: string;
  href: string;
}): ReactElement => {
  if (kind === "link") {
    return (
      <Text style={{ ...bodyText, marginTop: "24px" }}>
        <Link href={href} style={linkStyle}>
          {label}
        </Link>
      </Text>
    );
  }
  const primary = kind === "primary";
  const fill = primary ? INK : WHITE;
  return (
    <Spaced top={28}>
      <Row>
        <Column
          style={{
            backgroundColor: fill,
            border: primary ? "none" : `2px solid ${INK}`,
          }}
        >
          <Button
            href={href}
            style={{
              display: "block",
              textAlign: "center",
              padding: "16px 24px",
              fontFamily: SANS,
              fontWeight: 700,
              fontSize: "15px",
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              textDecoration: "none",
              backgroundColor: fill,
              color: primary ? WHITE : INK,
            }}
          >
            {label}
          </Button>
        </Column>
      </Row>
    </Spaced>
  );
};

import { Column, Row } from "@react-email/components";
import { type ReactElement, type ReactNode } from "react";

/**
 * A vertical gap above a block, as `padding-top` on a `<td>`. Outlook desktop
 * drops `margin` on tables, so `<Row style={{ marginTop }}>` collapses there.
 * The gap gets its own cell (rather than padding the block's own cell) so it
 * sits outside any border the block draws.
 */
export const Spaced = ({
  top,
  children,
}: {
  top: number;
  children: ReactNode;
}): ReactElement => (
  <Row>
    <Column style={{ paddingTop: `${top}px` }}>{children}</Column>
  </Row>
);

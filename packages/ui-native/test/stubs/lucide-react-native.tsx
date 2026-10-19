import { createElement } from "react";

/**
 * Every Lucide glyph resolves to the same inert `<i>` carrying its size and
 * stroke width as data attributes.
 *
 * The hero glyph is one of the FIVE redundancy channels (NFR-002), so tests
 * assert that one is PRESENT and at the hero size — not which shape it is.
 * Icon identity is already covered by the pure decision table
 * (`scan-result-presentation.test.ts`).
 */
type IconProps = {
  size?: number;
  color?: string;
  strokeWidth?: number;
  testID?: string;
};

const makeIcon = (name: string) => {
  const Icon = ({ size, color, strokeWidth, testID }: IconProps) =>
    createElement("i", {
      "data-icon": name,
      "data-size": size,
      "data-stroke-width": strokeWidth,
      "data-color": color,
      "data-testid": testID ?? "lucide-icon",
    });
  Icon.displayName = `${name}Stub`;
  return Icon;
};

/**
 * `lucide-react-native` exports ~1500 named icons. A Proxy hands back a stub
 * for any of them, so this file never has to track the icon set.
 */
export default new Proxy(
  {},
  { get: (_t, prop: string) => makeIcon(prop) },
) as Record<string, ReturnType<typeof makeIcon>>;

export const ChevronDown = makeIcon("ChevronDown");
export const CheckCircle2 = makeIcon("CheckCircle2");
export const XCircle = makeIcon("XCircle");
export const UserCheck = makeIcon("UserCheck");
export const WifiOff = makeIcon("WifiOff");
export const AlertTriangle = makeIcon("AlertTriangle");
export const Users = makeIcon("Users");
export const Zap = makeIcon("Zap");

import { createElement } from "react";

/**
 * `lucide-react-native` for the scanner's screen tests.
 *
 * `@th/ui-native`'s stub exports only the eight icons that package uses, and
 * an ESM named import of anything else resolves to `undefined` (React then
 * throws "Element type is invalid"). The scanner's screen tree imports ~45,
 * so they are listed here. Adding an icon to the screen means adding a line;
 * the failure is loud and names the missing export.
 *
 * Each icon renders an `<i data-icon="Name">` so a test can assert a glyph.
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
      "aria-hidden": true,
    });
  Icon.displayName = `${name}Stub`;
  return Icon;
};

export type LucideIcon = ReturnType<typeof makeIcon>;

export const AlertTriangle = makeIcon("AlertTriangle");
export const ArrowLeft = makeIcon("ArrowLeft");
export const Ban = makeIcon("Ban");
export const Calendar = makeIcon("Calendar");
export const CalendarX2 = makeIcon("CalendarX2");
export const CheckCheck = makeIcon("CheckCheck");
export const CheckCircle2 = makeIcon("CheckCircle2");
export const ChevronDown = makeIcon("ChevronDown");
export const ChevronUp = makeIcon("ChevronUp");
export const CircleDollarSign = makeIcon("CircleDollarSign");
export const Clock = makeIcon("Clock");
export const CloudOff = makeIcon("CloudOff");
export const DollarSign = makeIcon("DollarSign");
export const DoorOpen = makeIcon("DoorOpen");
export const Fingerprint = makeIcon("Fingerprint");
export const Flashlight = makeIcon("Flashlight");
export const FlashlightOff = makeIcon("FlashlightOff");
export const HelpCircle = makeIcon("HelpCircle");
export const Home = makeIcon("Home");
export const Info = makeIcon("Info");
export const Keyboard = makeIcon("Keyboard");
export const LogOut = makeIcon("LogOut");
export const MapPin = makeIcon("MapPin");
export const Moon = makeIcon("Moon");
export const RefreshCw = makeIcon("RefreshCw");
export const ScanLine = makeIcon("ScanLine");
export const Search = makeIcon("Search");
export const SearchX = makeIcon("SearchX");
export const Server = makeIcon("Server");
export const ServerOff = makeIcon("ServerOff");
export const Settings = makeIcon("Settings");
export const ShieldAlert = makeIcon("ShieldAlert");
export const ShieldQuestion = makeIcon("ShieldQuestion");
export const Sun = makeIcon("Sun");
export const Tag = makeIcon("Tag");
export const Undo2 = makeIcon("Undo2");
export const UserCheck = makeIcon("UserCheck");
export const Users = makeIcon("Users");
export const Vibrate = makeIcon("Vibrate");
export const Volume2 = makeIcon("Volume2");
export const VolumeX = makeIcon("VolumeX");
export const WifiOff = makeIcon("WifiOff");
export const X = makeIcon("X");
export const XCircle = makeIcon("XCircle");
export const Zap = makeIcon("Zap");

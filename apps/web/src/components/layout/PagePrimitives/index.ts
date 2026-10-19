/**
 * Shared layout primitives for public-facing (non-Tamagui) pages.
 *
 * Swiss International Typographic Style: sharp rectangles, structural borders,
 * left-aligned typography, extreme scale contrast, no decorative rounding.
 *
 * These replace raw `<div style={...}>` with named, descriptive components.
 * Admin/platform pages use Tamagui `styled()` — these are for static pages
 * like About, Contact, Privacy, Terms, etc. that render plain HTML+CSS.
 */

export {
  PageContainer,
  type PageContainerProps,
  HeroSection,
  type HeroSectionProps,
  ContentSection,
  AsymmetricGrid,
  GutterLayout,
} from "./page-layout";

export {
  Pill,
  PageTitle,
  PageDescription,
  SectionLabel,
  SectionTitle,
  BodyText,
  MutedText,
  MonoText,
  CardTitle,
  CardBody,
  DisplayHeading,
  Overline,
  SectionNumber,
} from "./typography";

export {
  Card,
  type CardProps,
  SurfaceCard,
  NumberedSection,
  IconCircle,
  type IconCircleProps,
} from "./cards";

export {
  ButtonPrimary,
  ButtonOutline,
  ButtonRow,
  GhostButton,
  TextLink,
} from "./buttons";

export { FormField, inputStyle, SubmitButton } from "./forms";

export { StatusScreen, type StatusScreenProps } from "./feedback";
export { STATUS_ICON, STATUS_ICON_BG } from "./tokens";
export { LoadingScreen } from "./LoadingScreen";

export { LegalPage, LegalSection, LegalList } from "./legal";

export { Stripe, AutoGrid } from "./primitives";

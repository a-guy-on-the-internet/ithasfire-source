/**
 * Test-only stand-in for `@th/ui`, used by EmbedCalendarBrowse.test.tsx so the
 * shared calendar engine can render for real in jsdom without Tamagui.
 *
 * Deliberately local rather than reaching into the engine's own
 * `__tests__/ui.stub.tsx`: that file belongs to the engine's suite and may
 * change with it; the embed's contract should not break on someone else's
 * test fixture. Every stand-in spreads `pickDomProps` so aria / data / role
 * attributes cannot silently vanish and leave an assertion passing against
 * nothing.
 *
 * Kept as `.stub.tsx` so vitest's include glob does not collect it as a suite.
 */
import type { ReactNode } from "react";

import { ENGLISH_LISTING_PRICE_WORDS } from "@th/types/money";

import { pickDomProps } from "@/test-support/pick-dom-props";

type AnyProps = Record<string, unknown> & { children?: ReactNode };

const Text = ({ children, variant, tone, ...rest }: AnyProps) => (
  <span
    data-variant={variant as string}
    data-tone={tone as string}
    {...pickDomProps(rest)}
  >
    {children}
  </span>
);

const Button = ({ children, onPress, ...rest }: AnyProps) => (
  <button type="button" onClick={onPress as () => void} {...pickDomProps(rest)}>
    {children}
  </button>
);

const SegmentedControl = ({
  options,
  value,
  onChange,
  testIdBase,
  ariaLabel,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
  testIdBase?: string;
  ariaLabel?: string;
}) => (
  <div role="radiogroup" aria-label={ariaLabel}>
    {options.map((o) => (
      <button
        key={o.value}
        type="button"
        role="radio"
        aria-checked={o.value === value}
        data-testid={testIdBase ? `${testIdBase}-${o.value}` : undefined}
        onClick={() => onChange(o.value)}
      >
        {o.label}
      </button>
    ))}
  </div>
);

const MenuButton = ({
  label,
  items,
  testId,
  ...rest
}: AnyProps & {
  label: string;
  items: Array<{ label: string; onSelect: () => void }>;
  testId?: string;
}) => (
  <div>
    <button type="button" data-testid={testId} {...pickDomProps(rest)}>
      {label}
    </button>
    <div role="menu">
      {items.map((i) => (
        <button key={i.label} type="button" role="menuitem" onClick={i.onSelect}>
          {i.label}
        </button>
      ))}
    </div>
  </div>
);

const StyledSelect = ({
  options,
  value,
  onChange,
  testId,
  ariaLabel,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (v: string) => void;
  testId?: string;
  ariaLabel?: string;
}) => (
  <select
    data-testid={testId}
    aria-label={ariaLabel}
    value={value}
    onChange={(e) => onChange(e.target.value)}
  >
    {options.map((o) => (
      <option key={o.value} value={o.value}>
        {o.label}
      </option>
    ))}
  </select>
);

const Tooltip = ({ anchor }: { anchor?: ReactNode }) => <>{anchor}</>;

/** Surfaces its open state so a "no peek in public mode" assertion is real. */
const Popover = ({
  anchor,
  open,
  children,
}: {
  anchor?: ReactNode;
  open?: boolean;
  children?: ReactNode;
}) => (
  <>
    {anchor}
    {open ? <div data-testid="popover">{children}</div> : null}
  </>
);

const Passthrough = ({ children }: AnyProps) => <div>{children}</div>;
const BottomSheetRoot = ({
  open,
  children,
}: {
  open: boolean;
  children?: ReactNode;
}) => (open ? <div data-testid="bottom-sheet">{children}</div> : null);
const BottomSheet = Object.assign(BottomSheetRoot, {
  Panel: Passthrough,
  Body: Passthrough,
  Header: Passthrough,
  Footer: Passthrough,
});

const NextLinkAnchor = ({
  href,
  children,
  className,
  target,
  rel,
  ...rest
}: AnyProps) => (
  <a
    href={String(href)}
    className={className as string}
    target={target as string}
    rel={rel as string}
    {...pickDomProps(rest)}
  >
    {children}
  </a>
);

// Mirrors `monoScale` in packages/ui/src/ui/tamagui/tokens/typography.ts.
const monoScale = {
  lg: { fontSize: 13, letterSpacing: 0.4 },
  md: { fontSize: 11.5, letterSpacing: 1.4 },
  sm: { fontSize: 11, letterSpacing: 2 },
  xs: { fontSize: 10, letterSpacing: 2.5 },
  "2xs": { fontSize: 9.5, letterSpacing: 2.5 },
} as const;

// Mirrors the real hook's miss behaviour: the key comes back verbatim, which
// is how `resolveCalendarLabels` / `useCalendarText` know to use their English
// default. The embed's own strings therefore render in English here, which is
// exactly what an un-catalogued key does in the widget.
const useTranslations = () => (key: string) => key;

// The week row's price words: English, as an un-catalogued key renders.
const LISTING_PRICE_WORDS = {
  ...ENGLISH_LISTING_PRICE_WORDS,
  seeDetails: "See details",
};
const useListingPriceWords = () => LISTING_PRICE_WORDS;

export const uiStub = {
  Text,
  Button,
  SegmentedControl,
  MenuButton,
  StyledSelect,
  Tooltip,
  Popover,
  BottomSheet,
  NextLinkAnchor,
  monoScale,
  useTranslations,
  useListingPriceWords,
};

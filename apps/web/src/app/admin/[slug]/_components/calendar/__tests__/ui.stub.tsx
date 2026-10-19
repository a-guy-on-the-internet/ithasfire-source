/**
 * Test-only stand-ins for `@th/ui` and `lucide-react` used by the calendar
 * engine tests. Each stand-in spreads `pickDomProps` so aria / data / role
 * attributes cannot silently vanish. Kept as a `.stub.tsx` so vitest's
 * include glob does not collect it as a suite.
 */
import type { ReactNode } from "react";

import { pickDomProps } from "@/test-support/pick-dom-props";

type AnyProps = Record<string, unknown> & { children?: ReactNode };

const Text = ({ children, variant, tone, color, ...rest }: AnyProps) => (
  <span
    data-variant={variant as string}
    data-tone={tone as string}
    data-color={color as string}
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
}: AnyProps & { label: string; items: Array<{ label: string; onSelect: () => void }>; testId?: string }) => (
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

/**
 * `anchorElement` is the real Popover's "position against this already-mounted
 * node" prop. The stub cannot position anything, so it surfaces WHICH node it
 * was handed: the render key as an attribute, and the node itself on the
 * rendered element, so a test can assert the peek anchors to the chip that was
 * pressed rather than to a clone, a proxy, or nothing.
 */
const Popover = ({
  anchor,
  anchorElement,
  open,
  children,
}: {
  anchor?: ReactNode;
  anchorElement?: Element | null;
  open?: boolean;
  children?: ReactNode;
}) => (
  <>
    {anchor}
    {open ? (
      <div
        data-testid="popover"
        data-anchor-render-key={
          (anchorElement as HTMLElement | null)?.getAttribute?.("data-render-key") ?? "none"
        }
        ref={(node) => {
          if (node) (node as unknown as { anchorElement?: Element | null }).anchorElement = anchorElement ?? null;
        }}
      >
        {children}
      </div>
    ) : null}
  </>
);

const Passthrough = ({ children }: AnyProps) => <div>{children}</div>;
const BottomSheetRoot = ({ open, children }: { open: boolean; children?: ReactNode }) =>
  open ? <div data-testid="bottom-sheet">{children}</div> : null;
const BottomSheet = Object.assign(BottomSheetRoot, {
  Panel: Passthrough,
  Body: Passthrough,
  Header: Passthrough,
  Footer: Passthrough,
});

const NextLinkAnchor = ({ href, children, className, target, rel, ...rest }: AnyProps) => (
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
// is how `resolveCalendarLabels` knows to use its English default.
const useTranslations = () => (key: string) => key;
const useLocale = () => "en";

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
  useLocale,
};

const Icon = (props: Record<string, unknown>) => (
  <span
    data-icon="true"
    role={props.role as string | undefined}
    aria-label={props["aria-label"] as string | undefined}
    aria-hidden={props["aria-hidden"] as boolean | undefined}
  />
);

export const lucideStub = {
  AlertTriangle: Icon,
  Globe: Icon,
  Repeat: Icon,
  ChevronLeft: Icon,
  ChevronRight: Icon,
  ChevronDown: Icon,
  MoreHorizontal: Icon,
  Plus: Icon,
  Copy: Icon,
  Download: Icon,
  ExternalLink: Icon,
  Pencil: Icon,
  X: Icon,
};

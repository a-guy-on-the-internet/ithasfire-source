"use client";

import {
  autoUpdate,
  flip,
  FloatingFocusManager,
  FloatingPortal,
  offset,
  shift,
  size,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
  useTransitionStyles,
  type Placement,
} from "@floating-ui/react";
import Link from "next/link";
import {
  CalendarCheck,
  Inbox,
  Mic,
  PlusCircle,
  Shield,
  Ticket,
} from "lucide-react";
import {
  useMemo,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from "react";
import { XStack, YStack } from "tamagui";
import { Button, Text, useLocale, useTranslations } from "@th/ui";
import { formatDateTimeAs } from "@th/types";

import { initialsFrom } from "./avatar-initials";

/** The menu shows at most this many organisations, then "All organisations". */
export const MAX_MENU_ORGANIZATIONS = 3;

type NavItem = {
  href: string;
};

export type AccountMenuIdentity = {
  name: string;
  /** Username without the leading `@`. The handle line is omitted when null. */
  handle: string | null;
  avatarUrl: string | null;
};

export type AccountMenuOrgRole =
  | "OWNER"
  | "ADMIN"
  | "EDITOR"
  | "FINANCE"
  | "VIEWER"
  | "SCANNER";

export type AccountMenuOrganization = {
  slug: string;
  name: string;
  role: AccountMenuOrgRole;
  avatarUrl: string | null;
  href: string;
};

/**
 * The person's next night out, shown under the identity header. Every field
 * arrives display-ready: the caller has already privacy-projected the place
 * and picked where the button goes.
 */
export type AccountMenuNextNight = {
  kind: "ticket" | "rsvp" | "lineup";
  title: string;
  /** ISO string or Date. */
  startsAt: Date | string;
  /**
   * IANA zone of the venue. Required: an event happens where it happens, and
   * there is no viewer-local mode (see packages/types/src/datetime.ts).
   */
  timezone: string;
  /** Rendered as given; the line is omitted when absent. */
  placeLabel?: string | null;
  /** Shown only for kind "ticket". */
  ticketCount?: number | null;
  /**
   * Built by the caller and must match the label, which follows `kind`:
   * kind "ticket" → `/my-tickets/<orderId>` (or the `/my-tickets` list when
   * no order is the viewer's own); "rsvp" and "lineup" → the event page.
   */
  href: string;
};

export type AccountManagementPopoverProps = {
  trigger: ReactElement;
  /** Header: who is signed in. Omitted while the owner entities load. */
  identity?: AccountMenuIdentity;
  /**
   * The next-night block under the header. When null or absent nothing
   * renders: no empty state, no divider.
   */
  nextNight?: AccountMenuNextNight | null;
  // ── Going ──
  myTickets?: NavItem;
  myRsvps?: NavItem;
  // ── Playing ──
  /**
   * `/my-lineups`. Pass it ONLY when the person has performer mode on —
   * the Playing section renders when, and only when, this is set.
   */
  myLineups?: NavItem;
  // ── Organizing ──
  /** The person's own admin workspace ("Your hub"). */
  hub: NavItem;
  /**
   * Every organisation the person belongs to, in display order. The menu
   * shows the first {@link MAX_MENU_ORGANIZATIONS}; past that it adds an
   * "All organisations" row linking to `allOrganizations`.
   */
  organizations?: AccountMenuOrganization[];
  allOrganizations?: NavItem;
  /** "New event". The button renders only when this is set. */
  onCreateEvent?: () => void;
  // ── Platform / footer ──
  platform?: NavItem;
  manageAccount?: NavItem;
  onSignOutAction: () => void;
  testIdBase?: string;
  placement?: Placement;
  defaultOpen?: boolean;
};

const ORG_ROLE_LABEL_KEYS: Record<AccountMenuOrgRole, string> = {
  OWNER: "admin.roleOwner",
  ADMIN: "admin.roleAdmin",
  EDITOR: "admin.roleEditor",
  FINANCE: "admin.roleFinance",
  VIEWER: "admin.roleViewer",
  SCANNER: "admin.roleScanner",
};

const ROW_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 12px",
  borderRadius: 0,
  textDecoration: "none",
  color: "inherit",
  transition: "background-color 0.15s, border-color 0.15s",
  cursor: "pointer",
  borderLeft: "3px solid transparent",
  minWidth: 0,
  minHeight: 44,
};

// Footer cells: equal halves of one row, 44px floor for touch.
const FOOTER_CELL_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  minHeight: 44,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0 8px",
  border: 0,
  borderRadius: 0,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  textDecoration: "none",
  cursor: "pointer",
  transition: "background-color 0.15s",
};

const FOOTER_LABEL_STYLE: CSSProperties = {
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontSize: 12,
};

// Today's row hover: muted fill + 3px accent rail on the left.
const rowHoverOn = (ev: MouseEvent<HTMLElement>) => {
  ev.currentTarget.style.backgroundColor = "var(--surfaceMuted, #EFE7D6)";
  ev.currentTarget.style.borderLeftColor = "var(--accent, #E2481D)";
};
const rowHoverOff = (ev: MouseEvent<HTMLElement>) => {
  ev.currentTarget.style.backgroundColor = "transparent";
  ev.currentTarget.style.borderLeftColor = "transparent";
};
// Footer cells take the fill only: a rail on "Sign out" would fuse with
// the vertical rule beside it.
const cellHoverOn = (ev: MouseEvent<HTMLElement>) => {
  ev.currentTarget.style.backgroundColor = "var(--surfaceMuted, #EFE7D6)";
};
const cellHoverOff = (ev: MouseEvent<HTMLElement>) => {
  ev.currentTarget.style.backgroundColor = "transparent";
};

// The next-night button: an ink slab, label on the paper colour. Fill and
// foreground are both themed so they move as a unit. Focus uses the global
// `:focus-visible` ring; the block's 12px padding leaves it room to paint.
const NEXT_NIGHT_BUTTON_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 44,
  padding: "0 12px",
  borderRadius: 0,
  backgroundColor: "var(--color, #211C16)",
  color: "var(--surface, #FDFAF3)",
  textDecoration: "none",
  cursor: "pointer",
  transition: "background-color 0.15s, color 0.15s",
};

const NEXT_NIGHT_BUTTON_LABEL_STYLE: CSSProperties = {
  fontSize: 13,
  lineHeight: "16px",
  fontWeight: 700,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// Hover inverts to the accent fill rung that carries a white label. The
// 5.92:1 contrast is the Stub pair (#B93312 / #FFFFFF); other themes differ.
const nextNightHoverOn = (ev: MouseEvent<HTMLElement>) => {
  ev.currentTarget.style.backgroundColor = "var(--brandSecondaryHover, #B93312)";
  ev.currentTarget.style.color = "var(--onBrandSecondary, #FFFFFF)";
};
const nextNightHoverOff = (ev: MouseEvent<HTMLElement>) => {
  ev.currentTarget.style.backgroundColor = "var(--color, #211C16)";
  ev.currentTarget.style.color = "var(--surface, #FDFAF3)";
};

const NEXT_NIGHT_KICKER_KEYS: Record<AccountMenuNextNight["kind"], string> = {
  ticket: "auth.ampNextKickerTicket",
  lineup: "auth.ampNextKickerLineup",
  rsvp: "auth.ampNextKickerRsvp",
};

/**
 * Venue-local "Fri, Oct 10 · 8:00 PM" through the shared formatter. If Intl
 * rejects the venue zone, the time is still shown, in the viewer's zone and
 * WITH the zone label (e.g. "9:00 PM EDT" for a New York viewer), so the reader can tell which clock it
 * is. It is never shown as an unlabelled viewer-local time.
 */
const formatNextNightWhen = (
  startsAt: Date | string,
  timezone: string,
  locale: string,
): string => {
  try {
    return formatDateTimeAs(startsAt, "meta", { timeZone: timezone, locale });
  } catch {
    return formatDateTimeAs(startsAt, "meta", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale,
      showTimeZone: true,
    });
  }
};

const NextNightBlock = ({
  nextNight,
  testId,
  linkTestId,
  onNavigate,
}: {
  nextNight: AccountMenuNextNight;
  testId: string;
  linkTestId: string;
  onNavigate: () => void;
}) => {
  const t = useTranslations();
  const locale = useLocale();
  const kicker = String(t(NEXT_NIGHT_KICKER_KEYS[nextNight.kind]));
  const isTicket = nextNight.kind === "ticket";
  const when = formatNextNightWhen(
    nextNight.startsAt,
    nextNight.timezone,
    locale ?? "en-US",
  );
  const count =
    isTicket && nextNight.ticketCount && nextNight.ticketCount >= 1
      ? String(t("auth.ampNextTicketCount", { count: nextNight.ticketCount }))
      : null;
  const buttonLabel = String(
    t(isTicket ? "auth.ampNextShowTickets" : "auth.ampNextOpenEvent"),
  );
  const buttonAria = String(
    t(isTicket ? "auth.ampNextShowTicketsAria" : "auth.ampNextOpenEventAria", {
      title: nextNight.title,
    }),
  );

  return (
    <YStack
      role="group"
      aria-label={kicker}
      padding="$3"
      gap={6}
      borderBottomWidth={2}
      borderBottomColor="$borderColor"
      data-testid={testId}
    >
      <Text variant="overline" color="$accentText">
        {kicker}
      </Text>
      <Text
        variant="body"
        weight="bold"
        fontSize={16}
        lineHeight={20}
        style={{
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          overflow: "hidden",
          overflowWrap: "anywhere",
        }}
      >
        {nextNight.title}
      </Text>
      {(when || count) && (
        <Text variant="overline" letterSpacing={1}>
          {when}
          {when && count ? " " : null}
          {count && (
            // The count travels as one unit with its separator: a narrow
            // panel breaks between the date and the count, never after a
            // lone "·".
            <span style={{ whiteSpace: "nowrap" }}>
              {when ? `· ${count}` : count}
            </span>
          )}
        </Text>
      )}
      {nextNight.placeLabel && (
        <Text
          variant="bodySmall"
          tone="muted"
          fontSize={13}
          lineHeight={18}
          truncate
        >
          {nextNight.placeLabel}
        </Text>
      )}
      <Link
        href={nextNight.href}
        aria-label={buttonAria}
        data-testid={linkTestId}
        style={NEXT_NIGHT_BUTTON_STYLE}
        onClick={onNavigate}
        onMouseEnter={nextNightHoverOn}
        onMouseLeave={nextNightHoverOff}
      >
        <span style={NEXT_NIGHT_BUTTON_LABEL_STYLE}>{buttonLabel}</span>
      </Link>
    </YStack>
  );
};

/** Plain section label in the mono label idiom: no band, no rule. */
const SectionLabel = ({ children }: { children: string }) => (
  <XStack paddingHorizontal="$3" paddingTop="$2" paddingBottom="$1">
    <Text variant="overline" tone="muted">
      {children}
    </Text>
  </XStack>
);

/** 1px low-alpha divider between sections, inset 12px each side. */
const Hairline = () => (
  <YStack
    aria-hidden
    height={1}
    marginHorizontal="$3"
    marginVertical="$1"
    backgroundColor="$borderColorSoft"
  />
);

/**
 * Avatar that falls back to initials when the image fails to load, so a dead
 * URL never shows the browser's broken-image glyph.
 */
const FallbackAvatarImage = ({
  src,
  name,
  px,
  round,
  renderInitials,
}: {
  src: string;
  name: string;
  px: number;
  round: boolean;
  renderInitials: (initials: string) => ReactNode;
}) => {
  const [failed, setFailed] = useState(false);
  if (failed) return <>{renderInitials(initialsFrom(name))}</>;
  return (
    // Decorative: the name sits right beside it.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      width={px}
      height={px}
      onError={() => setFailed(true)}
      style={{
        objectFit: "cover",
        width: px,
        height: px,
        ...(round ? { borderRadius: "50%" } : null),
      }}
    />
  );
};

export const AccountManagementPopover = ({
  trigger,
  identity,
  nextNight,
  myTickets = { href: "/my-tickets" },
  myRsvps = { href: "/my-rsvps" },
  myLineups,
  hub,
  organizations = [],
  allOrganizations = { href: "/admin" },
  onCreateEvent,
  platform,
  manageAccount = { href: "/account/settings" },
  onSignOutAction,
  testIdBase = "account-popover",
  placement = "bottom-end",
  defaultOpen = false,
}: AccountManagementPopoverProps) => {
  const t = useTranslations();
  const [open, setOpen] = useState(defaultOpen);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  const { context, refs, floatingStyles } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(8),
      flip(),
      shift({ padding: 8 }),
      // Cap the panel to the room left in the viewport (floored at 120 so it
      // never collapses to a strip). The body scrolls inside this cap while
      // the footer stays pinned and visible.
      size({
        padding: 8,
        apply({ availableHeight }) {
          const next = Math.max(120, Math.floor(availableHeight));
          setMaxHeight((prev) => (prev === next ? prev : next));
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
    // Disable transform-based positioning so floatingStyles uses top/left
    // instead of CSS transform. This prevents conflicts with the
    // useTransitionStyles animation transform (translateY).
    transform: false,
  });

  const click = useClick(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    click,
    dismiss,
    role,
  ]);

  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: 150,
    initial: { opacity: 0, transform: "translateY(-4px)" },
    open: { opacity: 1, transform: "translateY(0)" },
    close: { opacity: 0, transform: "translateY(-4px)" },
  });

  const testIds = useMemo(
    () => ({
      panel: `${testIdBase}-panel`,
      identity: `${testIdBase}-identity`,
      nextNight: `${testIdBase}-next-night`,
      nextNightOpen: `${testIdBase}-next-night-open`,
      tickets: `${testIdBase}-tickets`,
      rsvps: `${testIdBase}-rsvps`,
      lineups: `${testIdBase}-lineups`,
      dashboard: `${testIdBase}-dashboard`,
      org: (slug: string) => `${testIdBase}-org-${slug}`,
      allOrgs: `${testIdBase}-all-orgs`,
      createEvent: `${testIdBase}-create-event`,
      platform: `${testIdBase}-platform`,
      manage: `${testIdBase}-manage`,
      signout: `${testIdBase}-signout`,
    }),
    [testIdBase],
  );

  const shownOrganizations = organizations.slice(0, MAX_MENU_ORGANIZATIONS);
  const hasMoreOrganizations = organizations.length > MAX_MENU_ORGANIZATIONS;

  const close = () => setOpen(false);

  const renderRow = (
    item: NavItem,
    testId: string,
    icon: ReactNode,
    label: string,
  ) => (
    <Link
      href={item.href}
      data-testid={testId}
      style={ROW_STYLE}
      onClick={close}
      onMouseEnter={rowHoverOn}
      onMouseLeave={rowHoverOff}
    >
      {icon}
      <Text variant="body" weight="medium" truncate>
        {label}
      </Text>
    </Link>
  );

  return (
    <>
      {/*
        Wrapper <div> captures native DOM click/pointerdown events so
        Floating UI useClick + useDismiss work reliably. Tamagui Button
        swallows native events, but they still bubble from the wrapper.
        display:inline-flex keeps the trigger layout unchanged.
      */}
      <div
        ref={refs.setReference}
        {...getReferenceProps()}
        style={{ display: "inline-flex" }}
      >
        {trigger}
      </div>

      {isMounted && (
        <FloatingPortal>
          <FloatingFocusManager
            context={context}
            modal={false}
            // The panel itself takes initial focus, so no row paints a focus
            // ring on open. Tab then lands on the first row.
            initialFocus={refs.floating}
          >
            {/*
              Outer <div> owns Floating UI positioning (position:absolute,
              top/left). Tamagui YStack inside handles visual styling only.
              Mixing floatingStyles into a Tamagui component can cause
              Tamagui to override position/top/left with its own layout.
            */}
            <div
              ref={refs.setFloating}
              {...getFloatingProps()}
              aria-label={String(t("auth.ampMenuLabel"))}
              tabIndex={-1}
              style={{
                ...floatingStyles,
                ...transitionStyles,
                zIndex: 1000,
                outline: "none",
              }}
            >
              <YStack
                padding={0}
                // 280 + shift padding 8 × 2 = 296, inside a 320 viewport.
                width={280}
                borderWidth={2}
                borderColor="$borderColor"
                borderRadius={0}
                backgroundColor="$surface"
                // Positioning stays on the outer div. The panel owns the
                // border and the size cap; only the body scrolls, so the
                // footer below it is always visible.
                maxHeight={maxHeight}
                data-testid={testIds.panel}
              >
                <YStack
                  flex={1}
                  minHeight={0}
                  // RN styles have no overflowY, so Tamagui doesn't type it as
                  // a prop; on web the style escape hatch carries it (same as
                  // NavigationDrawer).
                  style={{ overflowY: "auto", overflowX: "hidden" }}
                >
                  {/* ── Identity ── */}
                  {identity && (
                    <XStack
                      alignItems="center"
                      gap="$3"
                      padding="$3"
                      borderBottomWidth={2}
                      borderBottomColor="$borderColor"
                      data-testid={testIds.identity}
                    >
                      <XStack
                        width={32}
                        height={32}
                        flexShrink={0}
                        borderRadius={999}
                        backgroundColor="$accentSoft"
                        borderWidth={1.5}
                        borderColor="$borderColorSoft"
                        alignItems="center"
                        justifyContent="center"
                        overflow="hidden"
                      >
                        {identity.avatarUrl ? (
                          <FallbackAvatarImage
                            key={identity.avatarUrl}
                            src={identity.avatarUrl}
                            name={identity.name}
                            px={32}
                            round
                            renderInitials={(initials) => (
                              <Text variant="bodySmall" weight="bold" aria-hidden>
                                {initials}
                              </Text>
                            )}
                          />
                        ) : (
                          <Text variant="bodySmall" weight="bold" aria-hidden>
                            {initialsFrom(identity.name)}
                          </Text>
                        )}
                      </XStack>
                      <YStack flex={1} minWidth={0}>
                        <Text variant="body" weight="bold" truncate>
                          {identity.name}
                        </Text>
                        {identity.handle && (
                          // Handles keep their case: uppercasing one would
                          // show a username that isn't quite the person's.
                          <Text
                            variant="overline"
                            tone="muted"
                            textTransform="none"
                            truncate
                          >
                            {`@${identity.handle}`}
                          </Text>
                        )}
                      </YStack>
                    </XStack>
                  )}

                  {/* ── Next night (only when there is one) ── */}
                  {nextNight && (
                    <NextNightBlock
                      nextNight={nextNight}
                      testId={testIds.nextNight}
                      linkTestId={testIds.nextNightOpen}
                      onNavigate={close}
                    />
                  )}

                  {/* ── Going ── */}
                  <SectionLabel>
                    {String(t("auth.ampSectionGoing"))}
                  </SectionLabel>
                  <YStack paddingBottom="$1">
                    {renderRow(
                      myTickets,
                      testIds.tickets,
                      <Ticket size={16} aria-hidden />,
                      String(t("account.myTickets")),
                    )}
                    {renderRow(
                      myRsvps,
                      testIds.rsvps,
                      <CalendarCheck size={16} aria-hidden />,
                      String(t("rsvp.navMyRsvps")),
                    )}
                  </YStack>

                  {/* ── Playing (performer mode on) ── */}
                  {myLineups && (
                    <>
                      <Hairline />
                      <SectionLabel>
                        {String(t("auth.ampSectionPlaying"))}
                      </SectionLabel>
                      <YStack paddingBottom="$1">
                        {renderRow(
                          myLineups,
                          testIds.lineups,
                          <Mic size={16} aria-hidden />,
                          String(t("myLineups.navLabel")),
                        )}
                      </YStack>
                    </>
                  )}

                  {/* ── Organizing ── */}
                  <Hairline />
                  <SectionLabel>
                    {String(t("auth.ampSectionOrganizing"))}
                  </SectionLabel>
                  <YStack paddingBottom="$1">
                    {renderRow(
                      hub,
                      testIds.dashboard,
                      <Inbox size={16} aria-hidden />,
                      String(t("auth.ampYourHub")),
                    )}
                    {shownOrganizations.map((org) => (
                      <Link
                        key={org.slug}
                        href={org.href}
                        aria-label={
                          ORG_ROLE_LABEL_KEYS[org.role]
                            ? `${org.name}, ${String(t(ORG_ROLE_LABEL_KEYS[org.role]))}`
                            : org.name
                        }
                        data-testid={testIds.org(org.slug)}
                        style={ROW_STYLE}
                        onClick={close}
                        onMouseEnter={rowHoverOn}
                        onMouseLeave={rowHoverOff}
                      >
                        <XStack
                          width={20}
                          height={20}
                          flexShrink={0}
                          borderRadius={0}
                          backgroundColor="$color"
                          alignItems="center"
                          justifyContent="center"
                          overflow="hidden"
                        >
                          {org.avatarUrl ? (
                            <FallbackAvatarImage
                              key={org.avatarUrl}
                              src={org.avatarUrl}
                              name={org.name}
                              px={20}
                              round={false}
                              renderInitials={(initials) => (
                                <Text
                                  variant="overline"
                                  letterSpacing={0}
                                  fontSize={9}
                                  lineHeight={12}
                                  weight="bold"
                                  color="$surface"
                                  aria-hidden
                                >
                                  {initials}
                                </Text>
                              )}
                            />
                          ) : (
                            <Text
                              variant="overline"
                              letterSpacing={0}
                              fontSize={9}
                              lineHeight={12}
                              weight="bold"
                              color="$surface"
                              aria-hidden
                            >
                              {initialsFrom(org.name)}
                            </Text>
                          )}
                        </XStack>
                        <YStack flex={1} minWidth={0}>
                          <Text variant="body" weight="medium" truncate>
                            {org.name}
                          </Text>
                          {ORG_ROLE_LABEL_KEYS[org.role] && (
                            <Text variant="overline" tone="muted" truncate>
                              {String(t(ORG_ROLE_LABEL_KEYS[org.role]))}
                            </Text>
                          )}
                        </YStack>
                      </Link>
                    ))}
                    {hasMoreOrganizations && (
                      <Link
                        href={allOrganizations.href}
                        data-testid={testIds.allOrgs}
                        style={ROW_STYLE}
                        onClick={close}
                        onMouseEnter={rowHoverOn}
                        onMouseLeave={rowHoverOff}
                      >
                        {/* Spacer keeps the label on the org-name column. */}
                        <span
                          aria-hidden
                          style={{ width: 20, height: 20, flexShrink: 0 }}
                        />
                        <Text variant="body" weight="medium" tone="muted" truncate>
                          {String(t("auth.ampAllOrganizations"))}
                        </Text>
                      </Link>
                    )}
                  </YStack>
                  {onCreateEvent && (
                    <YStack paddingHorizontal="$3" paddingTop="$1" paddingBottom="$3">
                      <Button
                        variant="secondary"
                        size="$4"
                        width="100%"
                        borderRadius={0}
                        data-testid={testIds.createEvent}
                        onPress={() => {
                          close();
                          onCreateEvent();
                        }}
                      >
                        <PlusCircle size={16} aria-hidden />
                        {String(t("auth.ampNewEvent"))}
                      </Button>
                    </YStack>
                  )}

                  {/* ── Platform (staff) ── */}
                  {platform && (
                    <>
                      <Hairline />
                      <YStack paddingBottom="$1">
                        {renderRow(
                          platform,
                          testIds.platform,
                          <Shield size={16} aria-hidden />,
                          String(t("auth.ampPlatform")),
                        )}
                      </YStack>
                    </>
                  )}

                </YStack>

                {/* ── Footer: Settings | Sign out (never scrolls) ── */}
                <XStack
                  flexShrink={0}
                  borderTopWidth={2}
                  borderTopColor="$borderColor"
                  alignItems="stretch"
                >
                  <Link
                    href={manageAccount.href}
                    data-testid={testIds.manage}
                    style={FOOTER_CELL_STYLE}
                    onClick={close}
                    onMouseEnter={cellHoverOn}
                    onMouseLeave={cellHoverOff}
                  >
                    <Text
                      variant="body"
                      weight="bold"
                      truncate
                      style={FOOTER_LABEL_STYLE}
                    >
                      {String(t("auth.ampSettings"))}
                    </Text>
                  </Link>
                  <YStack
                    aria-hidden
                    width={2}
                    flexShrink={0}
                    backgroundColor="$borderColor"
                  />
                  <button
                    type="button"
                    data-testid={testIds.signout}
                    style={FOOTER_CELL_STYLE}
                    onClick={() => {
                      close();
                      onSignOutAction();
                    }}
                    onMouseEnter={cellHoverOn}
                    onMouseLeave={cellHoverOff}
                  >
                    <Text
                      variant="body"
                      weight="bold"
                      tone="muted"
                      truncate
                      style={FOOTER_LABEL_STYLE}
                    >
                      {String(t("account.signOut"))}
                    </Text>
                  </button>
                </XStack>
              </YStack>
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
};

AccountManagementPopover.displayName = "AccountManagementPopover";

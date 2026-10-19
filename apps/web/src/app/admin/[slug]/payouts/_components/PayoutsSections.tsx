"use client";

import { forwardRef, type MouseEvent, type ReactNode } from "react";
import { XStack, YStack, type TamaguiElement } from "tamagui";
import { Button, Text, useTranslations } from "@th/ui";
import { ChevronDown } from "lucide-react";

import { SectionJumpChips } from "@/components/navigation/SectionJumpChips";
import {
  useAdminPageSectionsActions,
  useInPageSections,
} from "../../_components/admin-page-sections";
import {
  PAYOUTS_ROUTE_ID,
  PAYOUTS_SECTION_IDS,
  type PayoutsSectionId,
} from "../_lib/payouts-sections";

/** Section heading label keys — also the rail children's labels. */
export const PAYOUTS_SECTION_LABEL_KEYS: Record<PayoutsSectionId, string> = {
  balance: "admin.payoutsSectionBalance",
  ledger: "admin.payoutsLedgerHeading",
  schedule: "admin.payoutsSectionSchedule",
  stripe: "admin.payoutsSectionStripe",
};

/** Phone chips are shorter: Balance / Ledger / Schedule / Stripe. */
const PAYOUTS_CHIP_LABEL_KEYS: Record<PayoutsSectionId, string> = {
  balance: "admin.payoutsSectionBalance",
  ledger: "admin.payoutsLedgerHeading",
  schedule: "admin.payoutsChipSchedule",
  stripe: "admin.payoutsChipStripe",
};

/**
 * One of the page's four sections. The heading carries the section id (the
 * rail child's / chip's fragment) and `tabIndex={-1}` so a jump can move
 * keyboard focus to it without adding a tab stop.
 */
export function PayoutsSection({
  id,
  aside,
  children,
}: {
  id: PayoutsSectionId;
  /** Right of the heading: the Stripe section's Connected badge, the Ledger's Download CSV. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations();
  const heading = (
    <Text
      variant="h4"
      tag="h2"
      weight="bold"
      id={id}
      tabIndex={-1}
      className="th-payouts-section-heading"
      flexShrink={1}
      minWidth={0}
    >
      {String(t(PAYOUTS_SECTION_LABEL_KEYS[id]))}
    </Text>
  );
  return (
    <YStack
      tag="section"
      gap="$4"
      paddingTop="$4"
      borderTopWidth={2}
      borderTopColor="$borderColor"
      aria-labelledby={id}
      data-testid={`payouts-section-${id}`}
    >
      {aside ? (
        // Wrap + shrink: Tamagui's web Stack defaults to `flex-shrink: 0`,
        // so at 320px a long heading and the badge must be allowed to break
        // onto two lines instead of pushing the badge past the edge.
        <XStack
          justifyContent="space-between"
          alignItems="center"
          flexWrap="wrap"
          gap="$2"
        >
          {heading}
          {aside}
        </XStack>
      ) : (
        heading
      )}
      {children}
    </YStack>
  );
}

/**
 * Wires the four sections to the rail (jump handler + scroll-spy, via the
 * admin page-sections provider) and renders the phone chip row, which hides
 * itself from 960px up where the rail is the index. Its own component so the
 * scroll-spy re-renders only the chips, never the whole page.
 */
export function PayoutsSectionIndex({
  ready,
  landingReady,
  onJump,
}: {
  ready: boolean;
  /** Hold the landing jump to the URL hash until late content has settled. */
  landingReady?: boolean;
  /** After a jump lands (rail, chip, URL hash): open what it was for. */
  onJump?: (sectionId: string) => void;
}) {
  const t = useTranslations();
  const { activeSectionId, jumpTo } = useInPageSections({
    routeId: PAYOUTS_ROUTE_ID,
    sectionIds: PAYOUTS_SECTION_IDS,
    ready,
    landingReady,
    onJump,
  });
  return (
    <SectionJumpChips
      items={PAYOUTS_SECTION_IDS.map((id) => ({
        id,
        label: String(t(PAYOUTS_CHIP_LABEL_KEYS[id])),
      }))}
      activeId={activeSectionId}
      onSelect={jumpTo}
      label={String(t("admin.payoutsSectionIndexLabel"))}
      testId="payouts-section-chips"
    />
  );
}

/**
 * The actor's role cannot read this section (tRPC FORBIDDEN). A plain line,
 * not an error: nothing is broken and there is nothing to retry.
 * `money` = Balance and Ledger (canFinanceOrg: OWNER / ADMIN / FINANCE);
 * `account` = schedule and Stripe (ORG_EDIT_OR_FINANCE_ROLES).
 */
export function PayoutsRoleNotice({
  kind,
  testId,
}: {
  kind: "money" | "account";
  testId: string;
}) {
  const t = useTranslations();
  return (
    <Text variant="body" tone="muted" data-testid={testId}>
      {String(
        t(
          kind === "money"
            ? "admin.payoutsRoleNoticeMoney"
            : "admin.payoutsRoleNoticeAccount",
        ),
      )}
    </Text>
  );
}

/**
 * A same-page link to one of the four sections. It goes through the same
 * in-page jump as the rail, so focus, the fragment and the scroll-spy all
 * follow; with no jump handler (or a declined jump) it is a plain `#<id>`
 * link and the browser takes it.
 */
function SectionJumpLink({
  sectionId,
  testId,
  children,
}: {
  sectionId: PayoutsSectionId;
  testId: string;
  children: ReactNode;
}) {
  const sections = useAdminPageSectionsActions();
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (sections?.jumpToSection(PAYOUTS_ROUTE_ID, sectionId)) {
      event.preventDefault();
    }
  };
  return (
    <a
      href={`#${sectionId}`}
      onClick={handleClick}
      className="th-payouts-inline-link"
      data-testid={testId}
    >
      {children}
    </a>
  );
}

/**
 * Not connected, or connected but incomplete: the Stripe account section has
 * nothing of its own to act on, because the setup card or the incomplete
 * banner sits at the top of Balance. It names that section and links UP to
 * it, never a second copy of the Connect / Continue button.
 */
export function StripeSetupInBalancePointer() {
  const t = useTranslations();
  return (
    <YStack gap="$2" data-testid="stripe-account-setup-pointer">
      <Text variant="body" tone="muted">
        {String(t("admin.payoutsStripeSetupInBalance"))}
      </Text>
      <SectionJumpLink
        sectionId="balance"
        testId="stripe-account-setup-pointer-link"
      >
        {String(t("admin.payoutsGoToBalance"))}
      </SectionJumpLink>
    </YStack>
  );
}

/**
 * Board B (2026-10-14): the settings an organiser rarely changes, together at
 * the bottom of the page under one "Settings" heading. Each row is still its
 * own anchor (`#schedule`, `#stripe`): the rail children, the phone chips and
 * old links (`/payments#stripe`) land on the row, not on the band.
 */
export function PayoutsSettingsBand({ children }: { children: ReactNode }) {
  const t = useTranslations();
  return (
    <YStack
      tag="section"
      gap="$4"
      paddingTop="$4"
      borderTopWidth={2}
      borderTopColor="$borderColor"
      aria-labelledby="payouts-settings"
      data-testid="payouts-section-settings"
    >
      <Text variant="h4" tag="h2" weight="bold" id="payouts-settings">
        {String(t("admin.payoutsSettingsHeading"))}
      </Text>
      <YStack borderWidth={2} borderColor="$borderColor" borderRadius={0}>
        {children}
      </YStack>
    </YStack>
  );
}

/**
 * One row of the Settings band. The heading carries the section id (rail
 * child / chip fragment) and `tabIndex={-1}` like the page's h2s, so a jump
 * can move focus to it.
 */
export function PayoutsSettingsRow({
  id,
  aside,
  first = false,
  children,
}: {
  id: Extract<PayoutsSectionId, "schedule" | "stripe">;
  aside?: ReactNode;
  first?: boolean;
  children: ReactNode;
}) {
  const t = useTranslations();
  return (
    <YStack
      tag="section"
      gap="$3"
      padding="$4"
      borderTopWidth={first ? 0 : 2}
      borderTopColor="$borderColor"
      aria-labelledby={id}
      data-testid={`payouts-section-${id}`}
    >
      {/* Wrap + shrink: at 320px the label and the badge break onto two
          lines instead of pushing the badge past the edge. */}
      <XStack
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
        gap="$2"
      >
        <Text
          variant="overline"
          tone="muted"
          tag="h3"
          id={id}
          tabIndex={-1}
          className="th-payouts-section-heading"
          flexShrink={1}
          minWidth={0}
        >
          {String(t(PAYOUTS_SECTION_LABEL_KEYS[id]))}
        </Text>
        {aside}
      </XStack>
      {children}
    </YStack>
  );
}

/**
 * The button that opens a settings row's details (the disclosure pattern):
 * `aria-expanded` + `aria-controls` on a real button, so Enter/Space and the
 * screen-reader state come with it. 44px tall for touch. `accessibleName`
 * keeps two "Details"-like buttons on one page from sharing a name; it must
 * contain the visible label (WCAG 2.5.3).
 */
type DisclosureButtonProps = {
  open: boolean;
  onToggle: () => void;
  controlsId: string;
  label: string;
  accessibleName?: string;
  disabled?: boolean;
  testId: string;
};

// The ref lets a caller put focus back on the toggle when the control that
// held it unmounts (the schedule's Save, once a saved pick folds the picker).
export const DisclosureButton = forwardRef<
  TamaguiElement,
  DisclosureButtonProps
>(function DisclosureButton(
  {
    open,
    onToggle,
    controlsId,
    label,
    accessibleName,
    disabled = false,
    testId,
  },
  ref,
) {
  return (
    // Shrinks with its row: at 320px "CHANGE SCHEDULE" is wider than the
    // settings row, so the label wraps onto two lines (the height grows from
    // the 44px floor) instead of pushing the page 3px sideways. It wraps
    // only between words, and sits flush with the row's text (no ghost
    // padding) so a narrow row keeps its width for the label.
    <XStack maxWidth="100%" minWidth={0}>
      <Button
        ref={ref}
        variant="ghost"
        // $4 is the 44px rung: the touch-target floor.
        size="$4"
        height="auto"
        minHeight={44}
        paddingVertical="$2"
        paddingHorizontal={0}
        justifyContent="flex-start"
        flexShrink={1}
        minWidth={0}
        maxWidth="100%"
        // The label may shrink to its longest word and no further: Tamagui's
        // Text breaks words by default, which cut "SCHEDULE" in two at 320.
        textProps={{
          whiteSpace: "normal",
          textAlign: "left",
          flexShrink: 1,
          minWidth: "min-content",
          style: {
            overflowWrap: "normal",
            wordBreak: "normal",
            wordWrap: "normal",
          },
        }}
        onPress={onToggle}
        disabled={disabled}
        aria-expanded={open}
        aria-controls={controlsId}
        aria-label={accessibleName}
        data-testid={testId}
      >
        {label}
        {/* Turned by the open state, no transition: nothing here animates,
            so reduced motion has nothing to switch off. */}
        <ChevronDown
          size={14}
          aria-hidden
          style={{
            flexShrink: 0,
            transform: open ? "rotate(180deg)" : undefined,
          }}
        />
      </Button>
    </XStack>
  );
});

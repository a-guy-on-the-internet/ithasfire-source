// @ts-nocheck — tabIndex/role/hidden props on Tamagui View are valid on web but not in RN types
"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import { YStack, XStack, View, styled } from "tamagui";
import { ORG_EDIT_ROLES } from "@th/types";
import { Text, useTranslations } from "@th/ui";

import { useCurrentAdminOwner } from "@/hooks/useCurrentAdminOwner";
import { AsksList } from "@/components/volunteering/AsksList";

import { AdminPageHeader } from "../../_components/AdminPageHeader";

import { VolunteerHoursView } from "./VolunteerHoursView";

type Tab = "hours" | "asks";

// Tab affordance for this org-level surface. (The per-event equivalent this
// was modelled on is gone — those tabs became routes.)
const TabButton = styled(View, {
  name: "VolunteersHomeTabButton",
  tag: "button",
  cursor: "pointer",
  borderWidth: 0,
  borderBottomWidth: 2,
  borderStyle: "solid",
  borderColor: "transparent",
  backgroundColor: "transparent",
  paddingVertical: 10,
  paddingHorizontal: 16,
  minHeight: 44,
  variants: {
    active: {
      true: {
        borderColor: "$brandSecondary",
      },
      false: {
        borderColor: "transparent",
        hoverStyle: {
          borderColor: "$borderColor",
        },
      },
    },
  } as const,
});

/**
 * Org / personal volunteers home: the existing hours report plus the
 * generic "Asks" surface (generic-volunteering-asks). Org owners list
 * org-subject asks; a human owner slug lists their personal (HUMAN-subject)
 * asks — the spec's "(dashboard)/me/volunteers" maps onto the existing
 * human admin area rather than a new dashboard convention.
 *
 * A personal workspace shows Asks ONLY: the hours report reads
 * `volunteer.hours.orgSummary`, which needs an `orgId`, so there is no
 * personal Hours tab. With one surface left there is no tablist either — a
 * single-tab tablist is a control that selects nothing — so the Asks content
 * renders under an `AdminPageHeader` titled like the Asks panel. Org
 * behaviour is unchanged.
 */
export function VolunteersHome() {
  const t = useTranslations();
  const { slug } = useParams<{ slug: string }>();
  const { currentOwner, isLoading } = useCurrentAdminOwner(slug);
  const [selectedTab, setSelectedTab] = useState<Tab>("hours");

  // The nav offers this page to every org role because the hours report
  // (`volunteer.hours.orgSummary`) admits them all. Asks does not: the org
  // list is `asks.listByOrg`, ORG_EDIT_ROLES server-side, so VIEWER / FINANCE
  // / SCANNER are not offered a tab whose only read refuses them. A personal
  // workspace lists its own HUMAN-subject asks, which the owner always may.
  // Unknown owner (still loading) keeps the tab back rather than flashing
  // one in and out.
  const canSeeAsks = Boolean(
    currentOwner &&
    (currentOwner.kind === "human" ||
      ORG_EDIT_ROLES.includes(currentOwner.role)),
  );
  const tab: Tab = canSeeAsks ? selectedTab : "hours";

  const hoursTabId = "volunteers-home-tab-hours";
  const asksTabId = "volunteers-home-tab-asks";
  const hoursPanelId = "volunteers-home-panel-hours";
  const asksPanelId = "volunteers-home-panel-asks";

  const asksSubject = (() => {
    if (!currentOwner) return null;
    if (currentOwner.kind === "org") {
      return { kind: "org", orgId: currentOwner.orgId } as const;
    }
    return { kind: "human", humanId: currentOwner.humanId } as const;
  })();

  const asksContent = (
    <YStack
      gap="$4"
      flex={1}
      padding="$4"
      maxWidth={1440}
      marginHorizontal="auto"
      width="100%"
    >
      <YStack gap="$1">
        <Text variant="h3" weight="bold">
          {String(t("volunteering.asksTitle"))}
        </Text>
        <Text variant="body" tone="muted">
          {String(t("volunteering.asksSubtitle"))}
        </Text>
      </YStack>
      {isLoading ? (
        <Text tone="muted">{String(t("admin.loading"))}</Text>
      ) : asksSubject ? (
        <AsksList slug={slug} subject={asksSubject} />
      ) : (
        <Text>{String(t("admin.unableToDetermineOwnerAudiences"))}</Text>
      )}
    </YStack>
  );

  // Personal workspace: Asks is the whole page (see the doc comment).
  if (currentOwner?.kind === "human") {
    return (
      <YStack
        gap="$4"
        flex={1}
        padding="$4"
        maxWidth={1440}
        marginHorizontal="auto"
        width="100%"
      >
        <AdminPageHeader
          title={String(t("volunteering.asksTitle"))}
          subtitle={String(t("volunteering.asksSubtitle"))}
        />
        {asksSubject ? (
          <AsksList slug={slug} subject={asksSubject} />
        ) : (
          <Text>{String(t("admin.unableToDetermineOwnerAudiences"))}</Text>
        )}
      </YStack>
    );
  }

  return (
    <YStack gap="$3" flex={1}>
      <XStack
        role="tablist"
        aria-orientation="horizontal"
        borderBottomWidth={1}
        borderBottomColor="$borderColor"
        gap="$2"
        paddingHorizontal="$4"
        paddingTop="$2"
        maxWidth={1440}
        marginHorizontal="auto"
        width="100%"
        // Long labels (Spanish "Convocatorias") don't fit one line at 320;
        // wrapping keeps every tab visible rather than scrolling one off the edge.
        flexWrap="wrap"
      >
        <TabButton
          id={hoursTabId}
          active={tab === "hours"}
          onPress={() => setSelectedTab("hours")}
          aria-selected={tab === "hours"}
          aria-controls={hoursPanelId}
          role="tab"
          // Interim: both tabs stay in the Tab order until roving-tabindex +
          // arrow-key handling lands (a11y follow-up).
          tabIndex={0}
          data-testid="volunteers-home-tab-hours"
        >
          <Text
            variant="label"
            style={{
              fontWeight: tab === "hours" ? 700 : 500,
              letterSpacing: 0.5,
              textTransform: "uppercase",
            }}
          >
            {String(t("volunteering.tabHours"))}
          </Text>
        </TabButton>
        {canSeeAsks ? (
          <TabButton
            id={asksTabId}
            active={tab === "asks"}
            onPress={() => setSelectedTab("asks")}
            aria-selected={tab === "asks"}
            aria-controls={asksPanelId}
            role="tab"
            tabIndex={0}
            data-testid="volunteers-home-tab-asks"
          >
            <Text
              variant="label"
              style={{
                fontWeight: tab === "asks" ? 700 : 500,
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              {String(t("volunteering.tabAsks"))}
            </Text>
          </TabButton>
        ) : null}
      </XStack>

      <View
        id={hoursPanelId}
        role="tabpanel"
        aria-labelledby={hoursTabId}
        tabIndex={tab === "hours" ? 0 : -1}
        hidden={tab !== "hours"}
        display={tab === "hours" ? "flex" : "none"}
      >
        {tab === "hours" ? <VolunteerHoursView /> : null}
      </View>

      {canSeeAsks ? (
        <View
          id={asksPanelId}
          role="tabpanel"
          aria-labelledby={asksTabId}
          tabIndex={tab === "asks" ? 0 : -1}
          hidden={tab !== "asks"}
          display={tab === "asks" ? "flex" : "none"}
        >
          {tab === "asks" ? asksContent : null}
        </View>
      ) : null}
    </YStack>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { XStack, YStack } from "tamagui";
import {
  Badge,
  Button,
  Radio,
  RadioGroupField,
  StyledSelect,
  Text,
  TextInput,
  useFormatters,
  useNotify,
  useTranslations,
} from "@th/ui";

import { trpc } from "@/trpc";
import { fmtCurrency } from "@/lib/format";
import { formatErrorMessage } from "@/lib/format-error-message";

import {
  REWARD_TRIGGER_LABEL_KEY,
  volunteerConflictMessageKey,
  type RewardTrigger,
} from "./volunteering-helpers";

// Sentinel for the "applies to the whole ask" scope (roleId = null). A real
// role id is a uuid, so this can never collide.
const ASK_SCOPE_VALUE = "__ask__";

export type RewardFormTicketType = {
  id: string;
  name: string;
  priceCents: number;
};

export type RewardFormRole = {
  id: string;
  name: string;
};

export type RewardFormExisting = {
  id: string;
  roleId: string | null;
  ticketTypeId: string;
  ticketTypeName: string | null;
  faceValueCents: number | null;
  trigger: RewardTrigger;
  maxGrants: number | null;
  grantsUsed: number;
  remaining: number | null;
  active: boolean;
};

export type VolunteerRewardFormProps = {
  askId: string;
  /** Event ticket types the comp can target (from `events.listTicketTypesForEdit`). */
  ticketTypes: RewardFormTicketType[];
  /** ISO 4217 currency for face-value display; falls back to USD. */
  currency: string | null;
  /** Ask roles for optional per-role scoping. Empty = ask-level only. */
  roles: RewardFormRole[];
  /** Every configured reward on the ask, for pre-fill + current-config display. */
  rewards: RewardFormExisting[];
  /** Invoked after a successful save so the parent can refetch. */
  onSaved: () => void;
};

/**
 * Comp-ticket reward configuration form (volunteer-comp-tickets spec, FR-001;
 * COMP-only per the 2026-07-01 resolutions — a free ticket is the max, no
 * discount fields). Picks a target ticket type, a grant trigger, an optional
 * budget cap, and an optional per-role scope, then upserts via
 * `volunteer.rewards.set`. Finance-gated: the parent only renders this for
 * finance actors, and the server independently enforces `ORG_FINANCE_ROLES`.
 */
export function VolunteerRewardForm({
  askId,
  ticketTypes,
  currency,
  roles,
  rewards,
  onSaved,
}: VolunteerRewardFormProps) {
  const t = useTranslations();
  const fmt = useFormatters();
  const notify = useNotify();

  const displayCurrency = currency ?? "usd";

  const [roleScope, setRoleScope] = useState<string>(ASK_SCOPE_VALUE);
  const [ticketTypeId, setTicketTypeId] = useState<string>("");
  const [trigger, setTrigger] = useState<RewardTrigger>("ON_CHECK_IN");
  const [maxGrants, setMaxGrants] = useState<string>("");
  const [ticketTypeError, setTicketTypeError] = useState(false);
  const [maxGrantsError, setMaxGrantsError] = useState(false);

  const scopeRoleId = roleScope === ASK_SCOPE_VALUE ? null : roleScope;

  // The reward already configured at the selected scope (if any).
  const currentReward = useMemo(
    () => rewards.find((r) => (r.roleId ?? null) === scopeRoleId) ?? null,
    [rewards, scopeRoleId],
  );

  // Pre-fill the fields from the scope's saved reward whenever the scope
  // changes or the server config updates (post-save refetch). Editing before
  // submit is never clobbered mid-flight — reward reads are cached and only
  // refetch on mount / after a mutation.
  const currentRewardKey = currentReward
    ? `${currentReward.id}:${currentReward.ticketTypeId}:${currentReward.trigger}:${currentReward.maxGrants ?? "null"}`
    : null;
  useEffect(() => {
    if (currentReward) {
      setTicketTypeId(currentReward.ticketTypeId);
      setTrigger(currentReward.trigger);
      setMaxGrants(
        currentReward.maxGrants != null ? String(currentReward.maxGrants) : "",
      );
    } else {
      setTicketTypeId("");
      setTrigger("ON_CHECK_IN");
      setMaxGrants("");
    }
    setTicketTypeError(false);
    setMaxGrantsError(false);
    // currentRewardKey captures the identity + material fields of the reward.
  }, [roleScope, currentRewardKey, currentReward]);

  const setMutation = trpc.volunteer.rewards.set.useMutation({
    retry: false,
    meta: { silent: true },
    onSuccess: () => {
      notify.toast.success({
        id: "volunteer-reward-saved",
        title: String(t("volunteering.rewardSaved")),
      });
      onSaved();
    },
    onError: (err) => {
      const conflictKey = volunteerConflictMessageKey(err);
      notify.toast.danger({
        id: "volunteer-reward-save-failed",
        title: String(t("volunteering.rewardSaveFailed")),
        message: conflictKey
          ? String(t(conflictKey))
          : formatErrorMessage(err, t),
      });
    },
  });

  const handleSubmit = () => {
    // Ticket type is required — a comp must target a specific type.
    if (!ticketTypeId) {
      setTicketTypeError(true);
      return;
    }
    setTicketTypeError(false);

    // Budget cap: empty = uncapped (null). A present value must be a positive
    // integer — an out-of-range entry blocks submit rather than silently
    // becoming "no cap" (mirrors the ask role/group numeric fields).
    const trimmed = maxGrants.trim();
    let maxGrantsValue: number | null = null;
    if (trimmed !== "") {
      const parsed = Number(trimmed);
      const invalid =
        !Number.isFinite(parsed) ||
        !Number.isInteger(parsed) ||
        parsed < 1;
      if (invalid) {
        setMaxGrantsError(true);
        return;
      }
      maxGrantsValue = parsed;
    }
    setMaxGrantsError(false);

    setMutation.mutate({
      askId,
      roleId: scopeRoleId,
      ticketTypeId,
      trigger,
      maxGrants: maxGrantsValue,
    });
  };

  const ticketTypeOptions = ticketTypes.map((tt) => ({
    value: tt.id,
    label: `${tt.name} · ${fmtCurrency(fmt, tt.priceCents, displayCurrency)}`,
  }));

  const roleScopeOptions = [
    {
      value: ASK_SCOPE_VALUE,
      label: String(t("volunteering.rewardScopeWholeAsk")),
    },
    ...roles.map((role) => ({ value: role.id, label: role.name })),
  ];

  const noTicketTypes = ticketTypes.length === 0;

  return (
    <YStack gap="$4" data-testid="volunteer-reward-form">
      <YStack gap="$1">
        <Text
          tag="h3"
          variant="h4"
          weight="bold"
          style={{ textTransform: "uppercase" }}
        >
          {String(t("volunteering.rewardConfigTitle"))}
        </Text>
        <Text variant="caption" tone="muted">
          {String(t("volunteering.rewardConfigSubtitle"))}
        </Text>
      </YStack>

      {noTicketTypes ? (
        <Text
          variant="bodySmall"
          tone="muted"
          data-testid="volunteer-reward-no-ticket-types"
        >
          {String(t("volunteering.rewardNoTicketTypes"))}
        </Text>
      ) : (
        <>
          {/* Scope — only shown when the ask has roles to target. */}
          {roles.length > 0 ? (
            <YStack gap="$1" maxWidth={420}>
              <Text variant="label">
                {String(t("volunteering.rewardScopeLabel"))}
              </Text>
              <StyledSelect
                value={roleScope}
                options={roleScopeOptions}
                onChange={setRoleScope}
                aria-label={String(t("volunteering.rewardScopeLabel"))}
                testId="volunteer-reward-scope"
              />
            </YStack>
          ) : null}

          {/* Target ticket type. */}
          <YStack gap="$1" maxWidth={420}>
            <Text variant="label">
              {String(t("volunteering.rewardTicketTypeLabel"))}
            </Text>
            <StyledSelect
              value={ticketTypeId}
              options={ticketTypeOptions}
              placeholder={String(t("volunteering.rewardTicketTypePlaceholder"))}
              onChange={(value) => {
                setTicketTypeId(value);
                if (value) setTicketTypeError(false);
              }}
              aria-label={String(t("volunteering.rewardTicketTypeLabel"))}
              testId="volunteer-reward-ticket-type"
            />
            {ticketTypeError ? (
              <Text variant="caption" color="$danger" role="alert">
                {String(t("volunteering.rewardTicketTypeRequired"))}
              </Text>
            ) : null}
            <Text variant="caption" tone="muted">
              {String(t("volunteering.rewardCompHelp"))}
            </Text>
          </YStack>

          {/* Trigger. */}
          <YStack gap="$2" maxWidth={520}>
            <Text variant="label">
              {String(t("volunteering.rewardTriggerLabel"))}
            </Text>
            <RadioGroupField
              value={trigger}
              onValueChange={(value: string) =>
                setTrigger(value as RewardTrigger)
              }
              aria-label={String(t("volunteering.rewardTriggerLabel"))}
            >
              <YStack gap="$2">
                <Radio
                  value="ON_CHECK_IN"
                  testIdBase="volunteer-reward-trigger-check-in"
                  label={String(
                    t(REWARD_TRIGGER_LABEL_KEY.ON_CHECK_IN),
                  )}
                  description={String(
                    t("volunteering.rewardTriggerOnCheckInHelp"),
                  )}
                />
                <Radio
                  value="ON_APPROVAL"
                  testIdBase="volunteer-reward-trigger-approval"
                  label={String(t(REWARD_TRIGGER_LABEL_KEY.ON_APPROVAL))}
                  description={String(
                    t("volunteering.rewardTriggerOnApprovalHelp"),
                  )}
                />
              </YStack>
            </RadioGroupField>
          </YStack>

          {/* Budget cap. */}
          <YStack gap="$1" maxWidth={260}>
            <Text variant="label">
              {String(t("volunteering.rewardMaxGrantsLabel"))}
            </Text>
            <TextInput
              value={maxGrants}
              onChangeText={(value) => {
                setMaxGrants(value);
                if (value.trim() === "") setMaxGrantsError(false);
              }}
              inputMode="numeric"
              placeholder={String(t("volunteering.rewardMaxGrantsPlaceholder"))}
              fullWidth
              minHeight={44}
              testId="volunteer-reward-max-grants"
              aria-label={String(t("volunteering.rewardMaxGrantsLabel"))}
            />
            {maxGrantsError ? (
              <Text variant="caption" color="$danger" role="alert">
                {String(t("volunteering.rewardMaxGrantsInvalid"))}
              </Text>
            ) : null}
            <Text variant="caption" tone="muted">
              {String(t("volunteering.rewardMaxGrantsHelp"))}
            </Text>
          </YStack>

          {/* Current config summary. */}
          {currentReward ? (
            <YStack
              gap="$2"
              borderWidth={1}
              borderColor="$borderColor"
              backgroundColor="$surfaceMuted"
              padding="$3"
              data-testid="volunteer-reward-current-config"
            >
              <XStack gap="$2" alignItems="center" flexWrap="wrap">
                <Text variant="label">
                  {String(t("volunteering.rewardCurrentConfigLabel"))}
                </Text>
                <Badge tone={currentReward.active ? "success" : "neutral"} size="sm">
                  {String(
                    t(
                      currentReward.active
                        ? "volunteering.rewardActive"
                        : "volunteering.rewardInactive",
                    ),
                  )}
                </Badge>
              </XStack>
              <Text variant="bodySmall">
                {String(
                  t("volunteering.rewardCurrentConfigSummary", {
                    ticketType:
                      currentReward.ticketTypeName ??
                      String(t("volunteering.rewardTicketTypeGone")),
                    faceValue:
                      currentReward.faceValueCents != null
                        ? fmtCurrency(
                            fmt,
                            currentReward.faceValueCents,
                            displayCurrency,
                          )
                        : "—",
                    trigger: String(
                      t(REWARD_TRIGGER_LABEL_KEY[currentReward.trigger]),
                    ),
                  }),
                )}
              </Text>
              <Text variant="caption" tone="muted">
                {currentReward.maxGrants != null
                  ? String(
                      t("volunteering.rewardCurrentBudget", {
                        used: currentReward.grantsUsed,
                        cap: currentReward.maxGrants,
                        remaining: currentReward.remaining ?? 0,
                      }),
                    )
                  : String(
                      t("volunteering.rewardCurrentBudgetUncapped", {
                        used: currentReward.grantsUsed,
                      }),
                    )}
              </Text>
            </YStack>
          ) : null}

          <XStack>
            <Button
              variant="primary"
              size="$3"
              minHeight={44}
              onPress={handleSubmit}
              disabled={setMutation.isPending}
              data-testid="volunteer-reward-submit"
            >
              {String(
                currentReward
                  ? t("volunteering.rewardUpdateCta")
                  : t("volunteering.rewardSaveCta"),
              )}
            </Button>
          </XStack>
        </>
      )}
    </YStack>
  );
}

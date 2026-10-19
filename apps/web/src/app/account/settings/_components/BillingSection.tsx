"use client";

import { useState, useCallback } from "react";
import { YStack, XStack } from "tamagui";
import { CreditCard, Trash2 } from "lucide-react";
import {
  Text,
  Button,
  LabeledTextInput,
  Spinner,
  useNotify,
  useTranslations,
} from "@th/ui";
import { trpc } from "@/trpc";
import { SectionCard } from "./settings-primitives";
import { PersonalPayoutsSection } from "./PersonalPayoutsSection";

/**
 * Billing settings: the person's payout account, then their contact and
 * billing details. Payouts comes first because the resale listing form links
 * here ("Set up payouts"); on a phone the contact form would otherwise push
 * the thing they came for below the fold.
 */
export function BillingSection() {
  return (
    <YStack gap="$4">
      <PersonalPayoutsSection />
      <BillingContactCard />
    </YStack>
  );
}

function BillingContactCard() {
  const t = useTranslations();
  const { toast } = useNotify();
  const utils = trpc.useUtils();

  const profileQuery = trpc.humans.getMyProfile.useQuery(undefined, {
    staleTime: 60_000,
  });

  const hasSavedData = Boolean(
    profileQuery.data?.phone || profileQuery.data?.billingAddressLine1,
  );

  const [phone, setPhone] = useState("");
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");
  const [initialized, setInitialized] = useState(false);

  // Populate form from fetched profile
  const data = profileQuery.data;
  if (data && !initialized) {
    setPhone(data.phone ?? "");
    setLine1(data.billingAddressLine1 ?? "");
    setLine2(data.billingAddressLine2 ?? "");
    setCity(data.billingCity ?? "");
    setState(data.billingState ?? "");
    setPostalCode(data.billingPostalCode ?? "");
    setCountry(data.billingCountry ?? "");
    setInitialized(true);
  }

  const saveMutation = trpc.humans.updateProfile.useMutation({
    onSuccess: () => {
      utils.humans.getMyProfile.invalidate();
      toast.success({
        id: "billing-saved",
        title: String(t("account.sBillingSavedTitle")),
        message: String(t("account.sBillingSavedMsg")),
      });
    },
    onError: () => {
      toast.danger({
        id: "billing-save-failed",
        title: String(t("account.sBillingSaveFailedTitle")),
        message: String(t("account.sBillingSaveFailedMsg")),
      });
    },
  });

  const clearMutation = trpc.humans.updateProfile.useMutation({
    onSuccess: () => {
      setPhone("");
      setLine1("");
      setLine2("");
      setCity("");
      setState("");
      setPostalCode("");
      setCountry("");
      utils.humans.getMyProfile.invalidate();
      toast.success({
        id: "billing-cleared",
        title: String(t("account.sBillingClearedTitle")),
        message: String(t("account.sBillingClearedMsg")),
      });
    },
    onError: () => {
      toast.danger({
        id: "billing-clear-failed",
        title: String(t("account.sBillingSaveFailedTitle")),
        message: String(t("account.sBillingSaveFailedMsg")),
      });
    },
  });

  const handleSave = useCallback(() => {
    saveMutation.mutate({
      ...(phone.trim() ? { phone: phone.trim() } : {}),
      ...(line1.trim()
        ? {
            billingAddress: {
              line1: line1.trim(),
              ...(line2.trim() ? { line2: line2.trim() } : {}),
              city: city.trim(),
              state: state.trim(),
              postalCode: postalCode.trim(),
              country: country.trim(),
            },
          }
        : {}),
    });
  }, [phone, line1, line2, city, state, postalCode, country, saveMutation]);

  const handleClear = useCallback(() => {
    clearMutation.mutate({
      phone: "",
      billingAddress: {
        line1: "",
        city: "",
        state: "",
        postalCode: "",
        country: "",
      },
    });
  }, [clearMutation]);

  const isDirty = (() => {
    if (!data) return phone.trim().length > 0 || line1.trim().length > 0;
    return (
      phone.trim() !== (data.phone ?? "") ||
      line1.trim() !== (data.billingAddressLine1 ?? "") ||
      line2.trim() !== (data.billingAddressLine2 ?? "") ||
      city.trim() !== (data.billingCity ?? "") ||
      state.trim() !== (data.billingState ?? "") ||
      postalCode.trim() !== (data.billingPostalCode ?? "") ||
      country.trim() !== (data.billingCountry ?? "")
    );
  })();

  if (profileQuery.isLoading) {
    return (
      <SectionCard>
        <XStack gap="$2" alignItems="center">
          <CreditCard size={18} color="var(--colorMuted, #5C544A)" />
          <Text variant="h4" weight="bold">
            {String(t("account.sBillingTitle"))}
          </Text>
        </XStack>
        <XStack justifyContent="center" padding="$4">
          <Spinner size="sm" />
        </XStack>
      </SectionCard>
    );
  }

  return (
    <SectionCard>
      <XStack gap="$2" alignItems="center">
        <CreditCard size={18} color="var(--colorMuted, #5C544A)" />
        <Text variant="h4" weight="bold">
          {String(t("account.sBillingTitle"))}
        </Text>
      </XStack>

      <Text variant="caption" tone="muted">
        {String(t("account.sBillingDesc"))}
      </Text>

      <LabeledTextInput
        label={String(t("account.sBillingPhone"))}
        name="phone"
        value={phone}
        onChangeText={setPhone}
        placeholder={String(t("account.sBillingPhonePlaceholder"))}
        keyboardType="phone-pad"
        autoComplete="tel"
      />

      <LabeledTextInput
        label={String(t("account.sBillingLine1"))}
        name="address-line1"
        value={line1}
        onChangeText={setLine1}
        placeholder={String(t("account.sBillingLine1Placeholder"))}
        autoComplete="address-line1"
      />

      <LabeledTextInput
        label={String(t("account.sBillingLine2"))}
        name="address-line2"
        value={line2}
        onChangeText={setLine2}
        placeholder={String(t("account.sBillingLine2Placeholder"))}
        autoComplete="address-line2"
      />

      <XStack gap="$3" flexWrap="wrap">
        <YStack flex={1} minWidth={140}>
          <LabeledTextInput
            label={String(t("account.sBillingCity"))}
            name="city"
            value={city}
            onChangeText={setCity}
          />
        </YStack>
        <YStack flex={1} minWidth={140}>
          <LabeledTextInput
            label={String(t("account.sBillingState"))}
            name="state"
            value={state}
            onChangeText={setState}
          />
        </YStack>
      </XStack>

      <XStack gap="$3" flexWrap="wrap">
        <YStack flex={1} minWidth={140}>
          <LabeledTextInput
            label={String(t("account.sBillingPostalCode"))}
            name="postal-code"
            value={postalCode}
            onChangeText={setPostalCode}
            autoComplete="postal-code"
          />
        </YStack>
        <YStack flex={1} minWidth={140}>
          <LabeledTextInput
            label={String(t("account.sBillingCountry"))}
            name="country"
            value={country}
            onChangeText={setCountry}
            autoComplete="country"
          />
        </YStack>
      </XStack>

      <XStack
        justifyContent="space-between"
        alignItems="center"
        flexWrap="wrap"
        gap="$2"
      >
        {hasSavedData && (
          <Button
            variant="ghost"
            size="$3"
            onPress={handleClear}
            disabled={clearMutation.isPending}
          >
            <Trash2 size={14} />
            {clearMutation.isPending
              ? String(t("account.sBillingClearing"))
              : String(t("account.sBillingClear"))}
          </Button>
        )}

        <XStack flex={1} justifyContent="flex-end">
          {isDirty && (
            <Button
              variant="primary"
              size="$3"
              onPress={handleSave}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending
                ? String(t("account.sBillingSaving"))
                : String(t("account.sBillingSave"))}
            </Button>
          )}
        </XStack>
      </XStack>

      {!hasSavedData && !isDirty && (
        <Text variant="caption" tone="muted" textAlign="center">
          {String(t("account.sBillingNone"))}
        </Text>
      )}
    </SectionCard>
  );
}

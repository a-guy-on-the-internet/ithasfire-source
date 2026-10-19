"use client";

import { useCallback, useMemo, useState } from "react";

import { useTranslations } from "@th/ui";

import { trpc } from "@/trpc";
import { formatErrorMessage } from "@/lib/format-error-message";
import { CHARGEBACK_TERMS_VERSION } from "@/components/payments/ChargebackTermsContent";

/**
 * Chargeback-terms acceptance state for the payments page.
 *
 * `stripeConnect.initiateOnboarding` refuses (`chargeback_terms_required`)
 * unless the owner holds an acceptance of the CURRENT terms version, so the
 * page must record one before it offers the Connect button.
 *
 * ── Where the state comes from ──────────────────────────────────────────
 * The owner record carries `chargebackTermsVersion` / `chargebackTermsAcceptedAt`:
 *   • `orgs.getOrg` — the two keys are PRESENT (nullable) only for
 *     `ORG_FINANCE_ROLES`; ABSENT for other members. Absent means "not allowed
 *     to see", `null` means "never accepted".
 *   • `humans.getMyProfile` — always present (nullable).
 *
 * The server is authoritative, with one exception: right after this page
 * records an acceptance (or is told by onboarding that one is still required),
 * the cached record is stale until the invalidation refetch lands. A session
 * override covers that window and is dropped the moment the server has
 * answered AFTER it (`dataUpdatedAt` newer than the override) — so a fresh
 * accept never flashes back to `required`, and a backstop `markRequired`
 * never keeps showing "acknowledged" off a stale cache.
 */

export type ChargebackTermsOwner =
  | { kind: "org"; orgId: string }
  /** `humanId` omitted = the signed-in human (the human path is session-scoped). */
  | { kind: "human"; humanId?: string };

export type ChargebackTermsAcceptanceRecord = {
  chargebackTermsVersion?: string | null;
  chargebackTermsAcceptedAt?: Date | string | null;
};

export type ChargebackTermsAcceptance =
  /** Server read in flight — the gate cannot be decided yet. */
  | { status: "unknown" }
  /** The owner record omits the fields: this member may not see (or set) acceptance. */
  | { status: "forbidden" }
  | { status: "required" }
  | { status: "current"; version: string; acceptedAt: Date };

/**
 * Pure: the owner's stored acceptance → what the strict gate will say.
 * A stale-version acceptance is `required` — that is exactly the case where
 * an already-linked owner re-entering onboarding is refused.
 */
export function resolveChargebackTermsAcceptance(
  record: ChargebackTermsAcceptanceRecord | null | undefined,
  requiredVersion: string = CHARGEBACK_TERMS_VERSION,
): ChargebackTermsAcceptance {
  if (!record?.chargebackTermsAcceptedAt) return { status: "required" };
  if (record.chargebackTermsVersion !== requiredVersion) {
    return { status: "required" };
  }
  const acceptedAt = new Date(record.chargebackTermsAcceptedAt);
  if (Number.isNaN(acceptedAt.getTime())) return { status: "required" };
  return { status: "current", version: requiredVersion, acceptedAt };
}

/**
 * Pure: an `orgs.getOrg` / `humans.getMyProfile` payload → server-side
 * acceptance. `undefined` payload = still loading; keys absent = forbidden.
 */
export function resolveServerChargebackTermsAcceptance(
  payload: Record<string, unknown> | null | undefined,
  requiredVersion: string = CHARGEBACK_TERMS_VERSION,
): ChargebackTermsAcceptance {
  if (!payload) return { status: "unknown" };
  if (
    !("chargebackTermsVersion" in payload) ||
    !("chargebackTermsAcceptedAt" in payload)
  ) {
    return { status: "forbidden" };
  }
  return resolveChargebackTermsAcceptance(
    payload as ChargebackTermsAcceptanceRecord,
    requiredVersion,
  );
}

const ownerKeyOf = (owner: ChargebackTermsOwner | null): string | null => {
  if (!owner) return null;
  return owner.kind === "org"
    ? `org:${owner.orgId}`
    : `human:${owner.humanId ?? "self"}`;
};

type SessionOverride = {
  ownerKey: string;
  /** Wall-clock ms; compared against the query's `dataUpdatedAt`. */
  setAt: number;
  acceptance: ChargebackTermsAcceptance;
};

export function useChargebackTermsAcceptance(
  owner: ChargebackTermsOwner | null,
) {
  const t = useTranslations();
  const utils = trpc.useUtils();
  const [override, setOverride] = useState<SessionOverride | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ownerKey = ownerKeyOf(owner);
  const isOrg = owner?.kind === "org";
  const isHuman = owner?.kind === "human";

  // Same query keys the settings/account pages use, so React Query serves
  // one cached row to all of them rather than a duplicate request.
  const orgQuery = trpc.orgs.getOrg.useQuery(
    { orgId: isOrg ? owner.orgId : "" },
    { enabled: isOrg, staleTime: 30_000 },
  );
  const humanQuery = trpc.humans.getMyProfile.useQuery(undefined, {
    enabled: isHuman,
    staleTime: 30_000,
  });
  const activeQuery = isOrg ? orgQuery : isHuman ? humanQuery : null;

  const orgMutation = trpc.orgs.acceptChargebackTerms.useMutation({
    retry: false,
    meta: { silent: true },
  });
  const humanMutation = trpc.humans.acceptMyChargebackTerms.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const serverAcceptance = useMemo<ChargebackTermsAcceptance>(() => {
    if (!activeQuery) return { status: "unknown" };
    if (activeQuery.error) return { status: "unknown" };
    return resolveServerChargebackTermsAcceptance(
      activeQuery.data as Record<string, unknown> | undefined,
    );
  }, [activeQuery]);

  const acceptance = useMemo<ChargebackTermsAcceptance>(() => {
    const serverAnsweredAfterOverride =
      override !== null &&
      (activeQuery?.dataUpdatedAt ?? 0) > override.setAt;
    if (
      override &&
      override.ownerKey === ownerKey &&
      !serverAnsweredAfterOverride
    ) {
      return override.acceptance;
    }
    return serverAcceptance;
  }, [override, ownerKey, activeQuery?.dataUpdatedAt, serverAcceptance]);

  // A backstop error ("still required") is answered by the server saying
  // `current` — clear it on that transition, during render, so the inline
  // alert never outlives the state it described.
  const [prevStatus, setPrevStatus] = useState(acceptance.status);
  if (prevStatus !== acceptance.status) {
    setPrevStatus(acceptance.status);
    if (acceptance.status === "current") setError(null);
  }

  const invalidateOwner = useCallback(() => {
    if (!owner) return;
    if (owner.kind === "org") {
      void utils.orgs.getOrg.invalidate({ orgId: owner.orgId });
    } else {
      void utils.humans.getMyProfile.invalidate();
    }
  }, [owner, utils]);

  const accept = useCallback(async (): Promise<boolean> => {
    if (!owner || !ownerKey) return false;
    setError(null);
    try {
      const result =
        owner.kind === "org"
          ? await orgMutation.mutateAsync({ orgId: owner.orgId })
          : await humanMutation.mutateAsync();
      // `alreadyAccepted: true` ⇒ `acceptedAt` is the ORIGINAL legal
      // timestamp, which is exactly what the acknowledged line should show.
      setOverride({
        ownerKey,
        setAt: Date.now(),
        acceptance: resolveChargebackTermsAcceptance({
          chargebackTermsVersion: result.terms.version,
          chargebackTermsAcceptedAt: result.acceptedAt,
        }),
      });
      invalidateOwner();
      return true;
    } catch (err) {
      setError(formatErrorMessage(err, t));
      return false;
    }
  }, [owner, ownerKey, orgMutation, humanMutation, invalidateOwner, t]);

  /**
   * Backstop: onboarding still answered `chargeback_terms_required` (race,
   * stale cache, version bumped under us). Show the terms again with the
   * reason inline and ask the server for its current answer.
   */
  const markRequired = useCallback(
    (message: string) => {
      if (ownerKey) {
        setOverride({
          ownerKey,
          setAt: Date.now(),
          acceptance: { status: "required" },
        });
      }
      setError(message);
      invalidateOwner();
    },
    [ownerKey, invalidateOwner],
  );

  const clearError = useCallback(() => setError(null), []);

  return {
    acceptance,
    accept,
    isAccepting: orgMutation.isPending || humanMutation.isPending,
    /** The owner-record read failed; the gate stays closed until it succeeds. */
    loadError: activeQuery?.error
      ? formatErrorMessage(activeQuery.error, t)
      : null,
    retryLoad: () => {
      void activeQuery?.refetch();
    },
    error,
    clearError,
    markRequired,
  };
}

/**
 * Read-only view of the owner's STORED acceptance, for surfaces that record
 * acceptance through their own flow (the event builder) but must still
 * recognise one made elsewhere (this page). Same query keys and `staleTime`
 * as `useChargebackTermsAcceptance`, so both read one cached row and an
 * `invalidate` from either side refreshes the other.
 *
 * Anything but `current` (loading, read failed, `forbidden`, `required`)
 * gives the caller no acceptance to rely on: it falls back to whatever it
 * knew without the stored record.
 */
export function useStoredChargebackTermsAcceptance(
  owner: ChargebackTermsOwner | null,
  options: { enabled?: boolean } = {},
): ChargebackTermsAcceptance {
  const enabled = options.enabled ?? true;
  const isOrg = enabled && owner?.kind === "org";
  const isHuman = enabled && owner?.kind === "human";

  const orgQuery = trpc.orgs.getOrg.useQuery(
    { orgId: owner?.kind === "org" ? owner.orgId : "" },
    { enabled: isOrg, staleTime: 30_000 },
  );
  const humanQuery = trpc.humans.getMyProfile.useQuery(undefined, {
    enabled: isHuman,
    staleTime: 30_000,
  });
  const activeQuery = isOrg ? orgQuery : isHuman ? humanQuery : null;
  const hasQuery = activeQuery !== null;
  const data = activeQuery?.data;
  const failed = Boolean(activeQuery?.error);

  return useMemo<ChargebackTermsAcceptance>(() => {
    if (!hasQuery || failed) return { status: "unknown" };
    return resolveServerChargebackTermsAcceptance(
      data as Record<string, unknown> | undefined,
    );
  }, [hasQuery, data, failed]);
}

"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Spinner } from "@th/ui";

import { centsToFeeAmountInput } from "@/app/p/[slug]/_components/blocks/request-to-play-form.helpers";
import {
  BORDER,
  STEEL_BLUE,
  STEEL_BLUE_SOFT,
  TEXT,
  TEXT_CAPTION,
  TEXT_MUTED,
  inputLabelStyle,
  primaryButtonStyle,
  primaryButtonDisabledStyle,
  secondaryButtonStyle,
} from "@/app/embed/[embedId]/_components/embed-theme";
import type { BookingFeeType } from "@th/types/repos/booking-requests";

import { createEmbedAuthedClient } from "./embed-authed-client";
import {
  EMPTY_PITCH_VALUES,
  PITCH_DETAIL_FIELDS,
  buildEmbedPitchPayload,
  mapEmbedBookingSubmitError,
  pitchFieldId,
  type EmbedPitchError,
  type EmbedPitchValues,
} from "./booking-widget-helpers";
import { BookingPitchFields } from "./BookingPitchFields";
import { SubmitErrorBanner } from "./SubmitErrorBanner";

// ─────────────────────────────────────────────────────────────────────────────
// Local structural types (shapes come from the tRPC output contracts)
// ─────────────────────────────────────────────────────────────────────────────

type BookingSender = {
  ownerType: "human" | "org";
  ownerId: string;
  displayName: string;
  isDefault: boolean;
};

type OwnerStatus = { ownerId: string; enabled: boolean };

type PerformerStatus = {
  human: OwnerStatus;
  orgs: OwnerStatus[];
};

type BookingDefaults = {
  actName: string | null;
  lineupSize: number | null;
  setLengthMinutes: number | null;
  techNeeds: string | null;
  feeType: BookingFeeType | null;
  feeAmountCents: number | null;
  messageTemplate: string | null;
  linkMusic: string | null;
  linkVideo: string | null;
  linkSocial: string | null;
  linkEpk: string | null;
};

const senderKeyOf = (s: Pick<BookingSender, "ownerType" | "ownerId">): string =>
  `${s.ownerType}:${s.ownerId}`;

/**
 * Performer-mode state for a sender: true/false when known from
 * `performers.getMyStatus` (self + admin orgs), null when unknown (edit-role
 * orgs the status query doesn't cover) — unknown senders may attempt to
 * submit; the server re-checks and we surface PERFORMER_MODE_REQUIRED.
 */
function enabledFor(
  sender: BookingSender,
  status: PerformerStatus,
): boolean | null {
  if (sender.ownerType === "human") return status.human.enabled;
  const org = status.orgs.find((o) => o.ownerId === sender.ownerId);
  return org ? org.enabled : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Signed-in booking form (FR-010/FR-011): sender picker (self + orgs with edit
 * roles, default preselected), booking-defaults prefill per selected sender,
 * one-click performer-mode enable gate (RequestToPlayPanel pattern), and an
 * owned submission via `bookingRequests.create` over the popup-handoff Bearer
 * JWT. Contact fields are hidden — identity comes from the account.
 */
export function SignedInBookingPanel({
  placeId,
  token,
  onSuccess,
  onSessionExpired,
  onLogout,
}: {
  placeId: string;
  /** In-memory bearer JWT from the popup handoff. */
  token: string;
  onSuccess: () => void;
  /** Token was rejected (401) — parent drops it and re-shows the login affordance. */
  onSessionExpired: () => void;
  /** "Use the guest form instead" — parent drops the token. */
  onLogout: () => void;
}) {
  const idBase = useId();

  // A new token means a new login → the parent remounts this panel, so a
  // token-keyed memo is stable for the panel's lifetime.
  const client = useMemo(() => createEmbedAuthedClient(() => token), [token]);

  const [bootstrap, setBootstrap] = useState<{
    senders: BookingSender[];
    status: PerformerStatus;
  } | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootRetryKey, setBootRetryKey] = useState(0);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [pitch, setPitch] = useState<EmbedPitchValues>(EMPTY_PITCH_VALUES);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pitchError, setPitchError] = useState<EmbedPitchError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [hasSavedDefaults, setHasSavedDefaults] = useState(false);
  const [enabling, setEnabling] = useState(false);
  /** Local overrides after a one-click enable / server PERFORMER_MODE_REQUIRED. */
  const [enabledOverrides, setEnabledOverrides] = useState<
    Record<string, boolean>
  >({});

  const touchedRef = useRef<Set<keyof EmbedPitchValues>>(new Set());

  const handleUnauthorized = useCallback(
    (err: unknown): boolean => {
      if (mapEmbedBookingSubmitError(err).kind === "unauthorized") {
        onSessionExpired();
        return true;
      }
      return false;
    },
    [onSessionExpired],
  );

  // ── Bootstrap: senders + performer status ─────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setBootError(null);
    void (async () => {
      try {
        const [sendersRes, statusRes] = await Promise.all([
          client.bookingRequests.listMySenders.query(),
          client.performers.getMyStatus.query(),
        ]);
        if (cancelled) return;
        setBootstrap({
          senders: sendersRes.senders,
          status: {
            human: {
              ownerId: statusRes.human.ownerId,
              enabled: statusRes.human.enabled,
            },
            orgs: statusRes.orgs.map((o) => ({
              ownerId: o.ownerId,
              enabled: o.enabled,
            })),
          },
        });
        const defaultSender =
          sendersRes.senders.find((s) => s.isDefault) ?? sendersRes.senders[0];
        setSelectedKey(defaultSender ? senderKeyOf(defaultSender) : null);
      } catch (err) {
        if (cancelled) return;
        if (handleUnauthorized(err)) return;
        setBootError("Couldn't load your profile. Please try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, handleUnauthorized, bootRetryKey]);

  const senders = bootstrap?.senders ?? [];
  const sender =
    senders.find((s) => senderKeyOf(s) === selectedKey) ?? senders[0] ?? null;

  const selectedEnabled: boolean | null =
    sender && bootstrap
      ? (enabledOverrides[senderKeyOf(sender)] ??
        enabledFor(sender, bootstrap.status))
      : null;

  // ── Booking-defaults prefill for the selected sender ──────────────────────
  // Mirrors the platform form's seed rules: only untouched fields are seeded,
  // and when the new sender has no data every untouched field RESETS so the
  // previous sender's values never linger under a different identity.
  useEffect(() => {
    if (!sender) return;
    let cancelled = false;
    void (async () => {
      let defaults: BookingDefaults | null = null;
      let hasSaved = false;
      try {
        const res = await client.performers.getBookingDefaults.query({
          ownerType: sender.ownerType,
          ownerId: sender.ownerId,
        });
        defaults = res.defaults;
        hasSaved = res.hasSaved;
      } catch (err) {
        if (cancelled) return;
        if (handleUnauthorized(err)) return;
        // Defaults are a convenience — a failed fetch just means no prefill.
      }
      if (cancelled) return;
      setHasSavedDefaults(hasSaved);
      const touched = touchedRef.current;
      setPitch((prev) => {
        const next = { ...prev };
        const seed = (
          field: keyof EmbedPitchValues,
          value: string,
        ) => {
          if (!touched.has(field) && field !== "preferredDates") {
            (next as Record<string, unknown>)[field] = value;
          }
        };
        seed("actName", defaults?.actName ?? "");
        seed(
          "lineupSize",
          defaults?.lineupSize != null ? String(defaults.lineupSize) : "",
        );
        seed(
          "setLengthMinutes",
          defaults?.setLengthMinutes != null
            ? String(defaults.setLengthMinutes)
            : "",
        );
        seed("techNeeds", defaults?.techNeeds ?? "");
        seed("message", defaults?.messageTemplate ?? "");
        seed("linkMusic", defaults?.linkMusic ?? "");
        seed("linkVideo", defaults?.linkVideo ?? "");
        seed("linkSocial", defaults?.linkSocial ?? "");
        seed("linkEpk", defaults?.linkEpk ?? "");
        if (!touched.has("feeType")) {
          next.feeType = (defaults?.feeType ??
            "") as EmbedPitchValues["feeType"];
        }
        if (!touched.has("feeAmountDollars")) {
          next.feeAmountDollars =
            defaults?.feeAmountCents != null
              ? centsToFeeAmountInput(defaults.feeAmountCents)
              : "";
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, sender, handleUnauthorized]);

  const updatePitch = <K extends keyof EmbedPitchValues>(
    field: K,
    value: EmbedPitchValues[K],
  ) => {
    touchedRef.current.add(field);
    setPitch((prev) => ({ ...prev, [field]: value }));
  };

  const focusField = (domId: string) => {
    window.setTimeout(() => {
      document.getElementById(domId)?.focus();
    }, 0);
  };

  // ── One-click performer-mode enable (RequestToPlayPanel pattern) ──────────
  const handleEnablePerformerMode = async () => {
    if (!sender || enabling) return;
    setEnabling(true);
    setSubmitError(null);
    try {
      await client.performers.setMode.mutate({
        ownerType: sender.ownerType,
        ownerId: sender.ownerId,
        enabled: true,
      });
      setEnabledOverrides((prev) => ({
        ...prev,
        [senderKeyOf(sender)]: true,
      }));
    } catch (err) {
      if (handleUnauthorized(err)) return;
      setSubmitError("Couldn't enable performer mode. Please try again.");
    } finally {
      setEnabling(false);
    }
  };

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!sender || submitting) return;

    setSubmitError(null);
    setPitchError(null);

    const result = buildEmbedPitchPayload(pitch, {
      requireActName: false,
      senderOwnerType: sender.ownerType,
    });
    if (!result.ok) {
      setPitchError(result.error);
      if (PITCH_DETAIL_FIELDS.has(result.error.field)) setDetailsOpen(true);
      focusField(pitchFieldId(idBase, result.error.field));
      return;
    }

    setSubmitting(true);
    try {
      // NOTE: `bookingRequests.create` has no `source`/`embedId` input yet —
      // strict schema, so the embed submission is indistinguishable from a
      // platform one server-side (tracked follow-up in the build plan).
      await client.bookingRequests.create.mutate({
        performerOwnerType: sender.ownerType,
        performerOwnerId: sender.ownerId,
        placeId,
        ...result.payload,
      });
      onSuccess();
    } catch (err) {
      if (handleUnauthorized(err)) return;
      const mapped = mapEmbedBookingSubmitError(err);
      if (mapped.kind === "performerMode") {
        // The server disagrees with our optimistic view — show the gate.
        setEnabledOverrides((prev) => ({
          ...prev,
          [senderKeyOf(sender)]: false,
        }));
      }
      setSubmitError(mapped.message);
    } finally {
      setSubmitting(false);
    }
  };

  // ── Signed-in strip (always visible in this mode) ──────────────────────────
  const strip = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        border: `2px solid ${BORDER}`,
        padding: "8px 12px",
      }}
    >
      <span
        style={{
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: STEEL_BLUE,
        }}
      >
        Signed in{sender ? ` · ${sender.displayName}` : ""}
      </span>
      <button
        type="button"
        onClick={onLogout}
        style={{
          border: "none",
          borderRadius: 0,
          background: "none",
          padding: "6px 4px",
          // Mobile tap-target floor.
          minHeight: 44,
          fontSize: 11,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: TEXT_MUTED,
          textDecoration: "underline",
          textUnderlineOffset: 2,
          cursor: "pointer",
          fontFamily: "inherit",
        }}
      >
        Use the guest form
      </button>
    </div>
  );

  // ── Loading / error shells ─────────────────────────────────────────────────
  if (bootError) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {strip}
        <SubmitErrorBanner message={bootError} />
        <button
          type="button"
          onClick={() => setBootRetryKey((k) => k + 1)}
          style={secondaryButtonStyle}
        >
          Try again
        </button>
      </div>
    );
  }

  if (!bootstrap || !sender) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {strip}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            padding: 24,
          }}
          aria-label="Loading your profile"
          role="status"
        >
          <Spinner size="md" indicatorColor={TEXT_CAPTION} />
        </div>
      </div>
    );
  }

  // ── Performer-mode gate ────────────────────────────────────────────────────
  if (selectedEnabled === false) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {strip}
        {senders.length > 1 && (
          <SenderPicker
            idBase={idBase}
            senders={senders}
            selectedKey={senderKeyOf(sender)}
            onSelect={setSelectedKey}
            disabled={enabling}
          />
        )}
        <div
          style={{
            border: `2px solid ${STEEL_BLUE}`,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 10,
          }}
        >
          <p
            style={{
              margin: 0,
              fontSize: 13,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
              color: TEXT,
            }}
          >
            Performer mode required
          </p>
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: TEXT_MUTED }}>
            Performer mode lets places see and reply to booking requests from{" "}
            {sender.displayName}. Turn it on to send this request.
          </p>
          <SubmitErrorBanner message={submitError} />
          <button
            type="button"
            onClick={() => void handleEnablePerformerMode()}
            disabled={enabling}
            aria-busy={enabling || undefined}
            style={{
              ...primaryButtonStyle,
              ...(enabling ? primaryButtonDisabledStyle : {}),
            }}
          >
            {enabling ? "Enabling…" : "Enable performer mode"}
          </button>
        </div>
      </div>
    );
  }

  // ── Form ───────────────────────────────────────────────────────────────────
  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      aria-label="Booking request"
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {strip}

      {senders.length > 1 && (
        <SenderPicker
          idBase={idBase}
          senders={senders}
          selectedKey={senderKeyOf(sender)}
          onSelect={setSelectedKey}
          disabled={submitting}
        />
      )}

      {hasSavedDefaults && (
        <p style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: TEXT_MUTED }}>
          Prefilled from your saved booking defaults — edit anything before
          sending.
        </p>
      )}

      <BookingPitchFields
        idBase={idBase}
        values={pitch}
        onChange={updatePitch}
        requireActName={false}
        error={pitchError}
        disabled={submitting}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={setDetailsOpen}
      />

      <SubmitErrorBanner message={submitError} />

      <button
        type="submit"
        disabled={submitting}
        aria-busy={submitting || undefined}
        style={{
          ...primaryButtonStyle,
          ...(submitting ? primaryButtonDisabledStyle : {}),
        }}
      >
        {submitting ? "Sending…" : "Send request"}
      </button>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sender picker (FR-011)
// ─────────────────────────────────────────────────────────────────────────────

function SenderPicker({
  idBase,
  senders,
  selectedKey,
  onSelect,
  disabled,
}: {
  idBase: string;
  senders: BookingSender[];
  selectedKey: string;
  onSelect: (key: string) => void;
  disabled: boolean;
}) {
  return (
    <fieldset
      style={{
        margin: 0,
        padding: 0,
        border: "none",
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
      disabled={disabled}
    >
      <legend style={{ ...inputLabelStyle, padding: 0, marginBottom: 6 }}>
        Submit as
      </legend>
      {senders.map((s) => {
        const key = senderKeyOf(s);
        const selected = key === selectedKey;
        return (
          <label
            key={key}
            htmlFor={`${idBase}-sender-${key}`}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              minHeight: 44,
              padding: "8px 12px",
              border: `2px solid ${selected ? STEEL_BLUE : BORDER}`,
              background: selected ? STEEL_BLUE_SOFT : "transparent",
              cursor: disabled ? "default" : "pointer",
            }}
          >
            <input
              id={`${idBase}-sender-${key}`}
              type="radio"
              name={`${idBase}-sender`}
              checked={selected}
              onChange={() => onSelect(key)}
              style={{ accentColor: STEEL_BLUE }}
            />
            <span
              style={{
                fontSize: 13,
                fontWeight: selected ? 700 : 500,
                color: TEXT,
              }}
            >
              {s.displayName}
              {s.ownerType === "org" ? " · Organization" : ""}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

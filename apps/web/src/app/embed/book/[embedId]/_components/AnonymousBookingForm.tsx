"use client";

import { useId, useRef, useState } from "react";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";

import { trpc } from "@/trpc";
import { getEmbedHostOrigin } from "@/lib/embed-host-origin";
import { TURNSTILE_SITE_KEY } from "@/app/embed/[embedId]/_components/embed-helpers";
import {
  DANGER,
  TEXT_CAPTION,
  inputLabelStyle,
  inputStyle,
  primaryButtonStyle,
  primaryButtonDisabledStyle,
} from "@/app/embed/[embedId]/_components/embed-theme";

import {
  CONTACT_NAME_MAX,
  EMPTY_PITCH_VALUES,
  PITCH_DETAIL_FIELDS,
  buildEmbedPitchPayload,
  mapEmbedBookingSubmitError,
  pitchFieldId,
  validateContactEmail,
  validateContactName,
  type EmbedPitchError,
  type EmbedPitchValues,
} from "./booking-widget-helpers";
import {
  BookingPitchFields,
  fieldColumnStyle,
  fieldErrorStyle,
} from "./BookingPitchFields";
import { SubmitErrorBanner } from "./SubmitErrorBanner";

type ContactErrors = {
  contactName: string | null;
  contactEmail: string | null;
};

const NO_CONTACT_ERRORS: ContactErrors = {
  contactName: null,
  contactEmail: null,
};

/**
 * Anonymous-first booking form (FR-002): name + email + pitch, Turnstile
 * protected, submitted via the public `embeds.createBookingInquiry`.
 * `requestIp`/`requestUserAgent` are server-injected — never sent from here
 * (the strict schema rejects them).
 */
export function AnonymousBookingForm({
  embedId,
  onSuccess,
}: {
  embedId: string;
  onSuccess: (contactEmail: string) => void;
}) {
  const idBase = useId();

  const [contactName, setContactName] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [pitch, setPitch] = useState<EmbedPitchValues>(EMPTY_PITCH_VALUES);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const [contactErrors, setContactErrors] =
    useState<ContactErrors>(NO_CONTACT_ERRORS);
  const [pitchError, setPitchError] = useState<EmbedPitchError | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance | null>(null);

  const createInquiry = trpc.embeds.createBookingInquiry.useMutation({
    retry: false,
    meta: { silent: true },
  });

  const updatePitch = <K extends keyof EmbedPitchValues>(
    field: K,
    value: EmbedPitchValues[K],
  ) => {
    setPitch((prev) => ({ ...prev, [field]: value }));
  };

  const focusField = (domId: string) => {
    window.setTimeout(() => {
      document.getElementById(domId)?.focus();
    }, 0);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (createInquiry.isPending) return;

    setSubmitError(null);
    setPitchError(null);

    // ── Contact fields ──────────────────────────────────────────────
    const nameError = validateContactName(contactName);
    const emailError = validateContactEmail(contactEmail);
    setContactErrors({ contactName: nameError, contactEmail: emailError });
    if (nameError) {
      focusField(`${idBase}-contactName`);
      return;
    }
    if (emailError) {
      focusField(`${idBase}-contactEmail`);
      return;
    }

    // ── Pitch fields (client mirror of the server rules) ────────────
    const result = buildEmbedPitchPayload(pitch, { requireActName: true });
    if (!result.ok) {
      setPitchError(result.error);
      if (PITCH_DETAIL_FIELDS.has(result.error.field)) setDetailsOpen(true);
      focusField(pitchFieldId(idBase, result.error.field));
      return;
    }

    // ── Turnstile ───────────────────────────────────────────────────
    if (TURNSTILE_SITE_KEY && !turnstileToken) {
      setSubmitError("Complete the verification above to send your request.");
      return;
    }

    const { actName, ...pitchPayload } = result.payload;

    createInquiry.mutate(
      {
        embedId,
        hostOrigin: getEmbedHostOrigin(),
        contactName: contactName.trim(),
        contactEmail: contactEmail.trim(),
        // Required on the anonymous path — validated non-empty above.
        actName: actName ?? "",
        ...pitchPayload,
        ...(turnstileToken ? { turnstileToken } : {}),
      },
      {
        onSuccess: () => onSuccess(contactEmail.trim()),
        onError: (err) => {
          const mapped = mapEmbedBookingSubmitError(err);
          setSubmitError(mapped.message);
          // A consumed/failed Turnstile token is dead — reset for retry.
          turnstileRef.current?.reset();
          setTurnstileToken(null);
        },
      },
    );
  };

  const submitting = createInquiry.isPending;

  return (
    <form
      onSubmit={handleSubmit}
      aria-label="Booking request"
      style={{ display: "flex", flexDirection: "column", gap: 16 }}
    >
      {/* ── Contact ──────────────────────────────────────────────────── */}
      <div style={fieldColumnStyle}>
        <label htmlFor={`${idBase}-contactName`} style={inputLabelStyle}>
          Your name
        </label>
        <input
          id={`${idBase}-contactName`}
          type="text"
          maxLength={CONTACT_NAME_MAX}
          value={contactName}
          onChange={(e) => setContactName(e.target.value)}
          disabled={submitting}
          autoComplete="name"
          aria-invalid={contactErrors.contactName ? true : undefined}
          aria-describedby={
            contactErrors.contactName ? `${idBase}-contactName-error` : undefined
          }
          style={{
            ...inputStyle,
            ...(contactErrors.contactName ? { borderColor: DANGER } : {}),
          }}
        />
        {contactErrors.contactName && (
          <p id={`${idBase}-contactName-error`} style={fieldErrorStyle}>
            {contactErrors.contactName}
          </p>
        )}
      </div>

      <div style={fieldColumnStyle}>
        <label htmlFor={`${idBase}-contactEmail`} style={inputLabelStyle}>
          Email
        </label>
        <input
          id={`${idBase}-contactEmail`}
          type="email"
          value={contactEmail}
          onChange={(e) => setContactEmail(e.target.value)}
          disabled={submitting}
          autoComplete="email"
          inputMode="email"
          aria-invalid={contactErrors.contactEmail ? true : undefined}
          aria-describedby={
            contactErrors.contactEmail
              ? `${idBase}-contactEmail-error`
              : undefined
          }
          style={{
            ...inputStyle,
            ...(contactErrors.contactEmail ? { borderColor: DANGER } : {}),
          }}
        />
        {contactErrors.contactEmail && (
          <p id={`${idBase}-contactEmail-error`} style={fieldErrorStyle}>
            {contactErrors.contactEmail}
          </p>
        )}
      </div>

      <BookingPitchFields
        idBase={idBase}
        values={pitch}
        onChange={updatePitch}
        requireActName
        error={pitchError}
        disabled={submitting}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={setDetailsOpen}
      />

      <SubmitErrorBanner message={submitError} />

      {/* Cloudflare Turnstile — bot verification (same wiring as embed checkout) */}
      {TURNSTILE_SITE_KEY && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
          }}
        >
          <Turnstile
            ref={turnstileRef}
            siteKey={TURNSTILE_SITE_KEY}
            options={{ theme: "light", size: "normal" }}
            onSuccess={setTurnstileToken}
            onExpire={() => setTurnstileToken(null)}
            onError={() => setTurnstileToken(null)}
          />
          {!turnstileToken && (
            <p style={{ fontSize: 10, color: TEXT_CAPTION, margin: 0 }}>
              Complete the verification to continue
            </p>
          )}
        </div>
      )}

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

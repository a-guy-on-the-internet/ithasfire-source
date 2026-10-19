import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

/**
 * The claim writes share a per-person hourly bucket. When it is spent the
 * server answers TOO_MANY_REQUESTS with English like "Rate limit exceeded for
 * claiming places. Try again in 3412s.", and the wizard used to print that
 * as-is. These tests pin the translated line with the wait in minutes.
 *
 * Translations resolve from the REAL en catalog (not an echo of the key), so
 * a missing or renamed key fails here. The design system is mocked away:
 * nothing here speaks to how the line looks in the modal.
 */

const mocks = vi.hoisted(() => ({
  submitError: null as unknown,
  challengeError: null as unknown,
  presignError: null as unknown,
}));

function rateLimited(message: string) {
  return { message, data: { code: "TOO_MANY_REQUESTS", httpStatus: 429 } };
}

vi.mock("@/trpc", () => {
  const failing = (get: () => unknown) => ({
    useMutation: () => ({
      mutate: (_vars: unknown, opts?: { onError?: (e: unknown) => void }) => {
        opts?.onError?.(get());
      },
      isPending: false,
      reset: vi.fn(),
    }),
  });
  const idle = { useMutation: () => ({ mutate: vi.fn(), isPending: false }) };
  return {
    trpc: {
      places: {
        submitPlaceClaim: failing(() => mocks.submitError),
        requestClaimEmailChallenge: failing(() => mocks.challengeError),
        setCommunityListingAcceptance: idle,
        requestClaimDocUpload: {
          useMutation: () => ({
            // A tRPC-shaped plain object, as the real client rejects with.
            mutateAsync: () => Promise.reject(mocks.presignError as Error),
            isPending: false,
          }),
        },
        confirmClaimEmailChallenge: idle,
      },
    },
  };
});

vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({
    isLoading: false,
    ownersWithSlugs: [
      { kind: "human", humanId: "11111111-1111-4111-8111-111111111111" },
    ],
  }),
}));

vi.mock("tamagui", () => {
  const Stack = ({
    children,
    onPress,
    role,
  }: Record<string, unknown> & { children?: ReactNode }) => (
    <div
      role={role as string | undefined}
      onClick={onPress as (() => void) | undefined}
    >
      {children}
    </div>
  );
  return { XStack: Stack, YStack: Stack, styled: (c: unknown) => c };
});

/** Look a dotted key up in the real en catalog and fill `{vars}`. */
function translate(key: string, args?: Record<string, unknown>): string {
  const value = key
    .split(".")
    .reduce<unknown>(
      (node, part) => (node as Record<string, unknown> | undefined)?.[part],
      enMessages,
    );
  if (typeof value !== "string") return key;
  return value.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(args?.[name] ?? `{${name}}`),
  );
}

vi.mock("@th/ui", () => ({
  Alert: ({ description }: { description?: string }) => (
    <div>{description}</div>
  ),
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    disabled,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  LabeledTextInput: ({
    value,
    onChangeText,
  }: {
    value?: string;
    onChangeText?: (v: string) => void;
  }) => (
    <input
      aria-label="email"
      value={value ?? ""}
      onChange={(e) => onChangeText?.(e.target.value)}
    />
  ),
  Modal: Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div role="dialog">{children}</div> : null,
    {
      Panel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Header: ({ title }: { title?: string }) => <div>{title}</div>,
      Body: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
      Footer: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    },
  ),
  Spinner: () => <span>loading</span>,
  Switch: () => null,
  Text: ({ children, role }: { children?: ReactNode; role?: string }) => (
    <span role={role}>{children}</span>
  ),
  useLocale: () => "en",
  useTranslations: () => translate,
}));

vi.mock("@/lib/images/prepare-image-upload", () => ({
  prepareImageForUpload: vi.fn(async (file: File) => file),
}));
vi.mock("@/lib/format", () => ({ formatBytes: () => "1 KB" }));

import { ClaimVenueWizard } from "../ClaimVenueWizard";

const PLACE_ID = "00000000-0000-4000-8000-00000000d141";

function open() {
  return render(
    <ClaimVenueWizard
      placeId={PLACE_ID}
      placeName="The Unclaimed Stage"
      open
      domainProofAvailable
      fastTrackEligible
      onClose={vi.fn()}
      onClaimed={vi.fn()}
    />,
  );
}

function button(label: string) {
  const found = screen
    .getAllByRole("button")
    .find((b) => (b.textContent ?? "").includes(label));
  expect(found, `button "${label}"`).toBeTruthy();
  return found!;
}

async function toProofStep() {
  await act(async () => fireEvent.click(button(translate("places.claimContinue"))));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-14T12:00:00Z"));
  mocks.submitError = null;
  mocks.challengeError = null;
  mocks.presignError = null;
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ClaimVenueWizard: rate-limited claim writes", () => {
  it("a rate-limited submit shows the translated line with the wait in minutes", async () => {
    mocks.submitError = rateLimited(
      "Rate limit exceeded for claiming places. Try again in 3412s.",
    );
    open();
    await toProofStep();
    await act(async () =>
      fireEvent.click(button(translate("places.claimProofDomainButton"))),
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "You’ve made a lot of claims. Try again in 57 minutes.",
    );
    expect(screen.getByRole("dialog").textContent).not.toContain("3412s");
  });

  it("without a wait in the message, says to try again later", async () => {
    mocks.submitError = rateLimited("Too many requests");
    open();
    await toProofStep();
    await act(async () =>
      fireEvent.click(button(translate("places.claimProofDomainButton"))),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "You’ve made a lot of claims. Try again later.",
    );
  });

  it("a rate-limited code request names codes, not claims", async () => {
    mocks.challengeError = rateLimited(
      "Rate limit exceeded for sending claim codes. Try again in 600s.",
    );
    open();
    await toProofStep();
    await act(async () =>
      fireEvent.click(button(translate("places.claimMethodChallenge"))),
    );
    await act(async () =>
      fireEvent.change(screen.getByLabelText("email"), {
        target: { value: "owner@stage.example" },
      }),
    );
    await act(async () =>
      fireEvent.click(button(translate("places.claimProofChallengeSend"))),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "You’ve asked for a lot of codes. Try again in 10 minutes.",
    );
  });

  it("other errors keep their existing handling", async () => {
    mocks.submitError = {
      message: "Something odd",
      data: { code: "INTERNAL_SERVER_ERROR" },
    };
    open();
    await toProofStep();
    await act(async () =>
      fireEvent.click(button(translate("places.claimProofDomainButton"))),
    );
    expect(screen.getByRole("alert").textContent).toBe("Something odd");
  });

  it("a rate-limited document upload says uploads, not claims", async () => {
    mocks.presignError = rateLimited(
      "Rate limit exceeded for uploading claim documents. Try again in 42s.",
    );
    open();
    await toProofStep();
    await act(async () =>
      fireEvent.click(button(translate("places.claimMethodDocument"))),
    );
    const input = document.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    expect(input, "file input").toBeTruthy();
    await act(async () =>
      fireEvent.change(input, {
        target: {
          files: [new File(["%PDF-"], "lease.pdf", { type: "application/pdf" })],
        },
      }),
    );
    await act(async () =>
      fireEvent.click(button(translate("places.claimSubmit"))),
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "Too many uploads at once. Try again in 1 minute.",
    );
  });
});

describe("rate-limit copy exists in both catalogs", () => {
  const keys = [
    "claimRateLimited",
    "claimRateLimitedNoTime",
    "claimCodeRateLimited",
    "claimCodeRateLimitedNoTime",
    "claimUploadRateLimited",
    "claimUploadRateLimitedNoTime",
  ] as const;
  it.each(keys)("%s is in en and es", (key) => {
    const en = (enMessages.places as Record<string, string>)[key];
    const es = (esMessages.places as Record<string, string>)[key];
    expect(typeof en).toBe("string");
    expect(typeof es).toBe("string");
    expect(en.includes("{when}")).toBe(es.includes("{when}"));
  });
});

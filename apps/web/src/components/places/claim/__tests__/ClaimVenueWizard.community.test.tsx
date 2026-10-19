import type { ReactNode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FR-005 — the one community-listing decision, at claim time
 * (community-listings-at-claimed-venues).
 *
 * Scope is deliberately narrow: this file pins ONLY the success screen's new
 * arms. The wizard's owner/proof steps have their own coverage and are driven
 * here just far enough to reach a result.
 *
 * WHY THE TWO ARMS DIFFER, since that asymmetry is the whole design:
 * `setCommunityListingAcceptance` REFUSES to enable on a place that is not
 * VERIFIED (`PLACE_NOT_VERIFIED`). The FR-010 fast-track leaves the place
 * verified in one motion, so the switch works and writes immediately. The
 * ordinary path leaves it PENDING admin review, so a switch there would be a
 * control that cannot work — that arm names the decision and hands it to the
 * bookings page, where the count is also current rather than a guess about how
 * long review takes.
 *
 * WHAT THIS CANNOT SEE: the design system is mocked away, so nothing here
 * speaks to layout, the real Switch's focus ring, or how this sits inside the
 * modal. The wizard's success screen was NOT driven in a browser — reaching it
 * needs a completed claim with proof upload.
 */

const mocks = vi.hoisted(() => ({
  submitMutate: vi.fn(),
  setAcceptanceMutate: vi.fn(),
  presignMutate: vi.fn(),
  challengeMutate: vi.fn(),
  confirmMutate: vi.fn(),
}));

/** Result the claim mutation resolves with — per test. */
let claimResult: { autoVerified: boolean; communityListingCount: number } = {
  autoVerified: true,
  communityListingCount: 3,
};

vi.mock("@/trpc", () => {
  const mutation = (mutate: typeof mocks.submitMutate) => ({
    useMutation: () => ({ mutate, isPending: false, reset: vi.fn() }),
  });
  return {
    trpc: {
      places: {
        submitPlaceClaim: {
          useMutation: () => ({
            mutate: (
              _vars: unknown,
              opts?: { onSuccess?: (r: typeof claimResult) => void },
            ) => {
              mocks.submitMutate(_vars);
              opts?.onSuccess?.(claimResult);
            },
            isPending: false,
            reset: vi.fn(),
          }),
        },
        setCommunityListingAcceptance: {
          useMutation: () => ({
            mutate: (
              vars: unknown,
              opts?: { onError?: (e: unknown) => void },
            ) => {
              mocks.setAcceptanceMutate(vars, opts);
            },
            isPending: false,
          }),
        },
        requestClaimDocUpload: mutation(mocks.presignMutate),
        requestClaimEmailChallenge: mutation(mocks.challengeMutate),
        confirmClaimEmailChallenge: mutation(mocks.confirmMutate),
      },
    },
  };
});

// The wizard reads `ownersWithSlugs` (NOT `data`) and takes the canonical
// human id from it — the Better Auth user id is not guaranteed to equal the
// human id in prod, which is why the component refuses to infer one.
vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({
    isLoading: false,
    ownersWithSlugs: [
      { kind: "human", humanId: "11111111-1111-4111-8111-111111111111" },
    ],
  }),
}));

vi.mock("tamagui", () => {
  // Pass a11y props THROUGH. The owner rows are Tamagui Stacks carrying
  // `role="radio"` + `onPress` via the component's `webA11y()` escape hatch, so
  // a mock that swallows props renders a step the test cannot operate — and
  // fails with "no element with role radio", which reads like a product a11y
  // bug rather than a mock gap. Style props are dropped deliberately.
  const Stack = ({
    children,
    onPress,
    role,
    tabIndex,
    onKeyDown,
    ...rest
  }: Record<string, unknown> & { children?: ReactNode }) => {
    const aria = Object.fromEntries(
      Object.entries(rest).filter(([k]) => k.startsWith("aria-")),
    );
    return (
      <div
        role={role as string | undefined}
        tabIndex={tabIndex as number | undefined}
        onClick={onPress as (() => void) | undefined}
        onKeyDown={onKeyDown as undefined}
        {...aria}
      >
        {children}
      </div>
    );
  };
  return { XStack: Stack, YStack: Stack, styled: (c: unknown) => c };
});

vi.mock("@th/ui", () => ({
  Alert: ({ description, testID }: { description?: string; testID?: string }) => (
    <div data-testid={testID} role="status">
      {description}
    </div>
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
  LabeledTextInput: () => <input />,
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
  Switch: ({
    checked,
    onCheckedChange,
    testId,
    "aria-label": ariaLabel,
    saving,
  }: {
    checked: boolean;
    onCheckedChange: (v: boolean) => void;
    testId?: string;
    "aria-label"?: string;
    saving?: boolean;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-testid={testId}
      disabled={saving}
      onClick={() => onCheckedChange(!checked)}
    >
      switch
    </button>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useLocale: () => "en",
  // Echo key + args so a test can prove the count reaches the string.
  useTranslations:
    () =>
    (key: string, args?: Record<string, unknown>) =>
      args ? `${key}:${JSON.stringify(args)}` : key,
}));

vi.mock("@/lib/errors/normalize-error", () => ({
  normalizeError: () => ({ message: "boom" }),
}));
vi.mock("@/lib/images/prepare-image-upload", () => ({
  prepareImageForUpload: vi.fn(),
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

/**
 * Drive the wizard to its success screen: pick the owner (the radio row), go
 * to the proof step, then submit via the domain-match button (the fast-track
 * proof, which needs no upload or code).
 */
async function submitClaim() {
  // Step 1 — the component auto-selects the first owner once options resolve,
  // so clicking is belt-and-braces rather than required.
  const radio = screen.queryAllByRole("radio")[0];
  if (radio) await act(async () => fireEvent.click(radio));

  const cont = screen
    .getAllByRole("button")
    .find((b) => (b.textContent ?? "").includes("places.claimContinue"));
  expect(cont, "step-1 Continue button").toBeTruthy();
  await act(async () => fireEvent.click(cont!));

  // Step 2 — domain match submits in one click.
  const submit = screen
    .getAllByRole("button")
    .find((b) => (b.textContent ?? "").includes("places.claimProofDomainButton"));
  expect(submit, "domain-proof submit button").toBeTruthy();
  await act(async () => fireEvent.click(submit!));
}

beforeEach(() => {
  vi.clearAllMocks();
  claimResult = { autoVerified: true, communityListingCount: 3 };
});

describe("ClaimVenueWizard — FR-005 community-listing ask", () => {
  it("FAST-TRACK: offers the switch, because the place is already VERIFIED", async () => {
    open();
    await submitClaim();
    expect(screen.queryByTestId("claim-community-acceptance-switch")).toBeTruthy();
  });

  it("FAST-TRACK: flipping it writes through setCommunityListingAcceptance", async () => {
    open();
    await submitClaim();
    const sw = screen.getByTestId("claim-community-acceptance-switch");
    await act(async () => fireEvent.click(sw));
    expect(mocks.setAcceptanceMutate).toHaveBeenCalledWith(
      { placeId: PLACE_ID, accepts: true },
      expect.anything(),
    );
  });

  it("FAST-TRACK: states the booking-availability consequence before the decision", async () => {
    open();
    await submitClaim();
    expect(screen.getByTestId("claim-community-consequence").textContent).toContain(
      "admin.clAcceptanceConsequenceBody",
    );
  });

  it("FAST-TRACK: the count reaches the copy", async () => {
    open();
    await submitClaim();
    expect(screen.getByRole("dialog").textContent).toContain('{"count":3}');
  });

  it("PENDING: does NOT offer a switch — the backend would refuse it", async () => {
    claimResult = { autoVerified: false, communityListingCount: 2 };
    open();
    await submitClaim();
    expect(screen.queryByTestId("claim-community-acceptance-switch")).toBeNull();
    expect(mocks.setAcceptanceMutate).not.toHaveBeenCalled();
  });

  it("PENDING: names the decision and defers it, with the count", async () => {
    claimResult = { autoVerified: false, communityListingCount: 2 };
    open();
    await submitClaim();
    const note = screen.getByTestId("claim-community-pending-note");
    expect(note.textContent).toContain("places.claimCommunityPending");
    expect(note.textContent).toContain('{"count":2}');
  });

  it("at ZERO neither arm renders — the question would be abstract", async () => {
    // Today's true state for almost every venue (placeId is null on every
    // community listing until the backfill runs), so the wizard is unchanged.
    claimResult = { autoVerified: true, communityListingCount: 0 };
    open();
    await submitClaim();
    expect(screen.queryByTestId("claim-community-acceptance-switch")).toBeNull();
    expect(screen.queryByTestId("claim-community-pending-note")).toBeNull();
  });

  it("at ZERO on the pending arm it also renders nothing", async () => {
    claimResult = { autoVerified: false, communityListingCount: 0 };
    open();
    await submitClaim();
    expect(screen.queryByTestId("claim-community-pending-note")).toBeNull();
  });
});

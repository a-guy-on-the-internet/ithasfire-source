import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const pushMock = vi.fn();
const toastWarningMock = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock }),
  usePathname: () => "/admin/test-org/dashboard",
}));

vi.mock("@th/ui", () => ({
  useNotify: () => ({ toast: { warning: toastWarningMock } }),
  useTranslations: () => (key: string) => key,
}));

import {
  buildEnrollTwoFactorUrl,
  isSecondFactorRequiredError,
  useSecondFactorRequiredToast,
} from "../use-second-factor-required-toast";

/**
 * The exact client-visible shape for the moderation step-up gate:
 * `fail("SECOND_FACTOR_REQUIRED")` (packages/transport/trpc/src/guard.ts)
 * throws an AppError whose message defaults to the code; `toTrpcError`
 * (packages/transport/trpc/src/utils.ts) maps it to FORBIDDEN and stashes
 * `meta.appCode`; the errorFormatter (packages/transport/trpc/src/trpc.ts)
 * surfaces it on `error.data.appCode`.
 */
const secondFactorError = {
  message: "SECOND_FACTOR_REQUIRED",
  data: {
    code: "FORBIDDEN",
    httpStatus: 403,
    appCode: "SECOND_FACTOR_REQUIRED",
    meta: { appCode: "SECOND_FACTOR_REQUIRED" },
  },
};

describe("isSecondFactorRequiredError", () => {
  it("matches the structured data.appCode channel", () => {
    expect(isSecondFactorRequiredError(secondFactorError)).toBe(true);
  });

  it("matches the legacy message-only channel", () => {
    expect(
      isSecondFactorRequiredError({ message: "SECOND_FACTOR_REQUIRED" }),
    ).toBe(true);
  });

  it("rejects other app codes and non-errors", () => {
    expect(
      isSecondFactorRequiredError({
        message: "EDIT_SUGGESTION_ALREADY_REVIEWED",
        data: { code: "CONFLICT", appCode: "EDIT_SUGGESTION_ALREADY_REVIEWED" },
      }),
    ).toBe(false);
    expect(isSecondFactorRequiredError(new Error("boom"))).toBe(false);
    expect(isSecondFactorRequiredError(null)).toBe(false);
  });
});

describe("buildEnrollTwoFactorUrl", () => {
  it("appends redirect_url with the encoded current path (same param as staff-route-gate)", () => {
    expect(buildEnrollTwoFactorUrl("/admin/test-org/dashboard")).toBe(
      "/enroll-2fa?redirect_url=%2Fadmin%2Ftest-org%2Fdashboard",
    );
  });

  it("omits the param without a current path", () => {
    expect(buildEnrollTwoFactorUrl(null)).toBe("/enroll-2fa");
  });
});

describe("useSecondFactorRequiredToast", () => {
  beforeEach(() => {
    pushMock.mockClear();
    toastWarningMock.mockClear();
  });

  it("handles SECOND_FACTOR_REQUIRED: explanatory toast + enroll action", () => {
    const { result } = renderHook(() => useSecondFactorRequiredToast());

    expect(result.current(secondFactorError)).toBe(true);

    expect(toastWarningMock).toHaveBeenCalledTimes(1);
    const options = toastWarningMock.mock.calls[0][0];
    expect(options.title).toBe("moderation.secondFactorRequiredToast");
    expect(options.message).toBe("moderation.secondFactorRequiredToastMessage");
    expect(options.action.label).toBe(
      "moderation.secondFactorRequiredToastAction",
    );

    // The action navigates to /enroll-2fa with a redirect back to this page.
    options.action.onPress();
    expect(pushMock).toHaveBeenCalledWith(
      "/enroll-2fa?redirect_url=%2Fadmin%2Ftest-org%2Fdashboard",
    );
  });

  it("returns false and stays silent for other errors", () => {
    const { result } = renderHook(() => useSecondFactorRequiredToast());

    expect(
      result.current({
        message: "EDIT_SUGGESTION_ALREADY_REVIEWED",
        data: { code: "CONFLICT", appCode: "EDIT_SUGGESTION_ALREADY_REVIEWED" },
      }),
    ).toBe(false);

    expect(toastWarningMock).not.toHaveBeenCalled();
    expect(pushMock).not.toHaveBeenCalled();
  });
});

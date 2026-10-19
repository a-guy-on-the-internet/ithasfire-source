import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListByOrg = vi.fn();
const mockListBySubject = vi.fn();
const mockPlaceTitleQuery = vi.fn();
const mockAskFormProps = vi.fn();
const mockFormatErrorMessage = vi.fn();
// One translator instance, so the test can tell it was the one passed on.
const translate = (key: string, values?: Record<string, unknown>) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

vi.mock("tamagui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  return {
    YStack: ({
      children,
      "data-testid": testId,
    }: {
      children?: ReactNode;
      "data-testid"?: string;
    }) => <div data-testid={testId}>{children}</div>,
    XStack: passthrough,
    styled: () => passthrough,
  };
});

vi.mock("@th/ui", () => ({
  Badge: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Button: ({
    children,
    onPress,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    "data-testid"?: string;
  }) => (
    <button type="button" data-testid={testId} onClick={() => onPress?.()}>
      {children}
    </button>
  ),
  NextLinkAnchor: ({ children }: { children?: ReactNode }) => (
    <a>{children}</a>
  ),
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  useFormatters: () => ({
    locale: "en-US",
    dateTime: (value: Date, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", options).format(value),
  }),
  useTranslations: () => translate,
}));

vi.mock("@bprogress/next/app", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/trpc", () => ({
  trpc: {
    volunteer: {
      asks: {
        listByOrg: {
          useQuery: (input: unknown, opts: unknown) =>
            mockListByOrg(input, opts),
        },
        listBySubject: {
          useQuery: (input: unknown, opts: unknown) =>
            mockListBySubject(input, opts),
        },
      },
    },
    places: {
      getPlaceTitle: {
        useQuery: (input: unknown, opts: unknown) =>
          mockPlaceTitleQuery(input, opts),
      },
    },
  },
}));

vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (err: unknown, t?: unknown) =>
    mockFormatErrorMessage(err, t),
}));

vi.mock("@/components/AdminTableParts", () => ({
  AdminTableErrorState: ({
    message,
    testId,
  }: {
    message: string;
    testId?: string;
  }) => <div data-testid={testId}>{message}</div>,
}));

vi.mock("../VolunteerAskForm", () => ({
  VolunteerAskForm: (props: unknown) => {
    mockAskFormProps(props);
    return null;
  },
}));

import { AsksList } from "../AsksList";

const idle = { data: undefined, isLoading: false, isError: false, error: null };
const ok = (data: unknown) => ({ ...idle, data, refetch: vi.fn() });

const ask = {
  id: "ask-1",
  title: "Door crew",
  status: "OPEN",
  cadence: "ONE_TIME",
  startsAt: "2026-10-24T22:00:00.000Z",
  endsAt: "2026-10-25T02:00:00.000Z",
  timezone: "America/New_York",
  capacity: null,
};

const lastFormProps = () =>
  mockAskFormProps.mock.calls.at(-1)?.[0] as
    | { defaultTimezone?: string | null; subject: unknown }
    | undefined;

describe("AsksList", () => {
  beforeEach(() => {
    mockListByOrg.mockReset();
    mockListBySubject.mockReset();
    mockPlaceTitleQuery.mockReset();
    mockAskFormProps.mockReset();
    mockFormatErrorMessage.mockReset();
    mockListByOrg.mockReturnValue(ok([]));
    mockListBySubject.mockReturnValue(ok([]));
    mockPlaceTitleQuery.mockReturnValue({ data: undefined });
  });

  it("a place subject asks for the place and hands its zone to the form", () => {
    mockPlaceTitleQuery.mockReturnValue({
      data: { name: "Room", timezone: "America/Los_Angeles" },
    });
    render(<AsksList slug="org" subject={{ kind: "place", placeId: "p-1" }} />);

    expect(mockPlaceTitleQuery).toHaveBeenLastCalledWith(
      { placeId: "p-1" },
      expect.objectContaining({ enabled: true }),
    );
    fireEvent.click(screen.getByTestId("volunteer-asks-new-cta"));
    expect(lastFormProps()?.subject).toEqual({
      subjectType: "PLACE",
      subjectId: "p-1",
    });
    expect(lastFormProps()?.defaultTimezone).toBe("America/Los_Angeles");
  });

  it("passes null through when the place has no zone", () => {
    mockPlaceTitleQuery.mockReturnValue({
      data: { name: "Room", timezone: null },
    });
    render(<AsksList slug="org" subject={{ kind: "place", placeId: "p-1" }} />);
    fireEvent.click(screen.getByTestId("volunteer-asks-new-cta"));
    expect(lastFormProps()?.defaultTimezone).toBeNull();
  });

  it("an org subject leaves the place query off and sets no default zone", () => {
    render(<AsksList slug="org" subject={{ kind: "org", orgId: "o-1" }} />);

    expect(mockPlaceTitleQuery).toHaveBeenLastCalledWith(
      { placeId: "" },
      expect.objectContaining({ enabled: false }),
    );
    fireEvent.click(screen.getByTestId("volunteer-asks-new-cta"));
    expect(lastFormProps()?.defaultTimezone).toBeUndefined();
  });

  it("renders each ask's window in the ask's zone", () => {
    mockListByOrg.mockReturnValue(ok([ask]));
    render(<AsksList slug="org" subject={{ kind: "org", orgId: "o-1" }} />);

    const list = screen.getByTestId("volunteer-asks-list");
    expect(list.textContent?.replace(/[\u202f\u2009]/g, " ")).toContain(
      "Oct 24, 2026, 6:00 – 10:00 PM EDT",
    );
  });

  it("passes the translator when it formats a load error", () => {
    const error = new Error("boom");
    mockListByOrg.mockReturnValue({
      ...idle,
      isError: true,
      error,
      refetch: vi.fn(),
    });
    mockFormatErrorMessage.mockReturnValue("Translated failure");
    render(<AsksList slug="org" subject={{ kind: "org", orgId: "o-1" }} />);

    expect(mockFormatErrorMessage).toHaveBeenCalledWith(error, translate);
    expect(screen.getByTestId("volunteer-asks-error")).toHaveTextContent(
      "Translated failure",
    );
  });
});

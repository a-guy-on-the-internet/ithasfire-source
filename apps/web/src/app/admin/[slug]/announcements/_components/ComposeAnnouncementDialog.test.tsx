/**
 * Regression: the composer crashed on open with
 * `The intl string context variable "count" was not provided to the string
 * "~{count} recipients"`. The catalog values are ICU, so `t(key)` without
 * values throws; the dialog used `String(t(key)).replace("{count}", ...)`.
 *
 * The translator here is the REAL `createTranslator` over the REAL en catalog
 * (not a mock that tolerates a missing value), so a regression throws again.
 */
import { createTranslator } from "@th/locale";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import enMessages from "@/i18n/messages/en";

const state = vi.hoisted(() => ({
  count: 3 as number | undefined,
  toastSuccess: vi.fn(),
  sendTest: vi.fn(),
}));

vi.mock("tamagui", () => ({
  YStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  XStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react", () => ({
  Send: () => null,
  FlaskConical: () => null,
  Users: () => null,
  Info: () => null,
}));

vi.mock("@th/ui", () => {
  const passthrough = ({ children }: { children?: ReactNode }) => (
    <div>{children}</div>
  );
  const Modal = Object.assign(
    ({ open, children }: { open: boolean; children?: ReactNode }) =>
      open ? <div>{children}</div> : null,
    {
      Panel: passthrough,
      Header: passthrough,
      Body: passthrough,
      Footer: passthrough,
    },
  );
  const translator = createTranslator("en", enMessages as never);
  return {
    Modal,
    Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
    Button: ({
      children,
      onPress,
      disabled,
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
    }) => (
      <button type="button" onClick={onPress} disabled={disabled}>
        {children}
      </button>
    ),
    TextInput: ({
      value,
      onChangeText,
    }: {
      value: string;
      onChangeText: (v: string) => void;
    }) => (
      <input
        aria-label="subject"
        value={value}
        onChange={(e) => onChangeText(e.target.value)}
      />
    ),
    StyledSelect: () => null,
    Checkbox: () => null,
    FormErrorBanner: () => null,
    useNotify: () => ({ toast: { success: state.toastSuccess } }),
    useTranslations: () => translator.t,
  };
});

vi.mock("@/hooks/useFormErrors", () => ({
  useFormErrors: () => ({
    formError: null,
    setError: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock("@/app/admin/[slug]/events/new/_components/prose-editor", () => ({
  ProseEditor: () => null,
  proseMirrorDocToHtml: () => "<p>x</p>",
  createEmptyDoc: () => ({ type: "doc", content: [] }),
  hasContent: () => true,
}));

const idle = { data: undefined, isLoading: false };
vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({}),
    events: {
      listMine: { useQuery: () => idle },
      listTicketTypesForEdit: { useQuery: () => idle },
    },
    comms: { listAudiences: { useQuery: () => idle } },
    orgs: { getOrg: { useQuery: () => idle } },
    announcements: {
      previewAudienceCount: {
        useQuery: () => ({
          data: state.count === undefined ? undefined : { count: state.count },
          isLoading: false,
        }),
      },
      send: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
      sendTest: {
        useMutation: () => ({
          mutateAsync: state.sendTest,
          isPending: false,
        }),
      },
    },
  },
}));

import { ComposeAnnouncementDialog } from "./ComposeAnnouncementDialog";

function renderDialog() {
  return render(
    <ComposeAnnouncementDialog
      open
      onClose={vi.fn()}
      ownerType="ORGANIZATION"
      ownerId="org-1"
    />,
  );
}

describe("ComposeAnnouncementDialog ICU strings", () => {
  it("opens without throwing and renders the recipient count", () => {
    state.count = 3;
    renderDialog();
    expect(screen.getByText("~3 recipients")).toBeInTheDocument();
  });

  it("renders the zero-recipient message instead of the count", () => {
    state.count = 0;
    renderDialog();
    expect(
      screen.getByText("No recipients match this audience"),
    ).toBeInTheDocument();
  });

  it("shows the same count label in the confirm dialog", () => {
    state.count = 3;
    renderDialog();
    fireEvent.change(screen.getByLabelText("subject"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByText("Send now"));
    expect(screen.getAllByText("~3 recipients")).toHaveLength(2);
  });

  it("agrees with the composer on zero recipients in the confirm dialog", () => {
    state.count = 0;
    renderDialog();
    fireEvent.change(screen.getByLabelText("subject"), {
      target: { value: "Hello" },
    });
    fireEvent.click(screen.getByText("Send now"));
    expect(
      screen.getAllByText("No recipients match this audience"),
    ).toHaveLength(2);
    expect(screen.queryByText("~0 recipients")).toBeNull();
  });

  it("interpolates the test-send email into the toast", async () => {
    state.count = 3;
    state.sendTest.mockResolvedValue({ sentToEmail: "me@example.com" });
    renderDialog();
    fireEvent.change(screen.getByLabelText("subject"), {
      target: { value: "Hello" },
    });
    const testButton = screen
      .getAllByRole("button")
      .find((b) =>
        b.textContent?.includes(
          String(
            createTranslator("en", enMessages as never).t(
              "admin.announcementSendTest",
            ),
          ),
        ),
      );
    expect(testButton).toBeDefined();
    fireEvent.click(testButton!);
    await waitFor(() => expect(state.toastSuccess).toHaveBeenCalled());
    expect(state.toastSuccess.mock.calls[0]![0].message).toBe(
      "A test email was sent to me@example.com.",
    );
  });
});

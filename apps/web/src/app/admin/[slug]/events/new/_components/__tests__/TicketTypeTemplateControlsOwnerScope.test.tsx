/**
 * Ticket-type templates: whose library, and who may Customise.
 *
 * 1. OWNER. Templates belong to the EVENT's owner. A delegate's URL slug is
 *    their own workspace, so reading the owner from the slug put a delegate's
 *    templates in the wrong library. The REAL apply and save dialogs are
 *    mounted and the owner pair reaching the list query and create mutation
 *    is asserted. `useCurrentAdminOwner` answers with the DELEGATE's
 *    workspace, so reading the slug again fails these tests.
 *
 * 2. CUSTOMISE. Forking a catalogue template asks org OWNER/ADMIN, or the
 *    owner / an OWNER/ADMIN delegate (`fork-platform-ticket-template.ts`) —
 *    narrower than apply. The button shows only with `canCustomise`.
 */
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const PASS_PROP = /^(data-|aria-)|^(id|role|style|title|tabIndex|type)$/;
  const makeStack =
    (tag: string) =>
    ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [key: string]: unknown;
    }) => {
      const domProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rest)) {
        if (PASS_PROP.test(key)) domProps[key] = value;
      }
      if (onPress) domProps.onClick = onPress;
      return React.createElement(tag, domProps, children);
    };
  const Stack = makeStack("div");
  return {
    XStack: Stack,
    YStack: Stack,
    Stack,
    styled: () => Stack,
    useTheme: () => new Proxy({}, { get: () => ({ val: "#211C16" }) }),
  };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  const Text = ({ children }: { children?: ReactNode }) =>
    React.createElement("span", null, children);
  return {
    Text,
    Modal: ({ children }: { children?: ReactNode }) =>
      React.createElement("div", null, children),
    Button: ({
      children,
      onPress,
      disabled,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      disabled?: boolean;
      [key: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          type: "button",
          onClick: onPress,
          disabled,
          "data-testid": rest["data-testid"],
        },
        children,
      ),
    TextInput: ({
      testId,
      value,
      onChangeText,
    }: {
      testId?: string;
      value?: string;
      onChangeText?: (v: string) => void;
    }) =>
      React.createElement("input", {
        "data-testid": testId,
        value: value ?? "",
        onChange: (e: { currentTarget: { value: string } }) =>
          onChangeText?.(e.currentTarget.value),
      }),
    useNotify: () => ({ toast: { success: vi.fn(), danger: vi.fn() } }),
    useTranslations: () => (key: string) => key,
    useFormatters: () => ({}),
  };
});

vi.mock("../EventEditorSheet", async () => {
  const React = await import("react");
  return {
    EventEditorSheet: ({
      children,
      footer,
    }: {
      children?: ReactNode;
      footer?: ReactNode;
    }) => React.createElement("div", null, children, footer),
  };
});

// The save dialog imports one pure helper from the (heavy) editor module.
vi.mock("../TicketTypeEditor", () => ({
  buildTicketCardMeta: () => "",
}));
vi.mock("@/components/data-table/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));
vi.mock("@/components/volunteering/PlatformTemplateTag", () => ({
  PlatformTemplateTag: () => null,
}));
vi.mock("@/hooks/useFeatureGates", () => ({
  useFeatureGates: () => ({ gates: {} }),
}));
vi.mock("@/lib/format", () => ({ fmtCurrency: () => "$0.00" }));
vi.mock("@/lib/format-error-message", () => ({
  formatErrorMessage: (e: unknown) => String(e),
}));
vi.mock("@/lib/app-error", () => ({ getAppErrorCode: () => null }));
vi.mock("nanoid", () => ({ nanoid: () => "fixed-client-key" }));

const DELEGATE_HUMAN_ID = "99999999-9999-4999-8999-999999999999";
const PRINCIPAL_HUMAN_ID = "33333333-3333-4333-8333-333333333333";
const EVENT_ORG_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "11111111-1111-4111-8111-111111111111";

// The URL workspace is the DELEGATE's own — the owner the old code used.
vi.mock("@/hooks/useCurrentAdminOwner", () => ({
  useCurrentAdminOwner: () => ({
    currentOwner: { kind: "human", humanId: DELEGATE_HUMAN_ID },
    isLoading: false,
  }),
}));

const testMocks = vi.hoisted(() => ({
  listUseQuery: vi.fn(),
  createMutateAsync: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("@/trpc", () => {
  const idleMutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      useUtils: () => ({
        ticketTypeTemplates: {
          listTicketTypeTemplates: { invalidate: testMocks.invalidate },
        },
        events: {
          listTicketTypesForEdit: { invalidate: vi.fn() },
        },
      }),
      ticketTypeTemplates: {
        listTicketTypeTemplates: { useQuery: testMocks.listUseQuery },
        createTicketTypeTemplate: {
          useMutation: () => ({
            mutateAsync: testMocks.createMutateAsync,
            isPending: false,
          }),
        },
        applyTicketTypeTemplate: { useMutation: idleMutation },
        archiveTicketTypeTemplate: { useMutation: idleMutation },
        forkPlatformTemplate: { useMutation: idleMutation },
      },
    },
  };
});

import { TicketTypeTemplateControls } from "../TicketTypeTemplateControls";
import { ApplyTicketTypeTemplateDialog } from "../ApplyTicketTypeTemplateDialog";
import {
  toTemplateOwnerRef,
  type TemplateOwnerRef,
} from "../ticket-type-template-helpers";

const TICKET_TYPES = [
  {
    name: "General admission",
    priceCents: 1500,
    pricingMode: "FIXED" as const,
    minimumCents: null,
    suggestedCents: null,
    capacity: 100,
    resaleAllowed: false,
    resaleCapCents: null,
    transferAllowed: true,
  },
];

function renderControls(
  templateOwner: TemplateOwnerRef,
  canCustomiseTemplates = false,
) {
  return render(
    <TicketTypeTemplateControls
      eventId={EVENT_ID}
      templateOwner={templateOwner}
      canCustomiseTemplates={canCustomiseTemplates}
      ticketTypes={TICKET_TYPES}
    />,
  );
}

const PLATFORM_TEMPLATE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CATALOGUE = {
  items: [
    {
      id: PLATFORM_TEMPLATE_ID,
      name: "Club night",
      isPlatform: true,
      packId: "pack-club",
      ticketTypes: [
        {
          name: "General admission",
          priceCents: 1500,
          pricingMode: "FIXED",
          suggestedCents: null,
          capacity: 100,
        },
      ],
    },
  ],
  packs: [{ id: "pack-club", key: "club", name: "Club", blurb: null }],
};
const CUSTOMISE_BTN = `ticket-type-template-customise-${PLATFORM_TEMPLATE_ID}`;

beforeEach(() => {
  vi.clearAllMocks();
  testMocks.listUseQuery.mockReturnValue({
    data: { items: [], packs: [] },
    isLoading: false,
    error: null,
  });
  testMocks.createMutateAsync.mockResolvedValue({ id: "tpl_1" });
});

describe("toTemplateOwnerRef", () => {
  it("maps the builder's owner pair onto the template API's scope", () => {
    expect(toTemplateOwnerRef("org", EVENT_ORG_ID)).toEqual({
      ownerScope: "ORGANIZATION",
      ownerId: EVENT_ORG_ID,
    });
    expect(toTemplateOwnerRef("human", PRINCIPAL_HUMAN_ID)).toEqual({
      ownerScope: "HUMAN",
      ownerId: PRINCIPAL_HUMAN_ID,
    });
  });
});

describe.each([
  ["a principal human", toTemplateOwnerRef("human", PRINCIPAL_HUMAN_ID)],
  ["an org", toTemplateOwnerRef("org", EVENT_ORG_ID)],
])(
  "TicketTypeTemplateControls — delegate on an event owned by %s",
  (_label, eventOwner) => {
    it("lists templates from the EVENT owner's library, not the URL workspace's", () => {
      renderControls(eventOwner);
      fireEvent.click(screen.getByTestId("ticket-type-template-apply-btn"));

      expect(testMocks.listUseQuery).toHaveBeenCalled();
      for (const [input] of testMocks.listUseQuery.mock.calls) {
        expect(input).toEqual({
          ownerScope: eventOwner.ownerScope,
          ownerId: eventOwner.ownerId,
        });
        expect(input).not.toMatchObject({ ownerId: DELEGATE_HUMAN_ID });
      }
    });

    it("saves the new template into the EVENT owner's library", async () => {
      renderControls(eventOwner);
      fireEvent.click(screen.getByTestId("ticket-type-template-save-btn"));
      fireEvent.change(screen.getByTestId("ticket-type-template-name"), {
        target: { value: "Club night" },
      });
      fireEvent.click(screen.getByTestId("ticket-type-template-save-submit"));

      await waitFor(() =>
        expect(testMocks.createMutateAsync).toHaveBeenCalledTimes(1),
      );
      expect(testMocks.createMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerScope: eventOwner.ownerScope,
          ownerId: eventOwner.ownerId,
          name: "Club night",
        }),
      );
      expect(testMocks.invalidate).toHaveBeenCalledWith({
        ownerScope: eventOwner.ownerScope,
        ownerId: eventOwner.ownerId,
      });
    });
  },
);

describe("ApplyTicketTypeTemplateDialog — Customise needs the fork's admin bar", () => {
  beforeEach(() => {
    testMocks.listUseQuery.mockReturnValue({
      data: CATALOGUE,
      isLoading: false,
      error: null,
    });
  });

  const renderDialog = (canCustomise?: boolean) =>
    render(
      <ApplyTicketTypeTemplateDialog
        owner={toTemplateOwnerRef("human", PRINCIPAL_HUMAN_ID)}
        eventId={EVENT_ID}
        canCustomise={canCustomise}
        onClose={vi.fn()}
      />,
    );

  it("withholds Customise by default, and keeps the catalogue row appliable", () => {
    renderDialog();

    expect(screen.getByTestId("ticket-pack-section-club")).toBeInTheDocument();
    expect(screen.queryByTestId(CUSTOMISE_BTN)).not.toBeInTheDocument();
    expect(
      screen.getByTestId("ticket-type-template-apply-submit"),
    ).toBeInTheDocument();
  });

  it("offers Customise when the viewer clears the bar", () => {
    renderDialog(true);

    expect(screen.getByTestId(CUSTOMISE_BTN)).toBeInTheDocument();
  });

  it.each([
    [false, false],
    [true, true],
  ])(
    "the controls pass canCustomiseTemplates=%s through (Customise shown: %s)",
    (canCustomiseTemplates, shown) => {
      renderControls(
        toTemplateOwnerRef("human", PRINCIPAL_HUMAN_ID),
        canCustomiseTemplates,
      );
      fireEvent.click(screen.getByTestId("ticket-type-template-apply-btn"));

      if (shown) {
        expect(screen.getByTestId(CUSTOMISE_BTN)).toBeInTheDocument();
      } else {
        expect(screen.queryByTestId(CUSTOMISE_BTN)).not.toBeInTheDocument();
      }
    },
  );
});

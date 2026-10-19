import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  IthasFireProvider,
  NotificationProvider,
  TranslationProvider,
} from "@th/ui";
import type { Messages } from "@th/ui";
import enPackage from "@th/locale/messages/en.json";

import enApp from "@/i18n/messages/en";

/**
 * The lineup editor's notify caption (owner ruling "option A"): attaching a
 * REAL profile tells that person, so the editor says so before they press Add.
 * A free-typed name notifies nobody, and must not claim to.
 */

vi.mock("@/trpc", () => {
  const mutation = () => ({ mutateAsync: vi.fn(), isPending: false });
  return {
    trpc: {
      useUtils: () => ({
        eventHumans: { list: { invalidate: vi.fn() } },
      }),
      eventHumans: {
        list: { useQuery: () => ({ data: [], isLoading: false }) },
        getPerformerShareLinks: {
          useQuery: () => ({ data: undefined, isError: false }),
        },
        attach: { useMutation: mutation },
        detach: { useMutation: mutation },
        reorder: { useMutation: mutation },
      },
      events: {
        inviteLineupHumanToRegister: { useMutation: mutation },
      },
    },
  };
});

vi.mock("@/hooks/useIsMobile", () => ({ useIsMobile: () => false }));

const PICKED_ID = "99999999-9999-4999-8999-999999999999";
const actor = vi.hoisted(() => ({ humanId: "11111111-1111-4111-8111-111111111111" }));
// `listEventOwnerEntities`' human entry is always the caller.
vi.mock("@/hooks/useEventOwnerEntities", () => ({
  useEventOwnerEntities: () => ({
    ownersWithSlugs: [
      {
        kind: "human",
        humanId: actor.humanId,
        humanName: "Me",
        humanUsername: null,
        avatarUrl: null,
        adminSlug: "@me",
      },
    ],
  }),
}));

// The combobox is its own component with its own search query; the editor
// only sees its three callbacks, so the stand-in drives exactly those.
vi.mock("../HumanSearchCombobox", () => ({
  HumanSearchCombobox: ({
    inputValue,
    onInputChange,
    onSelect,
    onClear,
  }: {
    inputValue: string;
    onInputChange: (v: string) => void;
    onSelect: (humanId: string, displayName: string) => void;
    onClear: () => void;
  }): ReactNode => (
    <div>
      <input
        aria-label="Name"
        value={inputValue}
        onChange={(e) => onInputChange(e.target.value)}
      />
      <button
        type="button"
        onClick={() =>
          onSelect(PICKED_ID, "Ada Lovelace")
        }
      >
        pick-profile
      </button>
      <button type="button" onClick={onClear}>
        clear-profile
      </button>
    </div>
  ),
}));

import { LineupEditor } from "../LineupEditor";

const mergeCatalogs = (base: Messages, override: Messages): Messages => {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (
      typeof value === "object" &&
      value !== null &&
      typeof existing === "object" &&
      existing !== null
    ) {
      result[key] = mergeCatalogs(existing as Messages, value as Messages);
    } else {
      result[key] = value;
    }
  }
  return result as Messages;
};

const messages = mergeCatalogs(enPackage as unknown as Messages, enApp);

const renderEditor = () =>
  render(
    <IthasFireProvider>
      <TranslationProvider locale="en" messages={messages}>
        <NotificationProvider>
          <LineupEditor eventId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" />
        </NotificationProvider>
      </TranslationProvider>
    </IthasFireProvider>,
  );

const HINT =
  "Ada Lovelace will be told they're on the lineup, and can take themselves off it. On a draft, they hear when you publish.";

describe("LineupEditor — notify hint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    actor.humanId = "11111111-1111-4111-8111-111111111111";
  });

  it("is absent before anyone is picked", () => {
    renderEditor();
    expect(screen.queryByTestId("lineup-notify-hint")).toBeNull();
  });

  it("is absent for a free-typed name — that notifies nobody", () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Ada Lovelace" },
    });
    expect(screen.queryByTestId("lineup-notify-hint")).toBeNull();
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("appears, naming the person, when a real profile is picked", () => {
    renderEditor();
    fireEvent.click(screen.getByText("pick-profile"));
    expect(screen.getByTestId("lineup-notify-hint")).toBeTruthy();
    expect(screen.getByText(HINT)).toBeTruthy();
  });

  it("is absent when the editor picks THEMSELF — the server tells nobody", () => {
    actor.humanId = PICKED_ID;
    renderEditor();
    fireEvent.click(screen.getByText("pick-profile"));
    expect(screen.queryByTestId("lineup-notify-hint")).toBeNull();
  });

  it("goes away when the picked profile is cleared", () => {
    renderEditor();
    fireEvent.click(screen.getByText("pick-profile"));
    fireEvent.click(screen.getByText("clear-profile"));
    expect(screen.queryByTestId("lineup-notify-hint")).toBeNull();
  });
});

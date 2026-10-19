/**
 * Description starters in the builder's details section.
 *
 * Pins: the row shows only while the body is empty and no image or audio
 * upload is in flight; tapping a starter sets the body to ordinary
 * paragraph + bullet-list prose, reseeds the editor with it and moves focus
 * into the new editor; the row disappears once there is content.
 *
 * MOCKS: ProseEditor (records the `initialContent` it was seeded with,
 * remounts on `key`, calls `onReady` on mount and renders a contenteditable),
 * tamagui / @th/ui reduced to DOM elements. `hasContent` is the REAL one from
 * prose-utils; `useTranslations` reads the REAL en catalog.
 */
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import en from "@/i18n/messages/en";
import es from "@/i18n/messages/es";
import type { ProseMirrorDoc } from "@th/schema";

import {
  buildDescriptionStarterDoc,
  DESCRIPTION_STARTER_KINDS,
  resolveStarterCategory,
  starterKindForCategory,
  type DescriptionStarterKind,
} from "../description-starters";

vi.mock("tamagui", async () => {
  const React = await import("react");
  const Stack = ({
    children,
    role,
    "aria-labelledby": labelledBy,
    "data-testid": testId,
  }: {
    children?: ReactNode;
    role?: string;
    "aria-labelledby"?: string;
    "data-testid"?: string;
    [k: string]: unknown;
  }) =>
    React.createElement(
      "div",
      { role, "aria-labelledby": labelledBy, "data-testid": testId },
      children,
    );
  // prose-utils (real, for `hasContent`) pulls in the node-view modules,
  // which import Text from tamagui at module load.
  return { XStack: Stack, YStack: Stack, Text: Stack, styled: () => Stack };
});

vi.mock("@th/ui", async () => {
  const React = await import("react");
  return {
    Spinner: () => null,
    Text: ({ children, id }: { children?: ReactNode; id?: string }) =>
      React.createElement("span", { id }, children),
    Button: ({
      children,
      onPress,
      ...rest
    }: {
      children?: ReactNode;
      onPress?: () => void;
      [k: string]: unknown;
    }) =>
      React.createElement(
        "button",
        {
          onClick: onPress,
          "data-testid": rest["data-testid"],
          "data-variant": rest.variant,
          "data-suggested": rest["data-suggested"],
        },
        children,
      ),
    useTranslations: () => (key: string) => {
      const [ns, leaf] = key.split(".");
      const section = (en as Record<string, Record<string, string>>)[
        ns as string
      ];
      const v = section?.[leaf as string];
      if (typeof v !== "string") throw new Error(`missing message: ${key}`);
      return v;
    },
  };
});

vi.mock("../prose-editor", async () => {
  const React = await import("react");
  const utils = await vi.importActual<
    typeof import("../prose-editor/prose-utils")
  >("../prose-editor/prose-utils");
  function ProseEditor({
    initialContent,
    onReady,
  }: {
    initialContent?: ProseMirrorDoc | null;
    onReady?: (doc: ProseMirrorDoc) => void;
  }) {
    useEffect(() => {
      onReady?.(initialContent ?? { type: "doc", content: [] });
      // Fires once per mount, like TipTap's onCreate.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return React.createElement(
      "div",
      null,
      React.createElement(
        "pre",
        { "data-testid": "seed" },
        JSON.stringify(initialContent),
      ),
      React.createElement("div", {
        contentEditable: true,
        suppressContentEditableWarning: true,
        "data-testid": "editor",
      }),
    );
  }
  return { hasContent: utils.hasContent, ProseEditor };
});

const { BuilderDetailsSection } = await import("../BuilderDetailsSection");

const EMPTY: ProseMirrorDoc = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

function Harness({
  initial = EMPTY,
  isUploading = false,
  isUploadingAudio = false,
  suggestedStarter = null,
}: {
  suggestedStarter?: DescriptionStarterKind | null;
  initial?: ProseMirrorDoc;
  isUploading?: boolean;
  isUploadingAudio?: boolean;
}) {
  const [body, setBody] = useState<ProseMirrorDoc>(initial);
  return (
    <BuilderDetailsSection
      hasLoadedExisting
      bodyContent={body}
      onBodyChange={setBody}
      stickyTopOffset={0}
      onImageUpload={vi.fn()}
      imageUrlMap={{}}
      isUploading={isUploading}
      onAudioUpload={vi.fn()}
      audioUrlMap={{}}
      isUploadingAudio={isUploadingAudio}
      suggestedStarter={suggestedStarter}
    />
  );
}

describe("description starters", () => {
  it("offers the four starters as a group labelled 'Start from' while the description is empty", () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "Start from" });
    expect(group).toBeTruthy();
    for (const name of ["Open mic", "Comedy night", "Live music", "Other"]) {
      expect(screen.getByText(name)).toBeTruthy();
    }
  });

  it("treats a whitespace-only paragraph as empty", () => {
    render(
      <Harness
        initial={{
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "   " }] },
          ],
        }}
      />,
    );
    expect(screen.queryByTestId("description-starters")).not.toBeNull();
  });

  it("hides them when the description already has text", () => {
    render(
      <Harness
        initial={{
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Hi" }] },
          ],
        }}
      />,
    );
    expect(screen.queryByTestId("description-starters")).toBeNull();
  });

  it("hides them when the description is only an image", () => {
    render(
      <Harness
        initial={{
          type: "doc",
          content: [{ type: "imageBlock", attrs: { imageId: "img-1" } }],
        }}
      />,
    );
    expect(screen.queryByTestId("description-starters")).toBeNull();
  });

  it("hides them while an image upload is in flight", () => {
    render(<Harness isUploading />);
    expect(screen.queryByTestId("description-starters")).toBeNull();
  });

  it("hides them while an audio upload is in flight", () => {
    render(<Harness isUploadingAudio />);
    expect(screen.queryByTestId("description-starters")).toBeNull();
  });

  it("inserts the picked starter as paragraph + bullets, then hides the row", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("description-starter-OpenMic"));

    const seeded = JSON.parse(screen.getByTestId("seed").textContent ?? "");
    expect(seeded.content[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "[Describe the night in a sentence or two.]" },
      ],
    });
    expect(seeded.content[1].type).toBe("bulletList");
    expect(seeded.content[1].content).toHaveLength(5);
    expect(seeded.content[1].content[0]).toEqual({
      type: "listItem",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Sign-up: [time, and how: list at the door or online]",
            },
          ],
        },
      ],
    });
    expect(screen.queryByTestId("description-starters")).toBeNull();
  });

  it("moves focus into the remounted editor after a pick", async () => {
    render(<Harness />);
    const before = screen.getByTestId("editor");
    fireEvent.click(screen.getByTestId("description-starter-Comedy"));

    const after = screen.getByTestId("editor");
    expect(after).not.toBe(before);
    await waitFor(() => expect(document.activeElement).toBe(after));
  });

  it("does not steal focus on the first mount", async () => {
    render(<Harness />);
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    expect(document.activeElement).not.toBe(screen.getByTestId("editor"));
  });

  it.each([
    ["en", en],
    ["es", es],
  ] as const)("keeps every %s starter short and free of hype", (_, catalog) => {
    for (const kind of DESCRIPTION_STARTER_KINDS) {
      const a = catalog.admin as Record<string, string>;
      const text = `${a[`ebStarter${kind}Intro`]} ${a[`ebStarter${kind}Items`]}`;
      expect(text.split(/\s+/).length).toBeLessThan(60);
      expect(text).not.toContain("!");
      expect(text).not.toContain("¡");
      expect(text.toLowerCase()).not.toContain("venue");
    }
  });
});

describe("suggested starter", () => {
  const order = () =>
    screen
      .getAllByRole("button")
      .map((b) =>
        b.getAttribute("data-testid")?.replace("description-starter-", ""),
      );

  it("moves the suggested kind first, marks it, and lifts it above ghost", () => {
    render(<Harness suggestedStarter="Music" />);
    expect(order()).toEqual(["Music", "OpenMic", "Comedy", "Other"]);
    const first = screen.getByTestId("description-starter-Music");
    expect(first.getAttribute("data-suggested")).toBe("true");
    expect(first.getAttribute("data-variant")).toBe("secondary");
    for (const k of ["OpenMic", "Comedy", "Other"]) {
      const b = screen.getByTestId(`description-starter-${k}`);
      expect(b.getAttribute("data-suggested")).toBeNull();
      expect(b.getAttribute("data-variant")).toBe("ghost");
    }
  });

  it("keeps the original order, all ghost, with no suggestion", () => {
    render(<Harness suggestedStarter={null} />);
    expect(order()).toEqual(["OpenMic", "Comedy", "Music", "Other"]);
    for (const b of screen.getAllByRole("button")) {
      expect(b.getAttribute("data-variant")).toBe("ghost");
      expect(b.getAttribute("data-suggested")).toBeNull();
    }
  });

  it("inserts nothing until pressed, and a pick still seeds and remounts", () => {
    render(<Harness suggestedStarter="Comedy" />);
    expect(JSON.parse(screen.getByTestId("seed").textContent ?? "")).toEqual(
      EMPTY,
    );
    const before = screen.getByTestId("editor");
    fireEvent.click(screen.getByTestId("description-starter-Comedy"));
    expect(screen.getByTestId("editor")).not.toBe(before);
    const seeded = JSON.parse(screen.getByTestId("seed").textContent ?? "");
    expect(seeded.content[1].type).toBe("bulletList");
    expect(screen.queryByTestId("description-starters")).toBeNull();
  });
});

describe("resolveStarterCategory", () => {
  const categories = [
    { id: "m", slug: "music", name: "Music" },
    { id: "o", slug: "open-mics", name: "Open Mics" },
  ];
  const saved = { slug: "open-mics", name: "Open Mics" };

  it("community reads the unsaved picker id, not the saved category", () => {
    expect(
      resolveStarterCategory({
        isCommunity: true,
        pickerId: "m",
        categories,
        savedCategory: saved,
      }),
    ).toBe(categories[0]);
  });

  it("community with no pick or an unknown id resolves to null", () => {
    for (const pickerId of [null, "zzz"]) {
      expect(
        resolveStarterCategory({
          isCommunity: true,
          pickerId,
          categories,
          savedCategory: saved,
        }),
      ).toBeNull();
    }
  });

  it("owned reads the saved category and ignores the picker id", () => {
    expect(
      resolveStarterCategory({
        isCommunity: false,
        pickerId: "m",
        categories,
        savedCategory: saved,
      }),
    ).toBe(saved);
  });

  it("owned with no saved category resolves to null", () => {
    expect(
      resolveStarterCategory({
        isCommunity: false,
        pickerId: null,
        categories,
        savedCategory: null,
      }),
    ).toBeNull();
  });
});

describe("starterKindForCategory", () => {
  it.each([
    [{ slug: "music", name: "Music" }, "Music"],
    [{ slug: "open-mics", name: "Open Mics" }, "OpenMic"],
    [{ slug: "comedy", name: "Comedy" }, "Comedy"],
    [{ slug: "stand-up", name: "Stand-up" }, "Comedy"],
    [{ slug: "live-music", name: null }, "Music"],
    [{ slug: null, name: "Música en vivo" }, null],
    [{ slug: null, name: "Open Mic Night" }, "OpenMic"],
    [{ slug: "nightlife", name: "Nightlife" }, null],
    [{ slug: "food-drink", name: "Food & Drink" }, null],
    [{ slug: "other", name: "Other" }, null],
    [{ slug: "musicals", name: "Musicals" }, null],
    [{ slug: null, name: null }, null],
    [{}, null],
    [null, null],
  ] as const)("%j -> %s", (category, kind) => {
    expect(starterKindForCategory(category)).toBe(kind);
  });
});

describe("buildDescriptionStarterDoc with a blank translation", () => {
  const tWith = (overrides: Record<string, string>) => (key: string) =>
    key in overrides
      ? overrides[key]
      : (en.admin as Record<string, string>)[key.split(".")[1] as string];

  it("drops the paragraph when the intro is blank", () => {
    const doc = buildDescriptionStarterDoc(
      "Music",
      tWith({ "admin.ebStarterMusicIntro": "  " }),
    );
    expect(doc.content.map((n) => n.type)).toEqual(["bulletList"]);
  });

  it("drops the list when the items are blank", () => {
    const doc = buildDescriptionStarterDoc(
      "Music",
      tWith({ "admin.ebStarterMusicItems": "\n \n" }),
    );
    expect(doc.content.map((n) => n.type)).toEqual(["paragraph"]);
    expect(doc.content[0].content[0].text).toBe(
      "[Describe the night in a sentence or two.]",
    );
  });

  it("falls back to one empty paragraph when both are blank", () => {
    const doc = buildDescriptionStarterDoc(
      "Other",
      tWith({
        "admin.ebStarterOtherIntro": "",
        "admin.ebStarterOtherItems": "",
      }),
    );
    expect(doc).toEqual({ type: "doc", content: [{ type: "paragraph" }] });
  });
});

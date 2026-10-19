import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Page details card — the behaviours the IA rework is actually responsible
 * for, none of which the old flat stack had:
 *
 *  1. Four labelled groups in a fixed order (FR-003).
 *  2. The two save models are legible: images carry their own saved/saving
 *     state and a group badge, the Save button names what it covers (FR-004).
 *  3. The slug reads as ONE control — `/p/` is an inset on the input, the
 *     availability result is the input's own status, and the taken-slug error
 *     is inline and blocks Save (FR-005).
 *  4. Visibility helper copy tracks the selected option (FR-006).
 *  5. A picked file goes to the CROP dialog first, and the cropped file — not
 *     the original — is what reaches the upload hook. A GIF bypasses crop so
 *     animation survives.
 *
 * Mocks are enumerated, never a Proxy.
 */

const uploadBanner = vi.fn();
const uploadAvatar = vi.fn();
const persistMutate = vi.fn();
const updateMutate = vi.fn();

let slugQueryState: { isLoading: boolean; data?: { available: boolean } } = {
  isLoading: false,
};

// Props are FORWARDED, not dropped: the status/hint rows carry the `id` and
// `role` that `aria-describedby` points at, and a swallowing mock would let an
// inaccessible tree pass green.
vi.mock("tamagui", () => {
  const passthrough = ({
    children,
    ...rest
  }: { children?: ReactNode } & Record<string, unknown>) => (
    <div {...domProps(rest)}>{children}</div>
  );
  return { XStack: passthrough, YStack: passthrough };
});

/** Keep only real DOM attributes so React doesn't warn on Tamagui style props. */
function domProps(props: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(props)) {
    if (
      (key === "id" ||
        key === "role" ||
        key.startsWith("aria-") ||
        key.startsWith("data-")) &&
      typeof value === "string"
    ) {
      out[key] = value;
    }
  }
  return out;
}

vi.mock("@th/ui", () => ({
  CardSurface: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({
    children,
    id,
    color,
    ...rest
  }: {
    children?: ReactNode;
    id?: string;
    color?: string;
  } & Record<string, unknown>) => (
    <span id={id} data-color={color} {...domProps(rest)}>
      {children}
    </span>
  ),
  Spinner: () => <span role="progressbar" />,
  Button: ({
    children,
    onPress,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onPress?: () => void;
    disabled?: boolean;
  } & Record<string, unknown>) => (
    <button
      type="button"
      disabled={disabled}
      onClick={onPress}
      {...domProps(rest)}
    >
      {children}
    </button>
  ),
  LabeledTextInput: ({
    id,
    label,
    value,
    onChangeText,
    maxLength,
  }: {
    id?: string;
    label?: string;
    value?: string;
    onChangeText?: (v: string) => void;
    maxLength?: number;
  }) => (
    <label>
      {label}
      <input
        id={id}
        value={value ?? ""}
        maxLength={maxLength}
        onChange={(e) => onChangeText?.(e.target.value)}
      />
    </label>
  ),
  // The slug field. `prefix` / `prefixClearance` / `status` are the whole
  // point of FR-005, so the mock surfaces them as attributes to assert on.
  AmountInput: ({
    id,
    value,
    onChangeText,
    prefix,
    status,
    placeholder,
    ...rest
  }: {
    id?: string;
    value?: string;
    onChangeText?: (v: string) => void;
    prefix?: string;
    status?: string;
    placeholder?: string;
  } & Record<string, unknown>) => (
    <input
      id={id}
      data-prefix={prefix}
      data-status={status ?? ""}
      placeholder={placeholder}
      aria-describedby={rest["aria-describedby"] as string | undefined}
      value={value ?? ""}
      onChange={(e) => onChangeText?.(e.target.value)}
    />
  ),
  StyledSelect: ({
    value,
    options,
    onChange,
    selectId,
    ariaDescribedBy,
  }: {
    value?: string;
    options?: { value: string; label: string }[];
    onChange?: (v: string) => void;
    selectId?: string;
    ariaDescribedBy?: string;
  }) => (
    <select
      id={selectId}
      aria-describedby={ariaDescribedBy}
      value={value}
      onChange={(e) => onChange?.(e.target.value)}
    >
      {(options ?? []).map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
  useNotify: () => ({
    toast: { success: vi.fn(), danger: vi.fn(), info: vi.fn() },
  }),
  // Raw-key translator: assertions read the key, so a missing key can never
  // masquerade as passing copy.
  useTranslations: () => (key: string) => key,
}));

vi.mock("lucide-react", () => ({
  Save: () => <span />,
  Check: () => <span />,
  Upload: () => <span />,
  Trash2: () => <span />,
  Maximize2: () => <span />,
}));

vi.mock("@/components/media/ImageLightbox", () => ({
  ImageLightbox: () => null,
}));

vi.mock("../ImageCropDialog", () => ({
  ImageCropDialog: ({
    file,
    aspect,
    onCropped,
  }: {
    file: File | null;
    aspect: number;
    onCropped: (f: File) => void;
  }) =>
    file ? (
      <div data-testid="crop-dialog" data-aspect={String(aspect)}>
        <button
          type="button"
          onClick={() =>
            onCropped(new File(["cropped"], "cropped.jpg", { type: "image/jpeg" }))
          }
        >
          apply-crop
        </button>
      </div>
    ) : null,
}));

vi.mock("../use-page-image-upload", () => ({
  PAGE_IMAGE_UPLOAD_ACCEPT: "image/jpeg",
  NativeFileInput: (props: ComponentProps<"input">) => <input {...props} />,
  usePageImageUpload: () => {
    // One hook instance per control; the component creates banner first.
    const next = usePageImageUploadCalls++ % 2 === 0 ? uploadBanner : uploadAvatar;
    return { upload: next, isUploading: false };
  },
}));

let usePageImageUploadCalls = 0;

vi.mock("@/trpc", () => ({
  trpc: {
    useUtils: () => ({
      entityPages: { getMyPage: { invalidate: vi.fn() } },
    }),
    entityPages: {
      updatePage: {
        useMutation: (opts?: unknown) => {
          const isPersist = persistOptsSeen++ % 2 === 0;
          void opts;
          return {
            mutate: isPersist ? persistMutate : updateMutate,
            // The text-field save awaits `mutateAsync` (so a host's `saveAll`
            // settles with the request); it records into the same spy.
            mutateAsync: (input: unknown) => {
              (isPersist ? persistMutate : updateMutate)(input);
              return Promise.resolve();
            },
            isPending: false,
          };
        },
      },
      isSlugAvailable: {
        useQuery: () => slugQueryState,
      },
    },
  },
}));

let persistOptsSeen = 0;

import { PageFieldsEditor } from "../PageFieldsEditor";
import {
  PageSettingsSaveProvider,
  usePageSettingsSave,
} from "../page-settings-save";

const page = {
  id: "page_1",
  slug: "demo",
  displayName: "Demo Org",
  bio: "hello",
  avatarUrl: "https://cdn.example/a.png",
  bannerUrl: null,
  visibility: "PUBLIC" as const,
};

/**
 * Mirrors the toolbar's read of the save registry, so these tests can assert
 * what the real Save button does without mounting the whole editor. The form's
 * own Save button moved to `PageEditorView`'s toolbar on 2026-08-30; what the
 * form still owns is the REGISTRATION, including the taken-slug block.
 */
let saveState: ReturnType<typeof usePageSettingsSave> | null = null;

function SaveProbe() {
  saveState = usePageSettingsSave();
  return null;
}

type OwnerType = "HUMAN" | "ORGANIZATION" | "PLACE";

function renderEditor(
  overrides: Partial<typeof page> = {},
  ownerType: OwnerType = "ORGANIZATION",
  placeNameHint?: string,
) {
  usePageImageUploadCalls = 0;
  persistOptsSeen = 0;
  saveState = null;
  return render(
    <PageSettingsSaveProvider>
      <PageFieldsEditor
        page={{ ...page, ...overrides }}
        ownerType={ownerType}
        ownerId={ownerType === "PLACE" ? "place_1" : "org_1"}
        placeNameHint={placeNameHint}
      />
      <SaveProbe />
    </PageSettingsSaveProvider>,
  );
}

const displayNameInput = () =>
  document.getElementById("entity-page-display-name") as HTMLInputElement | null;

beforeEach(() => {
  vi.clearAllMocks();
  slugQueryState = { isLoading: false };
});

describe("PageFieldsEditor — grouping (FR-003)", () => {
  it("renders the four subsection headings in Identity → Images → Bio → Visibility order", () => {
    const { container } = renderEditor();
    const text = container.textContent ?? "";
    const order = [
      "admin.peGroupIdentity",
      "admin.peGroupImages",
      "admin.peGroupBio",
      "admin.peGroupVisibility",
    ].map((key) => text.indexOf(key));

    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe("PageFieldsEditor — save-model legibility (FR-004)", () => {
  it("badges the image group as auto-saving and names what the Save button covers", () => {
    const { container } = renderEditor();
    expect(container.textContent).toContain("admin.peImagesAutoSaveBadge");
    expect(container.textContent).toContain("admin.peManualSaveHint");
  });

  it("marks an already-uploaded image as saved and an empty slot as neither", () => {
    const { container } = renderEditor({ avatarUrl: "https://cdn/x.png", bannerUrl: null });
    // Exactly one slot has an image, so exactly one "Saved" status appears.
    const saved = (container.textContent ?? "").match(
      /admin\.peImageSavedStatus/g,
    );
    expect(saved).toHaveLength(1);
  });
});

describe("PageFieldsEditor — slug field (FR-005)", () => {
  it("renders /p/ as an inset on the input rather than a sibling label", () => {
    renderEditor();
    const input = document.getElementById("entity-page-slug");
    expect(input?.getAttribute("data-prefix")).toBe("/p/");
  });

  it("shows the checking state inline while availability resolves", () => {
    slugQueryState = { isLoading: true };
    renderEditor();
    fireEvent.change(document.getElementById("entity-page-slug")!, {
      target: { value: "new-slug" },
    });
    const status = document.getElementById("entity-page-slug-status")!;
    expect(status.textContent).toContain("admin.peSlugChecking");
  });

  it("drives the input's own status to success when the slug is free", () => {
    slugQueryState = { isLoading: false, data: { available: true } };
    renderEditor();
    const input = document.getElementById("entity-page-slug")!;
    fireEvent.change(input, { target: { value: "free-slug" } });
    expect(input.getAttribute("data-status")).toBe("success");
    expect(
      document.getElementById("entity-page-slug-status")!.textContent,
    ).toContain("admin.peSlugAvailable");
  });

  it("puts the taken-slug error inline in the field's own status row and blocks Save", () => {
    slugQueryState = { isLoading: false, data: { available: false } };
    renderEditor();
    const input = document.getElementById("entity-page-slug")!;
    fireEvent.change(input, { target: { value: "taken-slug" } });

    expect(input.getAttribute("data-status")).toBe("error");
    const status = document.getElementById("entity-page-slug-status")!;
    expect(status.textContent).toContain("admin.peSlugTaken");
    // The form is dirty but must not be savable: the toolbar reads `isBlocked`
    // and refuses. Asserting the aggregate (not a local button) is the point —
    // it is the same value the real Save button disables on.
    expect(saveState?.isDirty).toBe(true);
    expect(saveState?.isBlocked).toBe(true);
  });

  it("registers a savable form once the slug is free", () => {
    slugQueryState = { isLoading: false, data: { available: true } };
    renderEditor();
    fireEvent.change(document.getElementById("entity-page-slug")!, {
      target: { value: "free-slug" },
    });

    expect(saveState?.isDirty).toBe(true);
    expect(saveState?.isBlocked).toBe(false);
  });

  it("registers nothing to save while the form is untouched", () => {
    renderEditor();

    expect(saveState?.isDirty).toBe(false);
  });

  it("wires the status row to the input via aria-describedby", () => {
    renderEditor();
    expect(
      document.getElementById("entity-page-slug")!.getAttribute("aria-describedby"),
    ).toBe("entity-page-slug-status");
  });
});

describe("PageFieldsEditor — bio counter", () => {
  it("counts against the real 2000-char server limit", () => {
    renderEditor({ bio: "abc" });
    expect(screen.getByTestId("entity-page-bio-counter").textContent).toBe(
      "3 / 2000",
    );
  });

  it("caps typing at the server limit via maxLength", () => {
    renderEditor();
    expect(
      document.getElementById("entity-page-bio")!.getAttribute("maxlength"),
    ).toBe("2000");
  });
});

describe("PageFieldsEditor — visibility hint (FR-006)", () => {
  it("shows the hint for the selected option and swaps it on change", () => {
    renderEditor({ visibility: "PUBLIC" });
    const hint = () =>
      document.getElementById("entity-page-visibility-hint")!.textContent;

    expect(hint()).toBe("admin.peVisibilityPublicHint");

    fireEvent.change(document.getElementById("entity-page-visibility")!, {
      target: { value: "PRIVATE" },
    });
    expect(hint()).toBe("admin.peVisibilityPrivateHint");
  });

  it("describes the select with the hint", () => {
    renderEditor();
    expect(
      document
        .getElementById("entity-page-visibility")!
        .getAttribute("aria-describedby"),
    ).toBe("entity-page-visibility-hint");
  });
});

describe("PageFieldsEditor — crop step (FR-001)", () => {
  const pick = (inputId: string, file: File) => {
    const input = document.getElementById(inputId) as HTMLInputElement;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    fireEvent.change(input);
  };

  it("routes a picked avatar through the crop dialog at 1:1 before uploading", () => {
    renderEditor();
    pick(
      "entity-page-avatar-upload",
      new File(["x"], "a.png", { type: "image/png" }),
    );

    const dialog = screen.getByTestId("crop-dialog");
    expect(dialog.getAttribute("data-aspect")).toBe("1");
    // Nothing is uploaded until the user applies the crop.
    expect(uploadAvatar).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByText("apply-crop"));

    expect(uploadAvatar).toHaveBeenCalledTimes(1);
    const uploaded = uploadAvatar.mock.calls[0]![0] as File;
    expect(uploaded.name).toBe("cropped.jpg");
  });

  it("uses the banner's 3:1 aspect for the banner slot", () => {
    renderEditor();
    pick(
      "entity-page-banner-upload",
      new File(["x"], "b.jpg", { type: "image/jpeg" }),
    );
    expect(screen.getByTestId("crop-dialog").getAttribute("data-aspect")).toBe(
      "3",
    );
  });

  it("uploads a GIF as picked so animation survives", () => {
    renderEditor();
    pick(
      "entity-page-avatar-upload",
      new File(["x"], "a.gif", { type: "image/gif" }),
    );

    expect(screen.queryByTestId("crop-dialog")).toBeNull();
    expect(uploadAvatar).toHaveBeenCalledTimes(1);
    expect((uploadAvatar.mock.calls[0]![0] as File).name).toBe("a.gif");
  });
});


/**
 * A venue has ONE name — `Place.name`, edited on the venue details form. On a
 * PLACE page `displayName` is therefore no longer a field. The column stays in
 * the database and must stay INTACT, so the load-bearing assertion here is the
 * payload one: a PLACE save that carried `displayName: ""` would normalise to
 * null and blank a live column, which is what would make this ruling
 * irreversible.
 *
 * HUMAN and ORGANIZATION keep the field and every behaviour it had. Those are
 * the regression guards and they matter more than the new cases.
 */
describe("PageFieldsEditor — display name is not a PLACE field", () => {
  const dirtyTheSlug = () =>
    fireEvent.change(document.getElementById("entity-page-slug")!, {
      target: { value: "new-slug" },
    });

  it("renders no display-name input for a PLACE", () => {
    const { container } = renderEditor({}, "PLACE");

    expect(displayNameInput()).toBeNull();
    expect(container.textContent).not.toContain("admin.peDisplayNameLabel");
  });

  it("puts a labelled read-only line where the field was, naming the place details form", () => {
    const { container } = renderEditor({}, "PLACE");

    expect(container.textContent).toContain("admin.peVenueNameLabel");
    expect(container.textContent).toContain("admin.peVenueNameFromDetails");
  });

  it("a placeNameHint replaces the owner's sentence (the moderator editor)", () => {
    const { container } = renderEditor({}, "PLACE", "Change it at the top.");

    expect(container.textContent).toContain("admin.peVenueNameLabel");
    expect(container.textContent).toContain("Change it at the top.");
    expect(container.textContent).not.toContain("admin.peVenueNameFromDetails");
  });

  it("an empty placeNameHint shows the label and no sentence", () => {
    const { container } = renderEditor({}, "PLACE", "");

    expect(container.textContent).toContain("admin.peVenueNameLabel");
    expect(container.textContent).not.toContain("admin.peVenueNameFromDetails");
  });

  it("names only the fields it can save, dropping Name from the hint", () => {
    const { container } = renderEditor({}, "PLACE");

    expect(container.textContent).toContain("admin.peManualSaveHintNoName");
    // `peManualSaveHintNoName` CONTAINS `peManualSaveHint`, so a substring
    // check here would pass on the very string it is meant to exclude.
    expect(container.textContent).not.toMatch(/admin\.peManualSaveHint\b/);
  });

  it("never sends a displayName key in a PLACE save payload", async () => {
    slugQueryState = { isLoading: false, data: { available: true } };
    renderEditor({ displayName: "Stored Venue Name" }, "PLACE");
    dirtyTheSlug();

    await saveState!.saveAll();

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const payload = updateMutate.mock.calls[0]![0] as Record<string, unknown>;
    // `in` — not a truthiness check. `displayName: ""` and `displayName: null`
    // are exactly the values that would blank the stored column, and both of
    // them are falsy.
    expect("displayName" in payload).toBe(false);
    expect(payload).toEqual({
      ownerType: "PLACE",
      ownerId: "place_1",
      slug: "new-slug",
    });
  });

  it("does not arm Save from a stored display name the owner cannot see", () => {
    renderEditor({ displayName: "Stored Venue Name" }, "PLACE");

    expect(saveState?.isDirty).toBe(false);
  });

  it("keeps a PLACE save clean when only the bio changes", async () => {
    renderEditor({ displayName: "Stored Venue Name" }, "PLACE");
    fireEvent.change(document.getElementById("entity-page-bio")!, {
      target: { value: "new bio" },
    });

    expect(saveState?.isDirty).toBe(true);
    await saveState!.saveAll();

    const payload = updateMutate.mock.calls[0]![0] as Record<string, unknown>;
    expect("displayName" in payload).toBe(false);
    expect(payload.bio).toBe("new bio");
  });
});

describe.each(["HUMAN", "ORGANIZATION"] as const)(
  "PageFieldsEditor — %s keeps its display name (regression guard)",
  (ownerType) => {
    it("still renders the field, seeded from the stored value", () => {
      const { container } = renderEditor({ displayName: "Stored Name" }, ownerType);

      expect(displayNameInput()?.value).toBe("Stored Name");
      expect(container.textContent).toContain("admin.peDisplayNameLabel");
      expect(container.textContent).toMatch(/admin\.peManualSaveHint\b/);
      expect(container.textContent).not.toContain("admin.peManualSaveHintNoName");
    });

    it("still arms Save when the display name is edited", () => {
      renderEditor({ displayName: "Stored Name" }, ownerType);
      fireEvent.change(displayNameInput()!, { target: { value: "Edited Name" } });

      expect(saveState?.isDirty).toBe(true);
    });

    it("still carries displayName in the save payload", async () => {
      renderEditor({ displayName: "Stored Name" }, ownerType);
      fireEvent.change(displayNameInput()!, { target: { value: "Edited Name" } });
      await saveState!.saveAll();

      const payload = updateMutate.mock.calls[0]![0] as Record<string, unknown>;
      expect(payload.displayName).toBe("Edited Name");
      expect(payload.ownerType).toBe(ownerType);
    });

    it("still nulls the column when the owner clears the field", async () => {
      renderEditor({ displayName: "Stored Name" }, ownerType);
      fireEvent.change(displayNameInput()!, { target: { value: "  " } });
      await saveState!.saveAll();

      const payload = updateMutate.mock.calls[0]![0] as Record<string, unknown>;
      expect("displayName" in payload).toBe(true);
      expect(payload.displayName).toBeNull();
    });
  },
);

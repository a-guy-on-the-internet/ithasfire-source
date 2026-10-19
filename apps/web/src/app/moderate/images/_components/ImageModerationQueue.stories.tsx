import React from "react";
import type { Meta, StoryObj, Decorator } from "@storybook/react";

import { TranslationProvider } from "@th/ui";
import type { Messages } from "@th/ui";

import enPackage from "@th/locale/messages/en.json";
import enApp from "../../../../i18n/messages/en";

import {
  ImageModerationQueueView,
  type FlaggedImageItem,
  type ImageModerationQueueViewProps,
} from "./ImageModerationQueueView";

// ─────────────────────────────────────────────────────────────────────────────
// i18n — mirror CheckoutContent.stories: merge the shared @th/locale catalog
// with the web app's message overrides so real English copy renders.
// ─────────────────────────────────────────────────────────────────────────────

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

const withTranslations: Decorator = (Story) => (
  <TranslationProvider locale="en" messages={messages}>
    <div style={{ maxWidth: 960, margin: "0 auto", padding: 24 }}>
      <Story />
    </div>
  </TranslationProvider>
);

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — BENIGN solid-colour SVG previews only. NEVER real/explicit imagery;
// these are inline data URIs so the demo needs no network, storage, or R2.
// ─────────────────────────────────────────────────────────────────────────────

/** A flat colour square as an inline SVG data URI (no base64, plainly benign). */
const svgSquare = (color: string): string =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="${color}"/></svg>`,
  )}`;

const FLAGGED_AT = "2026-07-06T15:04:00.000Z";

const SAMPLE_ITEMS: FlaggedImageItem[] = [
  {
    recordId: "img-1",
    publicUrl: svgSquare("#7c3aed"),
    kind: "EVENT_HERO",
    subjectType: "EVENT",
    subjectId: "evt-sexual-severe",
    maxSeverity: 6,
    categories: [
      { category: "SEXUAL", severity: 6 },
      { category: "VIOLENCE", severity: 0 },
      { category: "HATE", severity: 0 },
      { category: "SELF_HARM", severity: 0 },
    ],
    degraded: false,
    moderatedAt: FLAGGED_AT,
    reviewNote: null,
  },
  {
    recordId: "img-2",
    publicUrl: svgSquare("#0ea5e9"),
    kind: "BANNER",
    subjectType: "EVENT",
    subjectId: "evt-violence-high",
    maxSeverity: 4,
    categories: [
      { category: "VIOLENCE", severity: 4 },
      { category: "SEXUAL", severity: 0 },
      { category: "HATE", severity: 2 },
      { category: "SELF_HARM", severity: 0 },
    ],
    degraded: false,
    moderatedAt: FLAGGED_AT,
    reviewNote: null,
  },
  {
    recordId: "img-3",
    publicUrl: svgSquare("#f59e0b"),
    kind: "PAGE_MEDIA",
    subjectType: "EVENT",
    subjectId: "evt-degraded",
    maxSeverity: null,
    // Auto-scan failed: no categories, degraded marker shown.
    categories: [],
    degraded: true,
    moderatedAt: FLAGGED_AT,
    reviewNote: null,
  },
  {
    recordId: "img-4",
    publicUrl: null,
    kind: "AVATAR",
    subjectType: "EVENT",
    subjectId: "evt-no-preview",
    maxSeverity: 2,
    categories: [
      { category: "SEXUAL", severity: 2 },
      { category: "VIOLENCE", severity: 0 },
      { category: "HATE", severity: 0 },
      { category: "SELF_HARM", severity: 0 },
    ],
    degraded: false,
    moderatedAt: FLAGGED_AT,
    reviewNote: null,
  },
];

// All callbacks are no-ops for the visual demo. onReview resolves so the inline
// panel closes on approve/reject just like the real success path.
const NOOP_CALLBACKS: Pick<
  ImageModerationQueueViewProps,
  "onRetry" | "onLoadMore" | "onReview"
> = {
  onRetry: () => {},
  onLoadMore: () => {},
  onReview: () => Promise.resolve(),
};

const BASE_FLAGS: Omit<
  ImageModerationQueueViewProps,
  "items" | "onRetry" | "onLoadMore" | "onReview"
> = {
  isLoading: false,
  isError: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  isReviewPending: false,
};

// ─────────────────────────────────────────────────────────────────────────────
// Meta
// ─────────────────────────────────────────────────────────────────────────────

const meta: Meta<typeof ImageModerationQueueView> = {
  title: "Moderation/ImageModerationQueue",
  component: ImageModerationQueueView,
  decorators: [withTranslations],
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof ImageModerationQueueView>;

// ─────────────────────────────────────────────────────────────────────────────
// Stories
// ─────────────────────────────────────────────────────────────────────────────

/** Four flagged items with varied signals: severe SEXUAL, high VIOLENCE, an
 *  auto-scan-failed (degraded) item, and a no-preview placeholder. */
export const Default: Story = {
  args: {
    items: SAMPLE_ITEMS,
    ...BASE_FLAGS,
    ...NOOP_CALLBACKS,
  },
};

/** Same items with a live "Load more" affordance. */
export const WithLoadMore: Story = {
  args: {
    items: SAMPLE_ITEMS,
    ...BASE_FLAGS,
    hasNextPage: true,
    ...NOOP_CALLBACKS,
  },
};

/** Nothing left to triage — the empty band. */
export const Empty: Story = {
  args: {
    items: [],
    ...BASE_FLAGS,
    ...NOOP_CALLBACKS,
  },
};

/** Initial page still loading — the spinner band. */
export const Loading: Story = {
  args: {
    items: [],
    ...BASE_FLAGS,
    isLoading: true,
    ...NOOP_CALLBACKS,
  },
};

/** List query failed — the retry band. */
export const Error: Story = {
  args: {
    items: [],
    ...BASE_FLAGS,
    isError: true,
    ...NOOP_CALLBACKS,
  },
};

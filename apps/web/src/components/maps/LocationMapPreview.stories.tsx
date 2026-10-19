import type { Meta, StoryObj } from "@storybook/react";

import { LocationMapPreview } from "./LocationMapPreview";

const meta: Meta<typeof LocationMapPreview> = {
  title: "Maps/LocationMapPreview",
  component: LocationMapPreview,
  parameters: {
    layout: "padded",
  },
  argTypes: {
    isExact: { control: "boolean" },
    radiusMeters: {
      control: { type: "range", min: 100, max: 5000, step: 100 },
    },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 400 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof LocationMapPreview>;

/** Exact pin marker — default mode for public events with precise address. */
export const ExactPin: Story = {
  args: {
    latitude: 37.8738,
    longitude: -122.2543,
    label: "Greek Theatre, Berkeley",
    isExact: true,
  },
};

/** Obfuscation radius circle — used when locationMode is OBSCURED (with a radius). */
export const ObscuredRadius: Story = {
  args: {
    latitude: 40.7484,
    longitude: -73.9856,
    label: null,
    isExact: false,
    radiusMeters: 800,
  },
};

/**
 * Server-obfuscated centre (public event page): the coordinates are already
 * the offset point from `redactLocation`, so the circle is drawn on them
 * directly with no additional client-side jitter.
 */
export const ObscuredRadiusPreObfuscated: Story = {
  args: {
    latitude: 40.7484,
    longitude: -73.9856,
    label: null,
    isExact: false,
    radiusMeters: 800,
    preObfuscated: true,
  },
};

/** Large radius (2 km) — e.g. "general area" disclosure. */
export const LargeRadius: Story = {
  args: {
    latitude: 34.0522,
    longitude: -118.2437,
    label: null,
    isExact: false,
    radiusMeters: 2000,
  },
};

/** Small radius (200 m) — tighter approximate zone. */
export const SmallRadius: Story = {
  args: {
    latitude: 51.5074,
    longitude: -0.1278,
    label: null,
    isExact: false,
    radiusMeters: 200,
  },
};

/** No coordinates provided — shows fallback message. */
export const NoCoordinates: Story = {
  args: {
    latitude: null,
    longitude: null,
  },
};

/** Custom missing message. */
export const CustomMissingMessage: Story = {
  args: {
    latitude: null,
    longitude: null,
    missingMessage: "Event location will be announced soon",
  },
};

/** Exact location — Paris, France. */
export const ParisExact: Story = {
  args: {
    latitude: 48.8566,
    longitude: 2.3522,
    label: "Paris, France",
    isExact: true,
  },
};

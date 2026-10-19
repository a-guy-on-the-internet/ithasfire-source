"use client";

import { LoadingIndicator } from "@th/ui";

export default function AdminSegmentLoading() {
  return (
    <LoadingIndicator
      label={null}
      size="lg"
      width="100%"
      minHeight={320}
      paddingVertical="$8"
      qaId="admin-segment-loading"
      testID="admin-segment-loading"
    />
  );
}

"use client";

import { YStack } from "tamagui";
import { INPUT_STYLE, MAX, ERROR_RED } from "../_shared/tokens";
import type { ScreenDef } from "../_shared/types";
import { TrustLine } from "../_primitives/TrustLine";

// ─────────────────────────────────────────────────────────────────────────────
// Connect screens (18–19): anonymousName, anonymousEmail
// ─────────────────────────────────────────────────────────────────────────────

export const CONNECT_SCREENS: ScreenDef[] = [
  {
    id: "connectName",
    phase: "connect",
    question: "What's your name?",
    helper: "Optional. Never connected to your review.",
    render: (d, onChange) => (
      <input
        type="text"
        aria-label="Your name"
        autoComplete="name"
        enterKeyHint="next"
        value={d.anonymousName}
        onChange={(e) => onChange({ anonymousName: e.target.value })}
        placeholder="Your name…"
        maxLength={MAX.NAME}
        style={INPUT_STYLE}
      />
    ),
  },

  {
    id: "connectEmail",
    phase: "connect",
    question: "Want to know when Ithas Fire launches?",
    helper: "We'll let you know when place reviews go live. No spam. Ever.",
    validate: (d) => {
      if (
        d.anonymousEmail &&
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.anonymousEmail)
      )
        return "Invalid email address";
      return undefined;
    },
    render: (d, onChange, error) => (
      <YStack gap={16}>
        <input
          type="email"
          aria-label="Email address"
          aria-invalid={!!error}
          autoComplete="email"
          enterKeyHint="done"
          value={d.anonymousEmail}
          onChange={(e) => onChange({ anonymousEmail: e.target.value })}
          placeholder="you@email.com"
          style={{
            ...INPUT_STYLE,
            ...(error ? { borderColor: ERROR_RED } : {}),
          }}
        />
        <TrustLine>
          Your email is only for the waitlist. It&apos;s{" "}
          <strong style={{ color: "#FFFFFF", fontWeight: 800 }}>never</strong>{" "}
          connected to your review.
        </TrustLine>
      </YStack>
    ),
  },
];

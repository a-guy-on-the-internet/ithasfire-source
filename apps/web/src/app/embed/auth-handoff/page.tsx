"use client";

import { useEffect, useRef, useState } from "react";
import { Spinner } from "@th/ui";

import { authClient } from "@/lib/auth/auth-client";
import {
  EMBED_AUTH_HANDOFF_PATH,
  EMBED_AUTH_MESSAGE_TYPE,
} from "@/lib/embed-auth-handoff";
import { useIsFramed } from "@/app/embed/[embedId]/_components/useIsFramed";
import { TEXT_CAPTION } from "@/app/embed/[embedId]/_components/embed-theme";

type HandoffState =
  | "checking" // session still resolving / redirecting to sign-in
  | "minting" // signed in, minting the bearer JWT
  | "done" // token posted; window should have closed itself
  | "framed" // defense: refused to run inside an iframe
  | "noOpener" // opened directly (no window.opener) — nothing to hand off to
  | "error"; // token mint failed

/**
 * First-party auth-handoff popup for the booking embed
 * (spec 2026-07-13 booking-request-embed-button FR-010).
 *
 * SECURITY (see also `@/lib/embed-auth-handoff`):
 * - Runs ONLY as a top-level popup — refuses to operate framed.
 * - Mints the short-lived Better Auth JWT via `authClient.token()` (the
 *   existing GET /api/auth/token path, first-party cookies).
 * - Posts `{ type: "hf:auth-token", token }` to `window.opener` with
 *   `targetOrigin` pinned to OUR OWN origin exactly — never "*". If a
 *   hostile site opened this popup, its opener document is not on our
 *   origin and the browser drops the message.
 * - The raw token never appears in URLs, storage, or logs.
 */
export default function EmbedAuthHandoffPage() {
  const framed = useIsFramed();
  const { data: session, isPending } = authClient.useSession();
  const [state, setState] = useState<HandoffState>("checking");
  const startedRef = useRef(false);

  useEffect(() => {
    if (framed) {
      setState("framed");
      return;
    }
    if (isPending || startedRef.current) return;

    if (!session?.user) {
      // Complete sign-in first-party, then land back here to finish the
      // handoff. `redirect` is sanitized to a same-origin path by /sign-in.
      //
      // A HARD navigation on purpose: /embed/* renders under the embed route
      // context (forced light theme, transparent `<body data-th-embed>`),
      // which the root layout resolves per REQUEST. A soft `router.replace`
      // never re-renders the root layout, so /sign-in inside this popup kept
      // the embed body. `location.replace` also keeps the back button off
      // this interstitial, as the old router.replace did.
      window.location.replace(
        `/sign-in?redirect=${encodeURIComponent(EMBED_AUTH_HANDOFF_PATH)}`,
      );
      return;
    }

    startedRef.current = true;
    let cancelled = false;
    void (async () => {
      setState("minting");
      let token: string | null = null;
      try {
        const { data, error } = await authClient.token();
        if (!error && typeof data?.token === "string" && data.token.length > 0) {
          token = data.token;
        }
      } catch {
        // fall through to the error state
      }
      if (cancelled) return;
      if (!token) {
        setState("error");
        return;
      }

      const opener: Window | null = window.opener ?? null;
      if (!opener || opener.closed) {
        setState("noOpener");
        return;
      }

      // targetOrigin pinned to our exact origin — never "*".
      opener.postMessage(
        { type: EMBED_AUTH_MESSAGE_TYPE, token },
        window.location.origin,
      );
      setState("done");
      window.close();
    })();
    return () => {
      cancelled = true;
    };
  }, [framed, isPending, session?.user]);

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: "40px 24px",
        textAlign: "center",
      }}
    >
      {(state === "checking" || state === "minting") && (
        <>
          <Spinner size="md" indicatorColor={TEXT_CAPTION} />
          <Copy title="Connecting your account">
            One moment — confirming you're signed in.
          </Copy>
        </>
      )}
      {state === "done" && (
        <Copy title="You're signed in">
          Returning you to the booking form. You can close this window.
        </Copy>
      )}
      {state === "framed" && (
        <Copy title="Unavailable here">
          This page can't run inside an embedded frame.
        </Copy>
      )}
      {state === "noOpener" && (
        <Copy title="Nothing to connect">
          This window was opened directly. Close it and use the log-in button
          on the booking form instead.
        </Copy>
      )}
      {state === "error" && (
        <Copy title="Couldn't confirm your session">
          Close this window and try logging in from the booking form again.
        </Copy>
      )}
    </main>
  );
}

function Copy({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <h1
        style={{
          margin: 0,
          fontSize: 15,
          fontWeight: 700,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {title}
      </h1>
      <p
        style={{
          margin: 0,
          maxWidth: 340,
          fontSize: 14,
          lineHeight: 1.6,
          opacity: 0.75,
        }}
      >
        {children}
      </p>
    </div>
  );
}

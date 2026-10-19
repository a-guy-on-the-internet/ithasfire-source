"use client";

import { useState, type CSSProperties, type FormEvent } from "react";
import { Check, ArrowRight } from "lucide-react";
import { Button, Text } from "@th/ui";
import { YStack } from "tamagui";
import { ACCENT } from "@/lib/design-tokens";
import Link from "next/link";
import { FG, MUTED, SPRING_EASE, INPUT_STYLE } from "../_shared/tokens";

// ─────────────────────────────────────────────────────────────────────────────
// SuccessScreen — confetti burst + stats after submission
// ─────────────────────────────────────────────────────────────────────────────

interface SuccessScreenProps {
  onReset: () => void;
  venuesRated: number;
  contributors: number;
  email?: string;
  onEmailSubmit?: (email: string) => Promise<void>;
  variant?: "page" | "embedded";
}

export function SuccessScreen({
  onReset,
  venuesRated,
  contributors,
  email,
  onEmailSubmit,
  variant = "embedded",
}: SuccessScreenProps) {
  const [localEmail, setLocalEmail] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [emailError, setEmailError] = useState(false);

  const handleEmailSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = localEmail.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return;
    if (submitting || submitted) return;
    setSubmitting(true);
    setEmailError(false);
    try {
      await onEmailSubmit?.(trimmed);
      setSubmitted(true);
    } catch {
      setEmailError(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <YStack
      alignItems="center"
      justifyContent="center"
      padding={40}
      gap={20}
      minHeight={300}
      role="status"
      aria-live="polite"
    >
      {/* Confetti burst — 12 particles radiating outward */}
      <div
        style={{ position: "relative", width: 56, height: 56 }}
        aria-hidden="true"
      >
        {Array.from({ length: 12 }).map((_, i) => {
          const colors = [ACCENT, "#35589A", FG, ACCENT, "#35589A"];
          const size = i % 3 === 0 ? 6 : 4;
          return (
            <div
              key={i}
              className={`confetti-${i}`}
              style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                width: size,
                height: size,
                marginLeft: -size / 2,
                marginTop: -size / 2,
                background: colors[i % colors.length],
                opacity: 0,
                animation: `confetti-p${i} 700ms ${80 + i * 25}ms ${SPRING_EASE} forwards`,
              }}
            />
          );
        })}
        <div
          style={{
            position: "relative",
            zIndex: 1,
            width: 56,
            height: 56,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: `3px solid ${ACCENT}`,
            color: ACCENT,
            animation: `successPop 500ms ${SPRING_EASE}`,
          }}
        >
          <Check size={28} />
        </div>
      </div>
      <Text
        variant="h3"
        weight="bold"
        color="$color"
        margin={0}
        style={
          {
            animation: `fadeSlideUp 400ms 200ms ${SPRING_EASE} both`,
          } as CSSProperties
        }
      >
        THANK YOU
      </Text>
      <Text
        variant="body"
        color="$colorMuted"
        margin={0}
        textAlign="center"
        style={
          {
            animation: `fadeSlideUp 400ms 320ms ${SPRING_EASE} both`,
          } as CSSProperties
        }
      >
        Your review helps every performer who plays next.
      </Text>

      {/* Email CTA — only rendered when email exists or onEmailSubmit provided */}
      {(email || onEmailSubmit) && (
        <div
          style={{
            animation: `fadeSlideUp 400ms 380ms ${SPRING_EASE} both`,
            width: "100%",
            maxWidth: 360,
            textAlign: "center",
          }}
        >
          {email ? (
            <div style={{ color: MUTED, fontSize: 13 }}>
              We&rsquo;ll let you know at{" "}
              <span style={{ color: FG }}>{email}</span> when we launch.
            </div>
          ) : submitted ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 6,
                color: ACCENT,
                fontSize: 14,
                fontWeight: 700,
              }}
            >
              <Check size={16} />
              You&rsquo;re on the list!
            </div>
          ) : (
            <>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: FG,
                  marginBottom: 8,
                }}
              >
                Want to know when we launch?
              </div>
              <form
                onSubmit={handleEmailSubmit}
                style={{ display: "flex", gap: 8 }}
              >
                <input
                  type="email"
                  autoComplete="email"
                  enterKeyHint="go"
                  placeholder="your@email.com"
                  value={localEmail}
                  onChange={(e) => setLocalEmail(e.target.value)}
                  disabled={submitting}
                  aria-label="Email for launch notification"
                  className="success-email-input"
                  style={{
                    ...INPUT_STYLE,
                    flex: 1,
                    padding: "8px 10px",
                    fontSize: 14,
                    minHeight: 36,
                  }}
                />
                <button
                  type="submit"
                  disabled={submitting}
                  className="success-notify-btn"
                  style={{
                    background: ACCENT,
                    color: "#000",
                    fontWeight: 700,
                    fontSize: 13,
                    padding: "8px 16px",
                    border: "none",
                    cursor: submitting ? "wait" : "pointer",
                    fontFamily: "var(--font-body, Inter, sans-serif)",
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    whiteSpace: "nowrap",
                    opacity: submitting ? 0.6 : 1,
                  }}
                >
                  {submitting ? "..." : "NOTIFY ME"}
                </button>
              </form>
              {emailError && (
                <div
                  style={{
                    color: "var(--danger)",
                    fontSize: 12,
                    marginTop: 6,
                  }}
                >
                  Something went wrong. Try again.
                </div>
              )}
            </>
          )}
        </div>
      )}

      {(venuesRated >= 20 || contributors >= 20) && (
        <div
          style={{
            display: "flex",
            gap: 32,
            flexWrap: "wrap",
            justifyContent: "center",
            paddingTop: 8,
            animation: `fadeSlideUp 400ms 500ms ${SPRING_EASE} both`,
          }}
        >
          {venuesRated >= 20 && (
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 800,
                  color: ACCENT,
                  fontFamily: "var(--font-body, Inter, sans-serif)",
                }}
              >
                {venuesRated}
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: MUTED,
                }}
              >
                Places Rated
              </div>
            </div>
          )}
          {contributors >= 20 && (
            <div style={{ textAlign: "center" }}>
              <div
                style={{
                  fontSize: 28,
                  fontWeight: 800,
                  color: ACCENT,
                  fontFamily: "var(--font-body, Inter, sans-serif)",
                }}
              >
                {contributors}
              </div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.08em",
                  color: MUTED,
                }}
              >
                Artists Contributing
              </div>
            </div>
          )}
        </div>
      )}
      <div
        style={{
          animation: `fadeSlideUp 400ms 620ms ${SPRING_EASE} both`,
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
        }}
      >
        {variant === "page" ? (
          <>
            <Link href="/" passHref legacyBehavior>
              <Button
                variant="primary"
                size="$4"
                asChild
                aria-label="Browse upcoming events"
              >
                <a
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    textDecoration: "none",
                  }}
                >
                  <Text
                    variant="bodySmall"
                    weight="bold"
                    color="$colorInverted"
                    margin={0}
                  >
                    BROWSE EVENTS
                  </Text>
                  <ArrowRight size={16} />
                </a>
              </Button>
            </Link>
            <Button variant="ghost" size="$3" onPress={onReset}>
              RATE ANOTHER PLACE
            </Button>
          </>
        ) : (
          <Button variant="secondary" size="$3" onPress={onReset}>
            RATE ANOTHER PLACE
          </Button>
        )}
      </div>
      <style>{`
        .success-email-input:focus-visible {
          border-color: ${ACCENT} !important;
          outline: none;
        }
        .success-notify-btn:focus-visible {
          outline: 2px solid ${ACCENT};
          outline-offset: 2px;
        }
        @keyframes successPop {
          0% { transform: scale(0); opacity: 0; }
          60% { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
        @keyframes fadeSlideUp {
          from { opacity: 0; transform: translateY(16px); }
          to { opacity: 1; transform: translateY(0); }
        }
        ${Array.from({ length: 12 })
          .map((_, i) => {
            const angle = (i / 12) * 360;
            const rad = (angle * Math.PI) / 180;
            const dist = 36 + (i % 3) * 8;
            const tx = Math.cos(rad) * dist;
            const ty = Math.sin(rad) * dist;
            const rot = angle + (i % 2 === 0 ? 45 : -30);
            return `@keyframes confetti-p${i} {
              0% { opacity: 1; transform: translate(0, 0) rotate(0deg) scale(0.3); }
              50% { opacity: 1; }
              100% { opacity: 0; transform: translate(${tx.toFixed(1)}px, ${ty.toFixed(1)}px) rotate(${rot.toFixed(0)}deg) scale(1); }
            }`;
          })
          .join("\n")}
      `}</style>
    </YStack>
  );
}

import type {
  WalletPassPort,
  WalletPassType,
  WalletPassTicketData,
  WalletPassResult,
} from "@th/ports/wallet-pass.port";
import { createWalletPassError } from "@th/ports/wallet-pass.port";
import type { LoggerPort } from "@th/ports/logger";
import type { AppleWalletAdapter } from "./apple-wallet-adapter";
import type { GoogleWalletAdapter } from "./google-wallet-adapter";

// ── Composite adapter ────────────────────────────────────────────────────────
//
// Wraps optional Apple + Google sub-adapters behind a single WalletPassPort.
// Routes `generate` calls by `passType`, throws `not_configured` when the
// sub-adapter for the requested type isn't wired up.
// ─────────────────────────────────────────────────────────────────────────────

export type WalletPassAdapterConfig = {
  apple?: AppleWalletAdapter;
  google?: GoogleWalletAdapter;
  logger?: LoggerPort;
};

export class WalletPassAdapter implements WalletPassPort {
  private readonly apple?: AppleWalletAdapter;
  private readonly google?: GoogleWalletAdapter;
  private readonly logger?: LoggerPort;

  constructor(config: WalletPassAdapterConfig) {
    this.apple = config.apple;
    this.google = config.google;
    this.logger = config.logger;
  }

  async generate(
    passType: WalletPassType,
    ticketData: WalletPassTicketData,
  ): Promise<WalletPassResult> {
    if (passType === "apple") {
      if (!this.apple) {
        throw createWalletPassError(
          "not_configured",
          "Apple Wallet pass generation is not configured. Missing required credentials.",
        );
      }
      return this.apple.generate(ticketData);
    }

    if (passType === "google") {
      if (!this.google) {
        throw createWalletPassError(
          "not_configured",
          "Google Wallet pass generation is not configured. Missing required credentials.",
        );
      }
      return this.google.generate(ticketData);
    }

    throw createWalletPassError(
      "invalid_input",
      `Unknown wallet pass type: ${passType as string}`,
    );
  }

  async isConfigured(passType: WalletPassType): Promise<boolean> {
    if (passType === "apple") return !!this.apple;
    if (passType === "google") return !!this.google;
    return false;
  }
}

export function createWalletPassAdapter(
  config: WalletPassAdapterConfig,
): WalletPassPort {
  return new WalletPassAdapter(config);
}

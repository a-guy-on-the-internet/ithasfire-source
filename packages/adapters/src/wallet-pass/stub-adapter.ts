import type {
  WalletPassPort,
  WalletPassType,
  WalletPassTicketData,
  WalletPassResult,
} from "@th/ports/wallet-pass.port";
import { createWalletPassError } from "@th/ports/wallet-pass.port";
import type { LoggerPort } from "@th/ports/logger";

// ── Stub adapter ─────────────────────────────────────────────────────────────
//
// Returns "not_configured" for all pass types. Drop this in when the real
// Apple/Google credentials aren't yet available. It satisfies the port
// interface so the rest of the stack can compile and boot.
// ─────────────────────────────────────────────────────────────────────────────

export class StubWalletPassAdapter implements WalletPassPort {
  private readonly logger?: LoggerPort;

  constructor(opts?: { logger?: LoggerPort }) {
    this.logger = opts?.logger;
  }

  async generate(
    passType: WalletPassType,
    _ticketData: WalletPassTicketData,
  ): Promise<WalletPassResult> {
    this.logger?.warn("wallet-pass.stub.generate", {
      passType,
      message: "Wallet pass adapter is not configured — using stub.",
    });
    throw createWalletPassError(
      "not_configured",
      `Wallet pass generation for ${passType} is not configured.`,
    );
  }

  async isConfigured(_passType: WalletPassType): Promise<boolean> {
    return false;
  }
}

export function createStubWalletPassAdapter(opts?: {
  logger?: LoggerPort;
}): WalletPassPort {
  return new StubWalletPassAdapter(opts);
}

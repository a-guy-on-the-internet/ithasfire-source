import type { DealPerson } from "@/components/deals";
import {
  canViewerConfirmLine,
  type AgreementLineSubject,
  type ViewerIdentity,
} from "@/lib/booking-agreements";

// ─────────────────────────────────────────────────────────────────────────────
// The deal on the agreement page (board A1), as plain decisions: who the two
// parties are and in which order, and which payout lines still need a
// payee's own answer once "The deal" has taken over editing the lines.
// ─────────────────────────────────────────────────────────────────────────────

type PartyType = "human" | "organization";

export type AgreementDealPartiesInput = {
  agreement: {
    proposerType: PartyType;
    proposerId: string;
    proposerDisplayName: string | null;
    counterpartyType: PartyType;
    counterpartyId: string;
    counterpartyDisplayName: string | null;
  };
  /** The viewer's own side of the agreement. */
  actorSide: "proposer" | "counterparty";
  /** Which side of the booking the viewer is on; null with no request. */
  viewerSide: "editor" | "act" | null;
};

/**
 * The two parties, the place's side (the terms editor) first: `DealEditor`
 * reads the first party as who takes the rest when the deal names nobody
 * yet. The editor side is worked out from the viewer's own sides: the viewer
 * is on `actorSide`, and `viewerSide` says whether that side is the editor
 * or the act. With no originating request either party edits, and the
 * proposer comes first.
 */
export function agreementDealParties(
  input: AgreementDealPartiesInput,
  unnamed: string,
): DealPerson[] {
  const { agreement } = input;
  const proposer: DealPerson = {
    ref: {
      kind: agreement.proposerType === "organization" ? "org" : "human",
      id: agreement.proposerId,
    },
    name: agreement.proposerDisplayName ?? unnamed,
    source: "party",
  };
  const counterparty: DealPerson = {
    ref: {
      kind: agreement.counterpartyType === "organization" ? "org" : "human",
      id: agreement.counterpartyId,
    },
    name: agreement.counterpartyDisplayName ?? unnamed,
    source: "party",
  };
  const editorIsProposer =
    input.viewerSide === null
      ? true
      : (input.viewerSide === "editor") === (input.actorSide === "proposer");
  return editorIsProposer ? [proposer, counterparty] : [counterparty, proposer];
}

type AnswerLine = AgreementLineSubject & { counterPercentBps: number | null };

/**
 * The payout lines that still belong on the page once "The deal" edits the
 * terms: a line the viewer answers for themselves (confirm, counter or
 * decline; the deal has no answer control of its own), and an open counter-
 * ask, which every viewer should be able to read in full.
 */
export function isAnswerLine(
  line: AnswerLine,
  viewer: ViewerIdentity,
): boolean {
  if (canViewerConfirmLine(line, viewer)) return true;
  return (
    line.confirmationStatus === "COUNTERED" && line.counterPercentBps !== null
  );
}

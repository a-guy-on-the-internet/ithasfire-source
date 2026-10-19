import { useState, type ReactNode } from "react";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messageDictionarySchema } from "@th/locale";
import enCatalog from "@th/locale/messages/en.json" with { type: "json" };

import { renderWithProvider } from "../../../../../test/utils";
import { TranslationProvider } from "../../../../locale";
import {
  EventApplicationGate,
  type ApplicationQuestion,
  type ApplicationStatus,
  type ViewerSubmission,
} from "../events/EventApplicationGate";

// ─────────────────────────────────────────────────────────────────────────────
// Catalog
//
// The gate's new keys live in the WEB app catalog
// (apps/web/src/i18n/messages/en.ts), which @th/ui cannot import. The suite
// merges the same English over the package catalog so it asserts real copy
// rather than raw keys.
// ─────────────────────────────────────────────────────────────────────────────

const GATE_KEYS = {
  appEnterEmail: "Please enter your email address.",
  appGateKicker: "Application required",
  appGateFormLabel: "Application for {title}",
  appGateQuestionOf: "Question {current} of {total}",
  appGateContactStep: "Last step · Contact",
  appGateContactOnly: "Contact",
  appGateAllQuestions: "All questions",
  appGateStateCurrent: "Current",
  appGateStateAnswered: "Answered",
  appGateStateNotAnswered: "Not answered",
  appGateOptional: "Optional",
  appGateAnswerPlaceholder: "Your answer",
  appGateAnswerRequired: "Answer this question to continue.",
  appGateContactQuestion: "Where should the decision go?",
  appGateEmailLabel: "Email",
  appGateEmailPlaceholder: "you@example.com",
  appGatePhoneLabel: "Phone (optional)",
  appGateBack: "Back",
  appGateNext: "Next",
  appGateSend: "Send application",
  appGateSending: "Sending…",
  appGateLoading: "Loading the application…",
  appGateUnavailable: "The application form isn't available yet.",
  appGateWindowKicker: "Applications",
  appTimelineLabel: "Application progress",
  appTimelineApplied: "Applied",
  appTimelineInReview: "In review",
  appTimelineDecision: "Decision",
  appTimelineApproved: "Approved",
  appTimelineNotApproved: "Not approved",
  appTimelineWaitlist: "Waitlist",
  appTimelineWithdrawn: "Withdrawn",
  appTimelineExpired: "Expired",
  appStatusKickerInReview: "In review",
  appStatusKickerDecision: "Decision",
  appStatusKickerApplication: "Application",
  appStatusSentTitle: "Application sent",
  appStatusSentBody:
    "Your spot isn't confirmed yet. The organizer reads every application, and we'll email you either way.",
  appStatusYoureInTitle: "You're in",
  appStatusNotApprovedTitle: "Not approved",
  appStatusNotApprovedBody: "The organizer didn't approve your application.",
  appStatusFromOrganizer: "From the organizer",
};

const base = messageDictionarySchema.parse(enCatalog) as Record<
  string,
  Record<string, unknown>
>;
const messages = messageDictionarySchema.parse({
  ...base,
  eventDetail: { ...base.eventDetail, ...GATE_KEYS },
});

const render = (ui: ReactNode) =>
  renderWithProvider(
    <TranslationProvider locale="en" messages={messages}>
      {ui}
    </TranslationProvider>,
  );

// ─────────────────────────────────────────────────────────────────────────────
// prefers-reduced-motion
// ─────────────────────────────────────────────────────────────────────────────

const originalMatchMedia = window.matchMedia;

function setReducedMotion(reduced: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduced && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

beforeEach(() => {
  // Most behaviour is asserted with motion OFF so a step change is
  // synchronous; the motion suite below turns it back on.
  setReducedMotion(true);
});

afterEach(() => {
  window.matchMedia = originalMatchMedia;
  vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const makeQuestion = (
  overrides: Partial<ApplicationQuestion> = {},
): ApplicationQuestion => ({
  id: "q1",
  type: "SHORT_TEXT",
  label: "Act name",
  description: null,
  options: null,
  isRequired: true,
  order: 0,
  ...overrides,
});

const THREE_QUESTIONS: ApplicationQuestion[] = [
  makeQuestion({
    id: "about",
    type: "LONG_TEXT",
    label: "Tell us about yourself and your work.",
    order: 0,
  }),
  makeQuestion({
    id: "heard",
    type: "SHORT_TEXT",
    label: "How did you hear about this event?",
    order: 1,
  }),
  makeQuestion({
    id: "why",
    type: "LONG_TEXT",
    label: "Why would you like to attend?",
    order: 2,
    isRequired: false,
  }),
];

/**
 * Stateful harness mirroring EventApplicationGateWrapper: the Form is
 * controlled, so answer changes must round-trip through state.
 */
const FormHarness = ({
  questions,
  introText = null,
  initialEmail = "",
  onSubmit = () => {},
  onAnswerChange,
  isSubmitting = false,
  submitDisabled = false,
  error = null,
}: {
  questions: ApplicationQuestion[];
  introText?: string | null;
  initialEmail?: string;
  onSubmit?: () => void;
  onAnswerChange?: (questionId: string, value: unknown) => void;
  isSubmitting?: boolean;
  submitDisabled?: boolean;
  error?: string | null;
}) => {
  const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const [email, setEmail] = useState(initialEmail);
  const [phone, setPhone] = useState("");

  return (
    <EventApplicationGate.Form
      eventTitle="Founders & Friends Dinner"
      form={{ introText, questions }}
      answers={answers}
      contactEmail={email}
      contactPhone={phone}
      isSubmitting={isSubmitting}
      error={error}
      onAnswerChange={(questionId, value) => {
        onAnswerChange?.(questionId, value);
        setAnswers((prev) => ({ ...prev, [questionId]: value }));
      }}
      onContactEmailChange={setEmail}
      onContactPhoneChange={setPhone}
      onSubmit={onSubmit}
      contactNote={<p>guest-note</p>}
      verificationSlot={<div data-testid="verification-slot" />}
      submitDisabled={submitDisabled}
    />
  );
};

const renderForm = (props: Parameters<typeof FormHarness>[0]) =>
  render(<FormHarness {...props} />);

const stepEl = () => screen.getByTestId("application-step");
const nextButton = () => screen.getByRole("button", { name: "Next" });
const sendButton = () =>
  screen.getByRole("button", { name: "Send application" });
const answerField = () => within(stepEl()).getByPlaceholderText("Your answer");

const answerCurrent = (value: string) =>
  fireEvent.change(answerField(), { target: { value } });

// ─────────────────────────────────────────────────────────────────────────────
// One question at a time
// ─────────────────────────────────────────────────────────────────────────────

describe("EventApplicationGate.Form — step navigation", () => {
  it("shows the intro, the step label and ONLY the first question", () => {
    renderForm({
      questions: THREE_QUESTIONS,
      introText: "We keep this dinner to twelve people.",
    });

    expect(
      screen.getByText("We keep this dinner to twelve people."),
    ).toBeInTheDocument();
    expect(screen.getByText("Question 1 of 3")).toBeInTheDocument();
    expect(
      screen.getByText("Tell us about yourself and your work."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("How did you hear about this event?"),
    ).not.toBeInTheDocument();
    // Contact details are NOT asked first any more.
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    // No Back on the first step.
    expect(
      screen.queryByRole("button", { name: "Back" }),
    ).not.toBeInTheDocument();
  });

  it("labels the answer field with the question itself", () => {
    renderForm({ questions: THREE_QUESTIONS });

    expect(
      screen.getByRole("textbox", {
        name: "Tell us about yourself and your work.",
      }),
    ).toBeInTheDocument();
  });

  it("steps forward with Next and back with Back, filling the band", () => {
    renderForm({ questions: THREE_QUESTIONS });

    answerCurrent("I run a two-person studio.");
    fireEvent.click(nextButton());

    expect(screen.getByText("Question 2 of 3")).toBeInTheDocument();
    expect(
      screen.getByText("How did you hear about this event?"),
    ).toBeInTheDocument();
    const band = screen.getByTestId("application-step-band");
    expect(band).toHaveAttribute("aria-hidden", "true");
    expect(
      Array.from(band.children).map((seg) => seg.getAttribute("data-on")),
    ).toEqual(["true", "true", "false", "false"]);

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Question 1 of 3")).toBeInTheDocument();
    // The answer survives the round trip.
    expect(answerField()).toHaveValue("I run a two-person studio.");
  });

  it("moves focus to the new question's field after navigating", () => {
    renderForm({ questions: THREE_QUESTIONS });

    answerCurrent("Hello");
    fireEvent.click(nextButton());

    expect(
      screen.getByRole("textbox", { name: "How did you hear about this event?" }),
    ).toHaveFocus();
  });

  it("advances on Enter in a single-line field but not in a long answer", () => {
    renderForm({
      questions: [
        makeQuestion({ id: "short", label: "Act name", order: 0 }),
        makeQuestion({
          id: "long",
          type: "LONG_TEXT",
          label: "Tell us more",
          order: 1,
        }),
      ],
    });

    answerCurrent("The Kettle");
    fireEvent.keyDown(answerField(), { key: "Enter" });
    expect(screen.getByText("Question 2 of 2")).toBeInTheDocument();

    answerCurrent("Line one");
    fireEvent.keyDown(answerField(), { key: "Enter" });
    expect(screen.getByText("Question 2 of 2")).toBeInTheDocument();
  });

  it("asks for contact details on the LAST step, with the slots there", () => {
    renderForm({ questions: [makeQuestion({ isRequired: false })] });

    expect(screen.queryByText("guest-note")).not.toBeInTheDocument();
    expect(screen.queryByTestId("verification-slot")).not.toBeInTheDocument();

    fireEvent.click(nextButton());

    expect(screen.getByText("Last step · Contact")).toBeInTheDocument();
    expect(
      screen.getByText("Where should the decision go?"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Phone (optional)")).toBeInTheDocument();
    expect(screen.getByText("guest-note")).toBeInTheDocument();
    expect(screen.getByTestId("verification-slot")).toBeInTheDocument();
    expect(sendButton()).toBeInTheDocument();
  });

  it("goes straight to contact when the form has no questions", () => {
    renderForm({ questions: [] });

    expect(screen.getByText("Contact")).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "All questions" }),
    ).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "All questions" — jump to any question
// ─────────────────────────────────────────────────────────────────────────────

describe("EventApplicationGate.Form — All questions list", () => {
  it("lists every step with its answered state and aria-current on the current one", () => {
    renderForm({ questions: THREE_QUESTIONS });

    answerCurrent("About me");
    const toggle = screen.getByRole("button", { name: "All questions" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    const list = screen.getByTestId("application-question-list");
    expect(toggle).toHaveAttribute("aria-controls", list.id);
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(4);
    expect(rows[0]).toHaveAttribute("aria-current", "step");
    expect(rows[0]).toHaveTextContent("Current");
    expect(rows[1]).not.toHaveAttribute("aria-current");
    expect(rows[1]).toHaveTextContent("Not answered");
    expect(rows[3]).toHaveTextContent("Where should the decision go?");
  });

  it("jumps to ANY question — forwards past unanswered required ones — and closes", () => {
    renderForm({ questions: THREE_QUESTIONS });

    fireEvent.click(screen.getByRole("button", { name: "All questions" }));
    fireEvent.click(screen.getByTestId("application-jump-2"));

    expect(screen.getByText("Question 3 of 3")).toBeInTheDocument();
    expect(
      screen.getByText("Why would you like to attend?"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("application-question-list"),
    ).not.toBeInTheDocument();

    // Reopened, the current marker followed the jump; the earlier answered
    // state reads correctly.
    answerCurrent("Because");
    fireEvent.click(screen.getByRole("button", { name: "All questions" }));
    const rows = within(
      screen.getByTestId("application-question-list"),
    ).getAllByRole("button");
    expect(rows[2]).toHaveAttribute("aria-current", "step");
    expect(rows[0]).not.toHaveAttribute("aria-current");

    // ...and back to the first, from the list.
    fireEvent.click(screen.getByTestId("application-jump-0"));
    expect(screen.getByText("Question 1 of 3")).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the toggle", () => {
    renderForm({ questions: THREE_QUESTIONS });

    const toggle = screen.getByRole("button", { name: "All questions" });
    fireEvent.click(toggle);
    fireEvent.keyDown(screen.getByTestId("application-jump-1"), {
      key: "Escape",
    });

    expect(
      screen.queryByTestId("application-question-list"),
    ).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Required validation, per step and on send
// ─────────────────────────────────────────────────────────────────────────────

describe("EventApplicationGate.Form — required validation", () => {
  it("holds Next on an unanswered required question and explains why", () => {
    renderForm({ questions: THREE_QUESTIONS });

    fireEvent.click(nextButton());

    expect(screen.getByText("Question 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Answer this question to continue.",
    );
    expect(answerField()).toHaveAttribute("aria-invalid", "true");
    expect(answerField()).toHaveFocus();

    // Clear on input — the error never nags while the reader fixes it.
    answerCurrent("x");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(nextButton());
    expect(screen.getByText("Question 2 of 3")).toBeInTheDocument();
  });

  it("marks optional questions and lets them be skipped", () => {
    renderForm({
      questions: [makeQuestion({ isRequired: false, label: "Website" })],
    });

    expect(screen.getByText("Optional")).toBeInTheDocument();
    fireEvent.click(nextButton());
    expect(screen.getByText("Last step · Contact")).toBeInTheDocument();
  });

  it("never marks required questions (DS §6a) but puts required on the control", () => {
    renderForm({ questions: [makeQuestion({ label: "Act name" })] });

    expect(screen.queryByText("Optional")).not.toBeInTheDocument();
    expect(screen.queryByText(/\*/)).not.toBeInTheDocument();
    expect(answerField()).toHaveAttribute("aria-required", "true");
  });

  it("on send, jumps back to the first unanswered required question with its error", () => {
    const onSubmit = vi.fn();
    renderForm({ questions: THREE_QUESTIONS, onSubmit, initialEmail: "a@b.co" });

    // Skip ahead via the list, leaving question 1 empty.
    fireEvent.click(screen.getByRole("button", { name: "All questions" }));
    fireEvent.click(screen.getByTestId("application-jump-3"));
    fireEvent.click(sendButton());

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("Question 1 of 3")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Answer this question to continue.",
    );
  });

  it("requires an email on the contact step", () => {
    const onSubmit = vi.fn();
    renderForm({
      questions: [makeQuestion({ isRequired: false })],
      onSubmit,
    });

    fireEvent.click(nextButton());
    fireEvent.click(sendButton());

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Please enter your email address.",
    );
    expect(screen.getByLabelText("Email")).toHaveFocus();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "ana@example.com" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("sends from Enter in the email field once everything is answered", () => {
    const onSubmit = vi.fn();
    renderForm({ questions: [], onSubmit, initialEmail: "ana@example.com" });

    fireEvent.keyDown(screen.getByLabelText("Email"), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("will not send while verification is pending or a send is in flight", () => {
    const onSubmit = vi.fn();
    const { unmount } = renderForm({
      questions: [],
      onSubmit,
      initialEmail: "ana@example.com",
      submitDisabled: true,
    });
    expect(sendButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(screen.getByLabelText("Email"), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    unmount();

    renderForm({
      questions: [],
      onSubmit,
      initialEmail: "ana@example.com",
      isSubmitting: true,
    });
    expect(screen.getByRole("button", { name: "Sending…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });

  it("shows a submission error in an alert", () => {
    renderForm({ questions: [], error: "Something went wrong." });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Something went wrong.",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Choice questions (one per screen)
// ─────────────────────────────────────────────────────────────────────────────

describe("EventApplicationGate.Form — choice questions", () => {
  const single = makeQuestion({
    id: "len",
    type: "SINGLE_CHOICE",
    label: "Proposed set length",
    options: [{ value: "15 min" }, { value: "30 min" }, { value: "45 min" }],
  });
  const multi = makeQuestion({
    id: "booth",
    type: "MULTI_CHOICE",
    label: "Booth needs",
    options: [{ value: "Table" }, { value: "Power" }, { value: "Tent space" }],
  });

  it("single choice emits a plain string, labelled by the question", () => {
    const answerSpy: unknown[] = [];
    renderForm({
      questions: [single],
      onAnswerChange: (_id, value) => answerSpy.push(value),
    });

    expect(screen.getByRole("radiogroup")).toHaveAttribute(
      "aria-required",
      "true",
    );
    fireEvent.click(screen.getByRole("radio", { name: "15 min" }));
    fireEvent.click(screen.getByRole("radio", { name: "45 min" }));
    expect(screen.getByRole("radio", { name: "45 min" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(answerSpy).toEqual(["15 min", "45 min"]);
  });

  it("multi choice emits string[] in OPTION order and gates Next", () => {
    const answerSpy: unknown[] = [];
    renderForm({
      questions: [multi],
      onAnswerChange: (_id, value) => answerSpy.push(value),
    });

    fireEvent.click(nextButton());
    expect(screen.getByRole("alert")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "Tent space" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Table" }));
    expect(answerSpy).toEqual([["Tent space"], ["Table", "Tent space"]]);

    fireEvent.click(nextButton());
    expect(screen.getByText("Last step · Contact")).toBeInTheDocument();
  });

  it("skips choice questions with no usable options — never a blank, blocking step", () => {
    const onSubmit = vi.fn();
    renderForm({
      questions: [
        makeQuestion({
          id: "bad1",
          type: "SINGLE_CHOICE",
          options: "garbage" as unknown as ApplicationQuestion["options"],
        }),
        makeQuestion({
          id: "bad2",
          type: "MULTI_CHOICE",
          options: [
            true,
            null,
            {},
            { value: "   " },
          ] as unknown as ApplicationQuestion["options"],
        }),
      ],
      onSubmit,
      initialEmail: "ana@example.com",
    });

    expect(screen.getByText("Contact")).toBeInTheDocument();
    fireEvent.click(sendButton());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("accepts plain-string, numeric and {id,label} option shapes, deduped", () => {
    renderForm({
      questions: [
        makeQuestion({
          id: "strings",
          type: "SINGLE_CHOICE",
          options: ["Yes", "No", "Yes"] as unknown as ApplicationQuestion["options"],
        }),
      ],
    });
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("renders {id,label} and numeric options", () => {
    renderForm({
      questions: [
        makeQuestion({
          id: "idlabel",
          type: "MULTI_CHOICE",
          options: [
            { id: "opt-1", label: "Photographer" },
            15,
          ] as unknown as ApplicationQuestion["options"],
        }),
      ],
    });
    expect(
      screen.getByRole("checkbox", { name: "Photographer" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "15" })).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Motion
// ─────────────────────────────────────────────────────────────────────────────

describe("EventApplicationGate.Form — motion", () => {
  beforeEach(() => {
    setReducedMotion(false);
    vi.useFakeTimers();
  });

  const finishSlide = () => {
    act(() => {
      vi.advanceTimersByTime(120);
    });
    act(() => {
      vi.advanceTimersByTime(40); // two animation frames
    });
  };

  it("slides the outgoing question 24px the way you're leaving, then the incoming from the other side", () => {
    renderForm({ questions: THREE_QUESTIONS });

    answerCurrent("Hello");
    fireEvent.click(nextButton());

    // Outgoing: still question 1, leaving to the LEFT, 120ms.
    expect(stepEl()).toHaveAttribute("data-phase", "exiting");
    expect(stepEl()).toHaveAttribute("data-step", "0");
    expect(stepEl().style.transform).toBe("translateX(-24px)");
    expect(stepEl().style.transition).toContain("120ms");
    expect(stepEl().style.transition).toContain("cubic-bezier(0.2, 0.8, 0.3, 1)");

    act(() => {
      vi.advanceTimersByTime(120);
    });
    // Incoming: question 2, parked on the RIGHT with no transition.
    expect(stepEl()).toHaveAttribute("data-phase", "entering");
    expect(stepEl()).toHaveAttribute("data-step", "1");
    expect(stepEl().style.transform).toBe("translateX(24px)");

    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(stepEl()).toHaveAttribute("data-phase", "active");
    expect(stepEl().style.transform).toBe("none");
    expect(stepEl().style.transition).toContain("180ms");
  });

  it("a jump to an EARLIER question from the list slides in from the left", () => {
    renderForm({ questions: THREE_QUESTIONS });

    fireEvent.click(screen.getByRole("button", { name: "All questions" }));
    fireEvent.click(screen.getByTestId("application-jump-2"));
    finishSlide();
    expect(stepEl()).toHaveAttribute("data-step", "2");

    fireEvent.click(screen.getByRole("button", { name: "All questions" }));
    fireEvent.click(screen.getByTestId("application-jump-0"));
    expect(stepEl().style.transform).toBe("translateX(24px)"); // leaving right
    act(() => {
      vi.advanceTimersByTime(120);
    });
    expect(stepEl().style.transform).toBe("translateX(-24px)"); // from left
  });

  it("ignores Next while a slide is in flight (no double step)", () => {
    renderForm({
      questions: THREE_QUESTIONS.map((q) => ({ ...q, isRequired: false })),
    });

    fireEvent.click(nextButton());
    fireEvent.click(nextButton());
    finishSlide();
    expect(stepEl()).toHaveAttribute("data-step", "1");
  });

  it("steps the band segments", () => {
    renderForm({ questions: THREE_QUESTIONS });
    const seg = screen.getByTestId("application-step-band")
      .firstElementChild as HTMLElement;
    expect(seg.style.transition).toContain("steps(1");
  });

  it("is OFF under prefers-reduced-motion: the step swaps instantly", () => {
    setReducedMotion(true);
    renderForm({
      questions: THREE_QUESTIONS.map((q) => ({ ...q, isRequired: false })),
    });

    fireEvent.click(nextButton());

    expect(stepEl()).toHaveAttribute("data-phase", "active");
    expect(stepEl()).toHaveAttribute("data-step", "1");
    expect(stepEl().style.transform).toBe("none");
    expect(stepEl().style.transition).toBe("");
    const seg = screen.getByTestId("application-step-band")
      .firstElementChild as HTMLElement;
    expect(seg.style.transition).toBe("none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Status views
// ─────────────────────────────────────────────────────────────────────────────

const makeSubmission = (
  status: ApplicationStatus,
  overrides: Partial<ViewerSubmission> = {},
): ViewerSubmission => ({
  id: "sub-1",
  status,
  createdAt: new Date("2026-08-01T12:00:00Z"),
  reviewedAt: null,
  ...overrides,
});

const renderStatus = (
  status: ApplicationStatus,
  props: Partial<Parameters<typeof EventApplicationGate>[0]> = {},
  overrides: Partial<ViewerSubmission> = {},
) =>
  render(
    <EventApplicationGate
      eventTitle="Founders & Friends Dinner"
      viewerSubmission={makeSubmission(status, overrides)}
      {...props}
    />,
  );

const timelineItems = () =>
  within(screen.getByTestId("application-timeline")).getAllByRole("listitem");

describe("EventApplicationGate — status views", () => {
  it("PENDING: In review, 'Application sent', the not-confirmed body, withdraw", () => {
    const onWithdraw = vi.fn();
    renderStatus("PENDING", { onWithdraw });

    // Once: the timeline names the stage, so no kicker repeats it underneath.
    expect(screen.getAllByText("In review")).toHaveLength(1);
    expect(
      screen.getByRole("heading", { name: "Application sent" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Your spot isn't confirmed yet. The organizer reads every application, and we'll email you either way.",
      ),
    ).toBeInTheDocument();

    const items = timelineItems();
    expect(items.map((li) => li.getAttribute("data-state"))).toEqual([
      "done",
      "current",
      "todo",
    ]);
    expect(items[1]).toHaveAttribute("aria-current", "step");
    expect(items[1]).toHaveTextContent("In review");

    fireEvent.click(
      screen.getByRole("button", { name: "Withdraw application" }),
    );
    expect(onWithdraw).toHaveBeenCalledTimes(1);
  });

  it("PENDING without onWithdraw shows no withdraw button", () => {
    renderStatus("PENDING");
    expect(
      screen.queryByRole("button", { name: "Withdraw application" }),
    ).not.toBeInTheDocument();
  });

  it("APPROVED: 'You're in' and View event", () => {
    const onViewEvent = vi.fn();
    renderStatus("APPROVED", { onViewEvent });

    expect(
      screen.getByRole("heading", { name: "You're in" }),
    ).toBeInTheDocument();
    expect(timelineItems()[2]).toHaveTextContent("Approved");
    expect(timelineItems()[2]).toHaveAttribute("aria-current", "step");
    fireEvent.click(screen.getByRole("button", { name: "View Event" }));
    expect(onViewEvent).toHaveBeenCalledTimes(1);
  });

  it("REJECTED with a note: the note under 'From the organizer', line breaks kept", () => {
    renderStatus("REJECTED", {}, {
      decisionReason: "We're keeping this one to past speakers.\nThe spring dinner is open.",
    });

    expect(
      screen.getByRole("heading", { name: "Not approved" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The organizer didn't approve your application."),
    ).toBeInTheDocument();
    const note = screen.getByTestId("application-organizer-note");
    expect(within(note).getByText("From the organizer")).toBeInTheDocument();
    const body = within(note).getByText(/past speakers/);
    expect(body.textContent).toBe(
      "We're keeping this one to past speakers.\nThe spring dinner is open.",
    );
    expect(body).toHaveStyle({ whiteSpace: "pre-line" });
    // No apology copy.
    expect(screen.queryByText(/unfortunately/i)).not.toBeInTheDocument();
  });

  it("REJECTED without a note (null, absent or blank): a plain decline", () => {
    for (const decisionReason of [null, undefined, "   "]) {
      const { unmount } = renderStatus("REJECTED", {}, { decisionReason });
      expect(
        screen.getByRole("heading", { name: "Not approved" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByTestId("application-organizer-note"),
      ).not.toBeInTheDocument();
      unmount();
    }
  });

  it("never shows a decision note on a non-REJECTED status", () => {
    renderStatus("APPROVED", {}, { decisionReason: "stray" });
    expect(screen.queryByText("stray")).not.toBeInTheDocument();
  });

  it("WAITLISTED: the waitlist headline with a support-amber decision segment", () => {
    renderStatus("WAITLISTED");
    expect(
      screen.getByRole("heading", { name: "You're on the waitlist" }),
    ).toBeInTheDocument();
    const fills = screen.getAllByTestId("application-timeline-fill");
    expect(fills[2]!.style.backgroundColor).toContain("--support");
  });

  it("REJECTED fills the decision segment in ink, not accent", () => {
    renderStatus("REJECTED");
    const fills = screen.getAllByTestId("application-timeline-fill");
    expect(fills[2]!.style.backgroundColor).toContain("--color,");
    expect(fills[0]!.style.backgroundColor).toContain("--accent");
  });

  it("EXPIRED: muted, existing copy", () => {
    renderStatus("EXPIRED");
    expect(
      screen.getByRole("heading", { name: "Application Expired" }),
    ).toBeInTheDocument();
    expect(timelineItems()[2]).toHaveTextContent("Expired");
  });

  it("WITHDRAWN offers Apply again only while the window is open", () => {
    const onReapply = vi.fn();
    const { unmount } = renderStatus("WITHDRAWN", {
      windowState: "open",
      onReapply,
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply again" }));
    expect(onReapply).toHaveBeenCalledTimes(1);
    unmount();

    renderStatus("WITHDRAWN", { windowState: "closed", onReapply });
    expect(
      screen.getByRole("heading", { name: "Application Withdrawn" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Apply again" }),
    ).not.toBeInTheDocument();
  });

  it("degrades to neutral copy for an unknown future status instead of crashing", () => {
    renderStatus("SOME_FUTURE_STATUS" as ApplicationStatus);
    expect(
      screen.getByRole("heading", { name: "Application Received" }),
    ).toBeInTheDocument();
  });
});

describe("EventApplicationGate — status timeline motion", () => {
  it("fills in four steps over 240ms", () => {
    setReducedMotion(false);
    vi.useFakeTimers();
    renderStatus("APPROVED");

    const fills = screen.getAllByTestId("application-timeline-fill");
    expect(fills[0]!.style.transform).toBe("scaleX(0)");
    expect(fills[0]!.style.transition).toBe("transform 240ms steps(4, end)");

    act(() => {
      vi.advanceTimersByTime(40);
    });
    expect(fills[0]!.style.transform).toBe("scaleX(1)");
  });

  it("lands filled with no transition under reduced motion", () => {
    renderStatus("APPROVED");
    const fills = screen.getAllByTestId("application-timeline-fill");
    expect(fills.every((f) => f.style.transform === "scaleX(1)")).toBe(true);
    expect(fills[0]!.style.transition).toBe("none");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Window states + fallbacks
// ─────────────────────────────────────────────────────────────────────────────

describe("EventApplicationGate — window states", () => {
  const openForm = { introText: null, questions: [makeQuestion()] };

  it("shows 'applications open {date}' instead of the form before the window opens", () => {
    const renderFormSpy = vi.fn();
    render(
      <EventApplicationGate
        eventTitle="Basement Show"
        viewerSubmission={null}
        form={openForm}
        windowState="notYetOpen"
        opensAtLabel="Sep 1, 2026, 10:00 AM"
        renderForm={renderFormSpy}
      />,
    );

    expect(
      screen.getByText("Applications aren't open yet"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Applications open Sep 1, 2026, 10:00 AM"),
    ).toBeInTheDocument();
    expect(renderFormSpy).not.toHaveBeenCalled();
  });

  it("uses window-specific copy (not the submission-status default) when no date is known", () => {
    render(
      <EventApplicationGate
        eventTitle="Basement Show"
        viewerSubmission={null}
        form={openForm}
        windowState="notYetOpen"
        opensAtLabel={null}
      />,
    );

    expect(
      screen.getByText("Applications aren't open yet — check back soon."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Check back soon for an update from the organizer."),
    ).not.toBeInTheDocument();
  });

  it("shows the closed state instead of the form after the window closes", () => {
    const renderFormSpy = vi.fn();
    render(
      <EventApplicationGate
        eventTitle="Basement Show"
        viewerSubmission={null}
        form={openForm}
        windowState="closed"
        renderForm={renderFormSpy}
      />,
    );

    expect(screen.getByText("Applications are closed")).toBeInTheDocument();
    expect(
      screen.getByText("This event is no longer accepting applications."),
    ).toBeInTheDocument();
    expect(renderFormSpy).not.toHaveBeenCalled();
  });

  it("renders the form when the window is open (default)", () => {
    const renderFormSpy = vi.fn(() => <div>the-form</div>);
    render(
      <EventApplicationGate
        eventTitle="Basement Show"
        viewerSubmission={null}
        form={openForm}
        renderForm={renderFormSpy}
      />,
    );

    expect(renderFormSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText("the-form")).toBeInTheDocument();
  });

  it("loading and no-form states use catalog copy, not hard-coded English", () => {
    const { unmount } = render(
      <EventApplicationGate eventTitle="Basement Show" isLoading />,
    );
    expect(screen.getByText("Loading the application…")).toBeInTheDocument();
    unmount();

    render(<EventApplicationGate eventTitle="Basement Show" form={null} />);
    expect(
      screen.getByText("The application form isn't available yet."),
    ).toBeInTheDocument();
  });
});

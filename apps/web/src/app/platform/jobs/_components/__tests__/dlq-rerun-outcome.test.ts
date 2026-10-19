import { createTranslator } from "@th/locale";
import { describe, expect, it, vi } from "vitest";

import enMessages from "@/i18n/messages/en";
import esMessages from "@/i18n/messages/es";

import {
  RERUN_ERROR_MAX_LENGTH,
  dlqItemKey,
  dlqRerunNotice,
  ranButEntryKept,
  toErrorSentence,
  type DlqRerunResult,
  type DlqRerunSettled,
} from "../dlq-rerun-outcome";

// The REAL app catalogs, not a stub dictionary: the page renders the raw key
// when a lookup misses, so a mapping test over a fake `t` would pass on a key
// that exists in neither catalog.
const en = createTranslator("en", enMessages as never).t;
const es = createTranslator("es", esMessages as never).t;

const result = (value: DlqRerunResult): DlqRerunSettled => ({
  kind: "result",
  result: value,
});

/** A thrown tRPC client error, as the mutation's `onError` receives it. */
const trpcError = (code: string, message: string): DlqRerunSettled => ({
  kind: "error",
  error: Object.assign(new Error(message), { data: { code } }),
});

describe("dlqRerunNotice", () => {
  it("ran, entry deleted: says the job ran and the entry was removed", () => {
    expect(
      dlqRerunNotice(
        result({ outcome: "ran", runId: "run_1", entryDeleted: true }),
        en,
      ),
    ).toEqual({
      tone: "success",
      message: "The job ran. The entry was removed.",
    });
  });

  it("ran with no run id reads the same", () => {
    expect(
      dlqRerunNotice(
        result({ outcome: "ran", runId: null, entryDeleted: true }),
        en,
      ),
    ).toEqual({
      tone: "success",
      message: "The job ran. The entry was removed.",
    });
  });

  it("ran, entry NOT deleted: never claims the entry was removed", () => {
    const notice = dlqRerunNotice(
      result({ outcome: "ran", runId: "run_1", entryDeleted: false }),
      en,
    );
    expect(notice).toEqual({
      tone: "warning",
      message:
        "The job ran, but its entry could not be removed and is still here. Delete it. Rerunning it would run the job a second time.",
    });
    expect(notice.message).not.toContain("was removed");
  });

  it.each([
    [
      "disabled",
      "This job is disabled, so nothing ran. The entry is still here. Enable the job, then rerun the entry.",
    ],
    [
      "coalesced",
      "A run of this job was already going and took this in. The entry is still here. Check the run history, then rerun or delete it.",
    ],
    [
      "unconfirmed",
      "The jobs service did not confirm the run. The entry is still here.",
    ],
    [
      "claimed",
      "A rerun of this entry started in the last few minutes and may still be running. Nothing ran this time and the entry is still here. Check the run history, then try again in a few minutes.",
    ],
  ] as const)(
    "not_run / %s: a warning that the entry is still here",
    (reason, message) => {
      const notice = dlqRerunNotice(result({ outcome: "not_run", reason }), en);
      expect(notice).toEqual({ tone: "warning", message });
      // The floor: a rerun that did not run never reads as one that did.
      expect(notice.message).not.toContain("removed");
    },
  );

  it("not_run / claimed has its own message in Spanish too, not the unconfirmed one", () => {
    const notice = dlqRerunNotice(result({ outcome: "not_run", reason: "claimed" }), es);
    expect(notice).toEqual({
      tone: "warning",
      message:
        "Un reintento de esta entrada empez\u00F3 hace unos minutos y puede seguir en curso. Esta vez no se ejecut\u00F3 nada y la entrada sigue aqu\u00ED. Revisa el historial de ejecuciones y vuelve a intentarlo en unos minutos.",
    });
  });

  it("failed with a code: quotes the job's error and carries the code", () => {
    expect(
      dlqRerunNotice(
        result({
          outcome: "failed",
          runId: "run_2",
          status: 500,
          error: { message: "connect ECONNREFUSED", code: "dependency_failed" },
        }),
        en,
      ),
    ).toEqual({
      tone: "danger",
      message:
        "The rerun failed: connect ECONNREFUSED. The entry is still here.",
      code: "dependency_failed",
    });
  });

  it.each([
    ["the same word", "invalid_input", "invalid_input"],
    ["a different case", "INVALID_INPUT", "invalid_input"],
    ["padding around either", "  invalid_input ", "invalid_input\n"],
  ])(
    "failed, code equal to the message (%s): the code is not repeated",
    (_label, code, message) => {
      const notice = dlqRerunNotice(
        result({
          outcome: "failed",
          runId: "run_3",
          status: 200,
          error: { message, code },
        }),
        en,
      );
      // A schema rejection answers `invalid_input` as both. The sentence
      // already quotes it once.
      expect(notice).toEqual({
        tone: "danger",
        message: "The rerun failed: invalid_input. The entry is still here.",
      });
      expect("code" in notice).toBe(false);
    },
  );

  it("failed, code different from the message: the code is kept, trimmed", () => {
    const notice = dlqRerunNotice(
      result({
        outcome: "failed",
        runId: "run_4",
        status: 500,
        error: { message: "Invalid input: expected string", code: " invalid_input " },
      }),
      en,
    );
    expect(notice.code).toBe("invalid_input");
    expect(notice.message).toBe(
      "The rerun failed: Invalid input: expected string. The entry is still here.",
    );
  });

  it("failed without a code: no code key at all", () => {
    const notice = dlqRerunNotice(
      result({
        outcome: "failed",
        runId: null,
        status: 500,
        error: { message: "Index rebuild timed out." },
      }),
      en,
    );
    expect(notice).toEqual({
      tone: "danger",
      // Already ends in a full stop: none is added.
      message:
        "The rerun failed: Index rebuild timed out. The entry is still here.",
    });
    expect("code" in notice).toBe(false);
  });

  it("failed with a long error: cut to the limit with an ellipsis", () => {
    const long = "x".repeat(RERUN_ERROR_MAX_LENGTH + 150);
    const notice = dlqRerunNotice(
      result({
        outcome: "failed",
        runId: null,
        status: 500,
        error: { message: long },
      }),
      en,
    );
    expect(notice.message).toBe(
      `The rerun failed: ${"x".repeat(RERUN_ERROR_MAX_LENGTH)}… The entry is still here.`,
    );
  });

  it("failed: braces and quotes in the job's error survive the ICU formatter", () => {
    const notice = dlqRerunNotice(
      result({
        outcome: "failed",
        runId: null,
        status: 500,
        error: { message: `{"error":"can't parse {id}"}` },
      }),
      en,
    );
    expect(notice.message).toBe(
      `The rerun failed: {"error":"can't parse {id}"}. The entry is still here.`,
    );
  });

  it("failed with a blank error: falls back to the runner's HTTP status", () => {
    const notice = dlqRerunNotice(
      result({
        outcome: "failed",
        runId: null,
        status: 503,
        error: { message: "   " },
      }),
      en,
    );
    expect(notice.message).toBe(
      "The rerun failed: HTTP 503. The entry is still here.",
    );
  });

  it("NOT_FOUND: the entry is no longer in the queue", () => {
    expect(
      dlqRerunNotice(trpcError("NOT_FOUND", "Jobs API 404: not_found"), en),
    ).toEqual({
      tone: "warning",
      message: "That entry is no longer in the queue.",
    });
  });

  it("NOT_FOUND carried on `shape.data` is read too", () => {
    const settled: DlqRerunSettled = {
      kind: "error",
      error: Object.assign(new Error("Jobs API 404: gone"), {
        shape: { data: { code: "NOT_FOUND" } },
      }),
    };
    expect(dlqRerunNotice(settled, en).message).toBe(
      "That entry is no longer in the queue.",
    );
  });

  // A thrown error is not proof that nothing ran: the request can break off
  // on any hop while the job carries on, and Rerun is live again afterwards.
  const MAY_STILL_RUN =
    "The run may still be in progress. Check the run history before rerunning.";

  it.each([
    ["INTERNAL_SERVER_ERROR", "Jobs API 502: Bad Gateway"],
    ["TIMEOUT", "Jobs API 504: Gateway Timeout"],
    ["PRECONDITION_FAILED", "Jobs API 409: {}"],
    ["TOO_MANY_REQUESTS", "Jobs API 429: slow down"],
  ])(
    "thrown %s: the error, then the warning that the run may still be going",
    (code, message) => {
      expect(dlqRerunNotice(trpcError(code, message), en)).toEqual({
        tone: "danger",
        message: `${message}. ${MAY_STILL_RUN}`,
      });
    },
  );

  it("a thrown error with no tRPC code (the network dropped) warns too", () => {
    const notice = dlqRerunNotice(
      { kind: "error", error: new TypeError("Failed to fetch") },
      en,
    );
    expect(notice).toEqual({
      tone: "danger",
      message: `Failed to fetch. ${MAY_STILL_RUN}`,
    });
  });

  it.each(["FORBIDDEN", "UNAUTHORIZED"])(
    "thrown %s: refused before anything ran, so no may-still-run warning",
    (code) => {
      const notice = dlqRerunNotice(
        trpcError(code, "Jobs API 403: not staff"),
        en,
      );
      expect(notice).toEqual({
        tone: "danger",
        message: "Jobs API 403: not staff.",
      });
      expect(notice.message).not.toContain("may still be in progress");
    },
  );

  it("NOT_FOUND never carries the may-still-run warning", () => {
    expect(
      dlqRerunNotice(trpcError("NOT_FOUND", "Jobs API 404: x"), en).message,
    ).not.toContain("may still be in progress");
  });

  it("a coded thrown error is looked up through the translator it was given", () => {
    // `formatErrorMessage(err)` without `t` never consults the catalog. A
    // translator that answers the `errors.*` key proves `t` was passed on.
    const t = vi.fn((key: string) =>
      key === "errors.staffOnly" ? "Solo para el personal." : key,
    );
    const notice = dlqRerunNotice(trpcError("FORBIDDEN", "staff_only"), t);
    expect(t).toHaveBeenCalledWith("errors.staffOnly");
    expect(notice).toEqual({
      tone: "danger",
      message: "Solo para el personal.",
    });
  });

  it("a long thrown error is cut like a job error", () => {
    const notice = dlqRerunNotice(
      trpcError(
        "INTERNAL_SERVER_ERROR",
        `Jobs API 500: ${"y".repeat(RERUN_ERROR_MAX_LENGTH * 2)}`,
      ),
      en,
    );
    // The error is cut to the limit plus its ellipsis; the fixed sentence
    // follows whole.
    const suffix = ` ${MAY_STILL_RUN}`;
    expect(notice.message.endsWith(`…${suffix}`)).toBe(true);
    expect([...notice.message]).toHaveLength(
      RERUN_ERROR_MAX_LENGTH + 1 + [...suffix].length,
    );
  });

  it("a non-Error throw still produces a message", () => {
    const notice = dlqRerunNotice({ kind: "error", error: undefined }, en);
    expect(notice.tone).toBe("danger");
    expect(notice.message.length).toBeGreaterThan(0);
  });

  it("es: every outcome resolves to Spanish copy, never a raw key", () => {
    const settledCases: DlqRerunSettled[] = [
      result({ outcome: "ran", runId: null, entryDeleted: true }),
      result({ outcome: "ran", runId: null, entryDeleted: false }),
      result({ outcome: "not_run", reason: "disabled" }),
      result({ outcome: "not_run", reason: "coalesced" }),
      result({ outcome: "not_run", reason: "unconfirmed" }),
      result({
        outcome: "failed",
        runId: null,
        status: 500,
        error: { message: "boom" },
      }),
      trpcError("NOT_FOUND", "Jobs API 404: not_found"),
    ];
    const messages = settledCases.map((s) => dlqRerunNotice(s, es).message);
    for (const message of messages) {
      expect(message).not.toMatch(/^admin\./);
    }
    expect(messages[5]).toBe("El reintento falló: boom. La entrada sigue aquí.");
    // Same sentences as en would be a missed translation.
    const english = settledCases.map((s) => dlqRerunNotice(s, en).message);
    messages.forEach((message, index) => {
      expect(message).not.toBe(english[index]);
    });
  });
});

describe("ranButEntryKept", () => {
  it("is true only for a run whose entry could not be removed", () => {
    expect(
      ranButEntryKept(
        result({ outcome: "ran", runId: null, entryDeleted: false }),
      ),
    ).toBe(true);
    expect(
      ranButEntryKept(
        result({ outcome: "ran", runId: null, entryDeleted: true }),
      ),
    ).toBe(false);
    expect(
      ranButEntryKept(result({ outcome: "not_run", reason: "disabled" })),
    ).toBe(false);
    expect(
      ranButEntryKept(
        result({
          outcome: "failed",
          runId: null,
          status: 500,
          error: { message: "boom" },
        }),
      ),
    ).toBe(false);
    expect(ranButEntryKept(trpcError("NOT_FOUND", "gone"))).toBe(false);
  });
});

describe("the labels the page reads directly", () => {
  it.each([
    [
      "admin.jobsDlqRanDeleteThis",
      "This entry already ran. Delete it.",
      "Esta entrada ya se ejecutó. Elimínala.",
    ],
    [
      "admin.jobsDlqRerunMayStillRun",
      "The run may still be in progress. Check the run history before rerunning.",
      "Puede que la ejecución siga en curso. Revisa el historial de ejecuciones antes de reintentar.",
    ],
    ["admin.jobsDlqRerunning", "Rerunning…", "Reintentando…"],
    ["admin.jobsDlqRerun", "Rerun", "Reintentar"],
  ] as const)("%s exists in both catalogs", (key, enCopy, esCopy) => {
    expect(en(key)).toBe(enCopy);
    expect(es(key)).toBe(esCopy);
  });

  it("the attempt label takes a count in both locales", () => {
    expect(en("admin.jobsDlqAttempt", { count: 3 })).toBe("Attempt 3");
    expect(es("admin.jobsDlqAttempt", { count: 3 })).toBe("Intento 3");
  });
});

describe("toErrorSentence", () => {
  it("adds a full stop only when the text has no closing punctuation", () => {
    expect(toErrorSentence("timeout")).toBe("timeout.");
    expect(toErrorSentence("timeout.")).toBe("timeout.");
    expect(toErrorSentence("really?")).toBe("really?");
    expect(toErrorSentence("stop!")).toBe("stop!");
    expect(toErrorSentence("and so on…")).toBe("and so on…");
  });

  it("collapses whitespace, including newlines from a stack trace", () => {
    expect(toErrorSentence("  first line\n    at foo\t(bar)  ")).toBe(
      "first line at foo (bar).",
    );
  });

  it("keeps a message exactly at the limit whole", () => {
    const exact = "a".repeat(RERUN_ERROR_MAX_LENGTH);
    expect(toErrorSentence(exact)).toBe(`${exact}.`);
  });

  it("cuts one character over the limit, and never ends on a space", () => {
    const text = `${"a".repeat(RERUN_ERROR_MAX_LENGTH - 1)} bcd`;
    expect(toErrorSentence(text)).toBe(
      `${"a".repeat(RERUN_ERROR_MAX_LENGTH - 1)}…`,
    );
  });

  it("does not cut through a surrogate pair", () => {
    const text = "🔥".repeat(RERUN_ERROR_MAX_LENGTH + 5);
    expect(toErrorSentence(text)).toBe(
      `${"🔥".repeat(RERUN_ERROR_MAX_LENGTH)}…`,
    );
  });

  it("returns empty for blank input", () => {
    expect(toErrorSentence(" \n ")).toBe("");
  });
});

describe("dlqItemKey", () => {
  it("tells apart ids that would collide under plain concatenation", () => {
    expect(dlqItemKey("a:b", "c")).not.toBe(dlqItemKey("a", "b:c"));
    expect(dlqItemKey("q", "1")).toBe(dlqItemKey("q", "1"));
  });
});

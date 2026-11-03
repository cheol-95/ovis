import { expect, test } from "bun:test";
import { matchCodexTranscript } from "./codex.ts";

const prompt = "Start the local development server.";
const answer = "The local server is ready. [http://127.0.0.1:4317](http://127.0.0.1:4317) is the address.\n\nUse a development account to sign in.";
const event = (payload: unknown) => JSON.stringify({ type: "event_msg", payload });
const candidate = (path: string, text = answer, asked = prompt) => ({ path, text: [
  event({ type: "item_completed", turn_id: "t", item: { type: "UserMessage", content: [{ text: asked }] } }),
  JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] } }),
  event({ type: "task_complete", turn_id: "t", last_agent_message: text }),
].join("\n") });
const screen = `› ${prompt}

• The local server is ready. http://127.0.0.1:4317 (http://127.0.0.1:4317) is the address.

  Use a development account to sign in.

  Worked for 17s • 3:50 PM

  1 background terminal running · /ps to view · /stop to close

  ⚠ weekly limit: 12% left · /status

› Ask Codex to do anything

  GPT-6.1 Terra xhigh Fast · main · Context 49% left
  ← for agents · ? for shortcuts`;

test("matches a complete linked reply with a native background-terminal notice", () => {
  expect(matchCodexTranscript(screen, [candidate("own")])).toBe("own");
  expect(matchCodexTranscript(screen.replace("  1 background terminal running · /ps to view · /stop to close\n", ""), [candidate("own")])).toBe("own");
});

test("recognizes every integer percentage from zero to 100 in either notice order", () => {
  for (let threshold = 0; threshold <= 100; threshold++) {
    const notice = `⚠ Heads up, you have less than ${threshold}% of your weekly limit left. Run /status for a breakdown.`;
    const withRemaining = screen.replace("12% left", `${threshold}% left`);
    const wrapped = notice.replace("weekly limit", "weekly\n  limit");
    for (const text of [withRemaining.replace("  1 background", `${notice}\n\n  1 background`), withRemaining.replace("  ⚠ weekly", `${notice}\n\n  ⚠ weekly`), withRemaining.replace("  1 background", `${wrapped}\n\n  1 background`)]) {
      expect(matchCodexTranscript(text, [candidate("own")])).toBe("own");
      expect(matchCodexTranscript(text.replace("Run /status for a breakdown.", "Run /status to proceed."), [candidate("own")])).toBeNull();
    }
  }
});

test("does not discard impossible percentages or different warning text", () => {
  for (const percentage of ["101", "1000", "-1", "9.5"]) {
    const invalid = `⚠ Heads up, you have less than ${percentage}% of your weekly limit left. Run /status for a breakdown.`;
    expect(matchCodexTranscript(screen.replace("  1 background", `${invalid}\n\n  1 background`), [candidate("own")])).toBeNull();
    expect(matchCodexTranscript(screen.replace("12% left", `${percentage}% left`), [candidate("own")])).toBeNull();
  }
});

test("keeps an exact reply unbound while a same-prompt conversation's linked answer renders the same", () => {
  const text = "The implementation preserves request metadata and trace identifiers while masking sensitive values.";
  const literal = `${text} Read report (docs/report.md) for details.`;
  const shown = screen.replace(/• The local[\s\S]*?to sign in\./, `• ${literal}`);
  const linked = candidate("linked", `${text} Read [report](/repo/docs/report.md) for details.`);
  expect(matchCodexTranscript(shown, [candidate("own", literal), linked], new Set(), new Map(), false, new Set(["own", "linked"]))).toBeNull();
  // a same-prompt conversation that answered otherwise leaves the exact reply its own
  const other = candidate("other", `${text} Read [summary](/repo/docs/summary.md) for details.`);
  expect(matchCodexTranscript(shown, [candidate("own", literal), other], new Set(), new Map(), false, new Set(["own", "other"]))).toBe("own");
});

test("keeps changed, ambiguous, unfinished and unknown replies unbound", () => {
  expect(matchCodexTranscript(screen, [candidate("own"), candidate("twin")])).toBeNull();
  expect(matchCodexTranscript(screen.replaceAll(":4317", ":4321"), [candidate("own")])).toBeNull();
  expect(matchCodexTranscript(screen.replace("to sign in", "to log out"), [candidate("own")])).toBeNull();
  const unfinished = { path: "unfinished", text: event({ type: "item_completed", turn_id: "other", item: { type: "UserMessage", content: [{ text: prompt }] } }) };
  expect(matchCodexTranscript(screen, [candidate("own"), unfinished])).toBeNull();
  expect(matchCodexTranscript(screen.replace("/stop to close", "/stop to proceed"), [candidate("own")])).toBeNull();
});

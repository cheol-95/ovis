import { ChevronDown, FileText, Hourglass, Target, Timer } from "lucide-react";
import { useEffect, useState } from "react";

import type { ConversationSession, GoalStatus } from "../../shared/protocol.ts";
import { formatTokens } from "../lib/compose.ts";
import { formatGoalTime } from "../lib/goals.ts";
import { currentLocale, useT } from "../lib/i18n.ts";
import { sessionSummary } from "../lib/sessionLine.ts";
import "./SessionLine.css";

/**
 * One quiet line above the conversation (#1170, #2017): the session's goal, what omo waits on,
 * the time it worked and how large its transcript is, all as the transcript records them.
 * Folded by default; opening it says each in full. Follows the Codex app, which keeps a thread's
 * active goal above its conversation rather than on the turn that set it.
 */
export function SessionLine({ session, live }: { session: ConversationSession; live: boolean }) {
  const t = useT();
  // a resume time is said while it is ahead: draw again once it passes
  const due = session.waiting?.resumes_at ? Date.parse(session.waiting.resumes_at) : NaN;
  const [, passed] = useState(0);
  useEffect(() => {
    const left = due - Date.now();
    if (!Number.isFinite(left) || left <= 0) return;
    const timer = setTimeout(() => passed((n) => n + 1), left + 1000);
    return () => clearTimeout(timer);
  }, [due]);
  const { goal, waiting, worked, size } = sessionSummary(session, { now: Date.now(), live, locale: currentLocale(), t });
  const word: Record<GoalStatus, string> = {
    active: t("in progress"), paused: t("paused"), blocked: t("blocked"), complete: t("complete"), budget_limited: t("out of budget"),
  };
  const spent = goal === null ? "" : [
    goal.timeUsedSeconds !== null && goal.timeUsedSeconds > 0 ? formatGoalTime(goal.timeUsedSeconds) : null,
    goal.tokensUsed !== null && goal.tokensUsed > 0 ? t("{n} tokens", { n: formatTokens(goal.tokensUsed) }) : null,
  ].filter((item) => item !== null).join(" · ");
  const waitingWords = waiting === null ? null : waiting.on.length > 0 ? waiting.on.join(", ") : t("background work");
  return <details className={`session-line${goal === null ? "" : ` is-${goal.status}`}`}>
    <summary>
      {goal !== null
        ? <><Target aria-hidden="true" /><span className="session-line-label">{t("Goal")}</span><span className="session-line-objective">{goal.objective}</span>
          <span className="session-line-status">{word[goal.status]}</span></>
        : <span className="session-line-label session-line-grow">{t("Session")}</span>}
      {waiting !== null && <span className="session-line-waiting" title={t("Waiting on {work}", { work: waitingWords! })}><Hourglass aria-hidden="true" />{t("Waiting")}</span>}
      <span className="session-line-fact" title={t("Worked")}><Timer aria-hidden="true" />{worked ?? t("unknown")}</span>
      <span className="session-line-fact session-line-size" title={t("Transcript")}><FileText aria-hidden="true" />{size}</span>
      <ChevronDown className="session-line-caret" aria-hidden="true" />
    </summary>
    <dl className="session-line-detail">
      {goal !== null && <>
        <dt>{t("Goal")}</dt>
        <dd>
          <p className="session-line-goal-text">{goal.objective}</p>
          <p className="session-line-note">{word[goal.status]}{spent.length > 0 ? ` · ${t("Used so far: {spent}", { spent })}` : ""}</p>
          {goal.blockedReason !== null && <p className="session-line-note">{goal.blockedReason}</p>}
        </dd>
      </>}
      {waiting !== null && <>
        <dt>{t("Waiting")}</dt>
        <dd>
          <p>{t("Waiting on {work}", { work: waitingWords! })}</p>
          {waiting.resumes !== null && <p className="session-line-note">{t("The goal continues at about {time}", { time: waiting.resumes })}</p>}
        </dd>
      </>}
      <dt>{t("Worked")}</dt>
      <dd>
        <p>{worked ?? t("unknown")}</p>
        <p className="session-line-note">{worked === null ? t("This agent's transcript records no turn times.") : t("The sum of the session's turn times, as its transcript records them.")}</p>
      </dd>
      <dt>{t("Transcript")}</dt>
      <dd><p>{size}</p></dd>
    </dl>
  </details>;
}

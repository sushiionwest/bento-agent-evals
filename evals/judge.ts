/**
 * LLM-as-judge scaffold for plan quality.
 *
 * Answers a question the deterministic gate cannot: did the proposed
 * operations capture the INTENT of the free text? Runs only when a judge
 * model is actually reachable (live local Ollama, or Anthropic when a key is
 * explicitly configured). When no judge is available the scorecard reports
 * SKIPPED — a judge score is never fabricated.
 */

import type { AgentLlmProvider } from "../src/agent/llm-provider";
import type { ProposedOperation } from "../src/validation/proposed-operation";
import type { EvalFixture } from "./lib/fixture-schema";

export interface JudgeVerdict {
  score: number; // 1-5
  rationale: string;
}

export interface JudgeResult {
  status: "ran" | "skipped" | "error";
  verdict?: JudgeVerdict;
  error?: string;
}

const JUDGE_SYSTEM_PROMPT = `You are grading a Kanban assistant. Given free-form input text and the operations the assistant proposed, rate how well the proposals capture the text's actionable intent.

Score 1-5:
5 = every actionable item in the text is covered by an appropriate operation, nothing invented
4 = minor omission or one slightly-off operation
3 = captures the main intent but misses or distorts secondary items
2 = major intent missed or significant invented work
1 = proposals are unrelated to the text

Respond with ONLY JSON: {"score": <1-5>, "rationale": "<one sentence>"}`;

export async function judgeProposals(
  judge: AgentLlmProvider,
  fixture: EvalFixture,
  finalOperations: ProposedOperation[]
): Promise<JudgeResult> {
  const prompt = `INPUT TEXT:
"""
${fixture.input}
"""

PROPOSED OPERATIONS (after legality filtering):
${JSON.stringify(finalOperations, null, 2)}

Board columns: ${fixture.board.columns.map((c) => c.name).join(", ")}.
Cards on board: ${fixture.board.cards.map((c) => `"${c.title}"`).join(", ") || "(none)"}.

Note: operations the workflow forbids are rejected by a separate guardrail; if the text requested something illegal, NOT proposing it (or proposing a comment instead) is correct behavior.

Return the JSON verdict now.`;

  try {
    const raw = await judge.generate({ system: JUDGE_SYSTEM_PROMPT, prompt });
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start === -1 || end === -1) {
      return { status: "error", error: "Judge returned no JSON" };
    }
    const parsed = JSON.parse(raw.slice(start, end + 1)) as { score?: unknown; rationale?: unknown };
    const score = typeof parsed.score === "number" ? parsed.score : Number(parsed.score);
    if (!Number.isFinite(score) || score < 1 || score > 5) {
      return { status: "error", error: "Judge score out of range" };
    }
    return {
      status: "ran",
      verdict: { score, rationale: String(parsed.rationale ?? "") },
    };
  } catch (error) {
    return { status: "error", error: error instanceof Error ? error.message : "Judge call failed" };
  }
}

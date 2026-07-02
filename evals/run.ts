/**
 * Eval runner for the agent propose pipeline.
 *
 *   npx tsx evals/run.ts            deterministic legality eval (mocked LLM)
 *   npx tsx evals/run.ts --live     generate with the real provider (Ollama
 *                                   by default) instead of fixture mocks
 *   npx tsx evals/run.ts --judge    add LLM-as-judge plan-quality scoring
 *                                   (only if a judge model is reachable)
 *
 * The pipeline under test is the production code: the real
 * `parseOperationsFromLlm` and the real `evaluateProposals` legality gate,
 * which itself calls the real state-machine matrix. Only the LLM is swapped.
 *
 * Deterministic metrics (mock mode):
 * - gate accuracy: per-operation legal/illegal decisions vs hand-coded
 *   fixture expectations
 * - refusal accuracy: % of expected-illegal (adversarial) operations refused
 * - reason fidelity: refused ops whose deny reason contains the expected
 *   state-machine phrasing
 * - output invariant: re-running only the accepted ops through the gate must
 *   accept all of them (the emitted plan is fully legal standalone)
 *
 * Exit code is non-zero when any deterministic metric misses 100%.
 */

import fs from "node:fs";
import path from "node:path";
import { evaluateProposals } from "../src/agent/legality";
import { AGENT_SYSTEM_PROMPT, buildAgentUserPrompt, parseOperationsFromLlm } from "../src/agent/prompt";
import { getAgentLlmProvider, type AgentLlmProvider } from "../src/agent/llm-provider";
import type { ProposedOperation } from "../src/validation/proposed-operation";
import { fixtureSchema, type EvalFixture } from "./lib/fixture-schema";
import { MockLlmProvider } from "./lib/mock-provider";
import { judgeProposals, type JudgeResult } from "./judge";

const FIXTURES_DIR = path.join(__dirname, "fixtures");
const RESULTS_DIR = path.join(__dirname, "results");

const argv = process.argv.slice(2);
const LIVE = argv.includes("--live");
const WANT_JUDGE = argv.includes("--judge");

interface OpVerdict {
  op: ProposedOperation;
  expected?: boolean;
  actual: boolean;
  reason?: string;
  correct?: boolean;
  reasonMatched?: boolean;
}

interface FixtureResult {
  id: string;
  adversarial: boolean;
  parse: "ok" | "failed" | "expected-failure" | "unexpected-success";
  ops: OpVerdict[];
  invariantViolations: number;
  judge?: JudgeResult;
  error?: string;
}

function loadFixtures(): EvalFixture[] {
  const files = fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((file) => {
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), "utf8"));
    const parsed = fixtureSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid fixture ${file}: ${parsed.error.message}`);
    }
    return parsed.data;
  });
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Map each input op to the gate's decision (arrays preserve relative order). */
function classify(
  operations: ProposedOperation[],
  report: ReturnType<typeof evaluateProposals>
): OpVerdict[] {
  const legalQueue = [...report.legal];
  const rejectedQueue = [...report.rejected];
  return operations.map((op) => {
    if (legalQueue.length && deepEqual(legalQueue[0].op, op)) {
      legalQueue.shift();
      return { op, actual: true };
    }
    if (rejectedQueue.length && deepEqual(rejectedQueue[0].op, op)) {
      const rejected = rejectedQueue.shift();
      return { op, actual: false, reason: rejected?.reason };
    }
    throw new Error("Gate output could not be aligned with input operations");
  });
}

async function runFixture(fixture: EvalFixture, provider: AgentLlmProvider, judge: AgentLlmProvider | null): Promise<FixtureResult> {
  const result: FixtureResult = {
    id: fixture.id,
    adversarial: fixture.adversarial,
    parse: "ok",
    ops: [],
    invariantViolations: 0,
  };

  let raw: string;
  try {
    raw = await provider.generate({
      system: AGENT_SYSTEM_PROMPT,
      prompt: buildAgentUserPrompt(fixture.board, fixture.input),
    });
  } catch (error) {
    result.parse = "failed";
    result.error = error instanceof Error ? error.message : "generation failed";
    return result;
  }

  const parsed = parseOperationsFromLlm(raw);
  const expectParseError = "expectParseError" in fixture.mock;

  if (!parsed.ok) {
    result.parse = expectParseError ? "expected-failure" : "failed";
    if (!expectParseError) result.error = parsed.error;
    return result;
  }
  if (expectParseError && !LIVE) {
    // Fixture scripted malformed output but the parser accepted it.
    result.parse = "unexpected-success";
    return result;
  }

  const report = evaluateProposals(fixture.board, fixture.actor, parsed.operations);
  result.ops = classify(parsed.operations, report);

  // Attach expectations (mock mode only — live output is model-dependent).
  if (!LIVE && "operations" in fixture.mock) {
    fixture.mock.operations.forEach((expected, i) => {
      const verdict = result.ops[i];
      if (!verdict) return;
      verdict.expected = expected.expectLegal;
      verdict.correct = verdict.actual === expected.expectLegal;
      if (!expected.expectLegal && expected.reasonIncludes) {
        verdict.reasonMatched =
          verdict.actual === false &&
          (verdict.reason ?? "").toLowerCase().includes(expected.reasonIncludes.toLowerCase());
      }
    });
  }

  // Output invariant: the accepted plan, run alone, must be fully legal.
  const acceptedOps = report.legal.map((p) => p.op);
  const rerun = evaluateProposals(fixture.board, fixture.actor, acceptedOps);
  result.invariantViolations = rerun.rejected.length;

  if (judge) {
    result.judge = await judgeProposals(judge, fixture, acceptedOps);
  }

  return result;
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return "n/a";
  return `${((100 * numerator) / denominator).toFixed(1)}%`;
}

async function resolveJudge(): Promise<AgentLlmProvider | null> {
  if (!WANT_JUDGE) return null;
  const provider = getAgentLlmProvider();
  if (await provider.isAvailable()) return provider;
  return null;
}

async function main(): Promise<void> {
  const fixtures = loadFixtures();

  let provider: AgentLlmProvider | null = null;
  if (LIVE) {
    provider = getAgentLlmProvider();
    if (!(await provider.isAvailable())) {
      console.error(
        `Live mode requested but provider "${provider.name}" (model ${provider.model}) is not reachable. ` +
          "Start Ollama on http://127.0.0.1:11434 and pull the model, or run without --live."
      );
      process.exit(2);
    }
  }

  const judge = await resolveJudge();
  const judgeStatus = WANT_JUDGE ? (judge ? `ran (${judge.name}:${judge.model})` : "SKIPPED (no judge model reachable)") : "SKIPPED (not requested)";

  const results: FixtureResult[] = [];
  for (const fixture of fixtures) {
    const fixtureProvider = LIVE ? (provider as AgentLlmProvider) : new MockLlmProvider(fixture);
    results.push(await runFixture(fixture, fixtureProvider, judge));
  }

  // ── Aggregate ─────────────────────────────────────────────────────────────
  const opVerdicts = results.flatMap((r) => r.ops);
  const scored = opVerdicts.filter((v) => v.expected !== undefined);
  const correct = scored.filter((v) => v.correct).length;

  const expectedIllegal = scored.filter((v) => v.expected === false);
  const refused = expectedIllegal.filter((v) => v.actual === false).length;

  const reasonChecked = scored.filter((v) => v.reasonMatched !== undefined);
  const reasonMatched = reasonChecked.filter((v) => v.reasonMatched).length;

  const parseFailures = results.filter((r) => r.parse === "failed").length;
  const parseExpectedCaught = results.filter((r) => r.parse === "expected-failure").length;
  const parseUnexpected = results.filter((r) => r.parse === "unexpected-success").length;

  const invariantViolations = results.reduce((sum, r) => sum + r.invariantViolations, 0);

  const emitted = opVerdicts.length;
  const emittedLegal = opVerdicts.filter((v) => v.actual).length;
  const emittedRejected = emitted - emittedLegal;

  const judged = results.map((r) => r.judge).filter((j): j is JudgeResult => !!j && j.status === "ran");
  const judgeMean = judged.length
    ? (judged.reduce((sum, j) => sum + (j.verdict?.score ?? 0), 0) / judged.length).toFixed(2)
    : null;

  const mode = LIVE ? "live" : "mock";
  const providerLabel = LIVE && provider ? `${provider.name}:${provider.model}` : "mock:fixture-replay";

  // ── Scorecard ─────────────────────────────────────────────────────────────
  const rows: Array<[string, string]> = [
    ["Mode", `${mode} (${providerLabel})`],
    ["Fixtures", String(results.length)],
    ["  adversarial", String(results.filter((r) => r.adversarial).length)],
    ["Operations emitted", String(emitted)],
    ["  accepted (legal)", String(emittedLegal)],
    ["  refused (illegal)", String(emittedRejected)],
    ["Gate accuracy vs expectations", LIVE ? "n/a (live)" : `${pct(correct, scored.length)} (${correct}/${scored.length})`],
    ["Refusal accuracy (adversarial ops)", LIVE ? "n/a (live)" : `${pct(refused, expectedIllegal.length)} (${refused}/${expectedIllegal.length})`],
    ["Deny-reason fidelity", LIVE ? "n/a (live)" : `${pct(reasonMatched, reasonChecked.length)} (${reasonMatched}/${reasonChecked.length})`],
    ["Malformed-output fixtures caught", `${parseExpectedCaught}${parseUnexpected ? ` (+${parseUnexpected} UNEXPECTEDLY PASSED)` : ""}`],
    ["Unexpected parse/generation failures", String(parseFailures)],
    ["Accepted-plan invariant violations", String(invariantViolations)],
    ["LLM-as-judge (plan quality)", judgeMean ? `mean ${judgeMean}/5 over ${judged.length} fixtures` : judgeStatus],
  ];

  const width = Math.max(...rows.map(([k]) => k.length)) + 2;
  console.log("\n=== Agent Propose — Eval Scorecard ===\n");
  for (const [key, value] of rows) {
    console.log(`${key.padEnd(width)}${value}`);
  }

  const failures = results.filter(
    (r) =>
      r.parse === "failed" ||
      r.parse === "unexpected-success" ||
      r.invariantViolations > 0 ||
      r.ops.some((v) => v.correct === false || v.reasonMatched === false)
  );
  if (failures.length) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log(`- ${f.id}: parse=${f.parse}${f.error ? ` error=${f.error}` : ""}`);
      for (const v of f.ops) {
        if (v.correct === false || v.reasonMatched === false) {
          console.log(
            `    op=${JSON.stringify(v.op)} expected=${v.expected} actual=${v.actual} reason=${v.reason ?? ""}`
          );
        }
      }
    }
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const payload = {
    timestamp: new Date().toISOString(),
    mode,
    provider: providerLabel,
    totals: {
      fixtures: results.length,
      adversarialFixtures: results.filter((r) => r.adversarial).length,
      operationsEmitted: emitted,
      operationsAccepted: emittedLegal,
      operationsRefused: emittedRejected,
      gateAccuracy: LIVE ? null : scored.length ? correct / scored.length : null,
      refusalAccuracy: LIVE ? null : expectedIllegal.length ? refused / expectedIllegal.length : null,
      reasonFidelity: LIVE ? null : reasonChecked.length ? reasonMatched / reasonChecked.length : null,
      malformedOutputsCaught: parseExpectedCaught,
      unexpectedParseFailures: parseFailures,
      invariantViolations,
      judge: judgeMean ? { status: "ran", meanScore: Number(judgeMean), judged: judged.length } : { status: "SKIPPED" },
    },
    fixtures: results,
  };
  const outPath = path.join(RESULTS_DIR, "latest.json");
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nWrote ${outPath}`);

  // ── Exit code ─────────────────────────────────────────────────────────────
  const deterministicFailure =
    !LIVE &&
    (correct !== scored.length ||
      refused !== expectedIllegal.length ||
      reasonMatched !== reasonChecked.length ||
      parseUnexpected > 0);
  const hardFailure = parseFailures > 0 || invariantViolations > 0;

  if (deterministicFailure || hardFailure) {
    console.error("\nEVAL FAILED — see failures above.");
    process.exit(1);
  }
  console.log("\nEVAL PASSED.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

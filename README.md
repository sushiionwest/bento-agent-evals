# bento-agent-evals

An LLM agent proposes Kanban card operations from messy free text — standup notes, ship reports, task dumps — and every single proposal is validated against the real, enforced state machine from my production app, [Bento Sprint](https://www.bentosprint.com). This repo is the agent pipeline plus the eval harness that measures it, extracted from the private production codebase so the whole thing runs standalone: no database, no cloud API, no account.

## Why the state machine makes the eval deterministic

Most "LLM feature" demos have a grading problem: the thing checking the output is either another LLM or the author's optimism. This one doesn't. Bento Sprint's workflow engine is an enforced state machine (`src/state-machine/transitions.ts`) that every card move in production goes through — role checks, approval gates, WIP limits, acceptance-criteria requirements, and human-readable deny reasons. It predates the agent feature, and every human user is subject to it.

That makes it a correctness oracle I cannot fake. An operation either survives the real `validateTransition` or it does not, and the deny reason comes out of the same code path users see — "Cannot move directly from Doing to DONE", "Members cannot move cards out of Done". The fixtures encode hand-written expectations (never derived from the code under test), the mock provider replays scripted model output through the production parse and legality gates, and the score is a fact, not a vibe.

Proposals are validated sequentially against a simulated board: if the model says "claim the card, then close it," the second operation is judged from the card's new position — the same way the production system would experience it. The LLM-as-judge layer exists only for the fuzzy question the oracle cannot answer (did the proposals capture the text's intent?) and it reports SKIPPED when no judge model is reachable rather than inventing a number.

## Scorecard

Deterministic run (mocked LLM, `npm run eval`), as committed in `evals/results/latest.json`:

| Metric | Result |
|---|---|
| Fixtures | 64 (34 adversarial) |
| Operations emitted | 70 |
| Gate accuracy vs hand-coded expectations | 100.0% (70/70) |
| Refusal accuracy on adversarial ops | 100.0% (34/34) |
| Deny-reason fidelity | 100.0% (34/34) |
| Malformed model output caught | 2/2 |
| Accepted-plan invariant violations | 0 |
| LLM-as-judge (plan quality) | SKIPPED — no judge model on this run |

| Live-model metrics (Ollama, qwen2.5:7b) | Result |
|---|---|
| Schema-valid output rate | pending live run |
| Emitted-operation legality rate | pending live run |
| Judge mean intent score | pending live run |

Adversarial fixtures explicitly ask for illegal work — skip the review stage, resurrect a Done card as a member, move to a column that doesn't exist, assign an outsider, blow through a WIP limit — and the system must refuse each one with the correct reason. CI (`.github/workflows/agent-eval.yml`) re-proves this on every push with zero external LLM calls, and the runner exits non-zero if any deterministic metric misses 100%.

## Run it

```bash
npm install

# Unit tests (schema gate + legality gate)
npm test

# Deterministic eval — no LLM, no database, no network
npm run eval

# Live eval + judge against a local model.
# Requires Ollama serving on http://127.0.0.1:11434 with a model pulled:
#   ollama pull qwen2.5:7b
npm run eval:live

# Regenerate the fixtures from the hand-coded expectations
npm run eval:fixtures
```

Provider selection is deliberate: local Ollama at `http://127.0.0.1:11434` is the default and the recommendation — no cloud API, no per-token bill. An Anthropic provider exists behind `AGENT_LLM_PROVIDER=anthropic` plus `ANTHROPIC_API_KEY`; without a key it is never constructed and never called. I don't ship features that quietly depend on a metered API.

## What stays in the private product

This repo is the pure core: the state machine, the agent contracts, the prompt and parser, the legality gate, and the eval harness. Deliberately left behind in the Bento Sprint codebase:

- The `POST /api/v2/agent/propose` endpoint (auth, rate limiting, error envelope shared with the other v2 routes)
- The board-snapshot loader that reads real board state from the database
- The apply layer that executes accepted operations through the production write paths (which is what fires outbox events into Slack/Discord/Notion)

Nothing here stubs those out — the modules in this repo were written DB-free in the product precisely so the eval harness could load the exact production gate under plain `tsx`. What you run here is what production runs.

## Layout

```
src/state-machine/   The enforced transition matrix + pure validation API
src/agent/           Contracts, prompt + parser, legality gate, LLM provider boundary
src/validation/      Zod schemas for the ProposedOperation contract (gate #1)
evals/               Runner, judge scaffold, fixture schema, 64 fixtures, latest results
tests/               Unit tests for the schema gate and the legality gate
```

---

Built by [William Victor](https://sushiionwest.com). The product this was extracted from is [Bento Sprint](https://www.bentosprint.com).

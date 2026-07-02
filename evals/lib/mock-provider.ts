/**
 * Deterministic mock LLM provider for the eval harness and CI.
 *
 * Implements the exact production `AgentLlmProvider` interface and replays
 * the fixture's scripted response, so the pipeline under test (prompt ->
 * parse -> legality gate) is byte-for-byte the production code path with the
 * ONLY nondeterministic component swapped out.
 */

import type { AgentLlmGenerateInput, AgentLlmProvider } from "../../src/agent/llm-provider";
import type { EvalFixture } from "./fixture-schema";

export class MockLlmProvider implements AgentLlmProvider {
  readonly name = "mock";
  readonly model = "fixture-replay";
  private readonly response: string;

  constructor(fixture: EvalFixture) {
    if ("rawResponse" in fixture.mock) {
      this.response = fixture.mock.rawResponse;
    } else {
      this.response = JSON.stringify({
        operations: fixture.mock.operations.map((expected) => expected.op),
      });
    }
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(_input: AgentLlmGenerateInput): Promise<string> {
    return this.response;
  }
}

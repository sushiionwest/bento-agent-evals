/**
 * Thin LLM provider boundary for the agent pipeline.
 *
 * Default provider is LOCAL Ollama at http://127.0.0.1:11434 (loopback IP on
 * purpose — do not switch to `localhost`). No cloud API is ever called unless
 * the operator explicitly opts in: `AnthropicProvider` is only constructed
 * when AGENT_LLM_PROVIDER=anthropic AND ANTHROPIC_API_KEY is set. No key,
 * no construction, no call.
 *
 * The interface is deliberately string-in/string-out; structured-output
 * enforcement happens downstream in `parseOperationsFromLlm` + the legality
 * gate, so provider quality is measurable rather than assumed.
 */

export interface AgentLlmGenerateInput {
  system: string;
  prompt: string;
}

export interface AgentLlmProvider {
  readonly name: string;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  generate(input: AgentLlmGenerateInput): Promise<string>;
}

const OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const OLLAMA_DEFAULT_MODEL = "qwen2.5:7b";
const GENERATE_TIMEOUT_MS = 120_000;
const AVAILABILITY_TIMEOUT_MS = 3_000;

export class OllamaProvider implements AgentLlmProvider {
  readonly name = "ollama";
  readonly model: string;
  private readonly baseUrl: string;

  constructor(options?: { baseUrl?: string; model?: string }) {
    this.baseUrl = options?.baseUrl ?? process.env.OLLAMA_BASE_URL ?? OLLAMA_DEFAULT_BASE_URL;
    this.model = options?.model ?? process.env.AGENT_OLLAMA_MODEL ?? OLLAMA_DEFAULT_MODEL;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { models?: Array<{ name?: string }> };
      const models = data.models ?? [];
      return models.some(
        (m) => m.name === this.model || m.name === `${this.model}:latest` || m.name?.startsWith(`${this.model}`)
      );
    } catch {
      return false;
    }
  }

  async generate(input: AgentLlmGenerateInput): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        options: { temperature: 0 },
        messages: [
          { role: "system", content: input.system },
          { role: "user", content: input.prompt },
        ],
      }),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Ollama request failed with status ${res.status}`);
    }

    const data = (await res.json()) as { message?: { content?: string } };
    const content = data.message?.content;
    if (typeof content !== "string") {
      throw new Error("Ollama response missing message content");
    }
    return content;
  }
}

/**
 * Opt-in cloud provider. Constructor THROWS without a key so it can never be
 * instantiated by accident; the factory below only constructs it when a key
 * is actually present.
 */
export class AnthropicProvider implements AgentLlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, options?: { model?: string }) {
    if (!apiKey) {
      throw new Error("AnthropicProvider requires an API key");
    }
    this.apiKey = apiKey;
    this.model = options?.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async generate(input: AgentLlmGenerateInput): Promise<string> {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 2048,
        system: input.system,
        messages: [{ role: "user", content: input.prompt }],
      }),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new Error(`Anthropic request failed with status ${res.status}`);
    }

    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const text = data.content?.find((block) => block.type === "text")?.text;
    if (typeof text !== "string") {
      throw new Error("Anthropic response missing text content");
    }
    return text;
  }
}

/**
 * Provider selection:
 * - AGENT_LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY set -> AnthropicProvider
 * - anything else -> local OllamaProvider (the default and the recommendation)
 */
export function getAgentLlmProvider(): AgentLlmProvider {
  const requested = process.env.AGENT_LLM_PROVIDER?.toLowerCase();
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (requested === "anthropic" && anthropicKey) {
    return new AnthropicProvider(anthropicKey);
  }

  return new OllamaProvider();
}

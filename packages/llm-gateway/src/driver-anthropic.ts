import type { ApiDriverId } from "@maestro/contracts";
import { z } from "zod";
import type { DriverConfig } from "./config.js";
import type { DriverCall, DriverDeps, DriverResult, LlmDriver } from "./driver-types.js";
import { LlmResponseError } from "./errors.js";
import { postJson } from "./http.js";

/** Messages API response — only the fields we consume are required. */
const AnthropicResponse = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_input_tokens: z.number().int().nonnegative().optional(),
    cache_creation_input_tokens: z.number().int().nonnegative().optional(),
  }),
});

/** Messages API request body. `model` is omitted on bedrock/vertex (it is in the URL). */
export function messagesBody(call: DriverCall, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...extra,
    max_tokens: call.maxTokens,
    temperature: call.temperature,
    ...(call.system === null ? {} : { system: call.system }),
    messages: [{ role: "user", content: [{ type: "text", text: call.prompt }] }],
  };
}

/** Shared by all three Anthropic-shaped transports (direct, bedrock, vertex). */
export function parseMessagesResponse(driver: ApiDriverId, json: unknown): DriverResult {
  const parsed = AnthropicResponse.safeParse(json);
  if (!parsed.success) {
    throw new LlmResponseError(driver, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const text = parsed.data.content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("");
  if (text.trim().length === 0) throw new LlmResponseError(driver, ["response carries no text block"]);

  const usage = parsed.data.usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const tokensIn = usage.input_tokens + cacheRead + cacheWrite;
  const reportsCache = usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;

  return {
    text,
    tokensIn,
    tokensOut: usage.output_tokens,
    cachePct: reportsCache && tokensIn > 0 ? Math.round((cacheRead / tokensIn) * 10_000) / 100 : null,
  };
}

/** `anthropic-direct` (M16): api.anthropic.com or a corporate egress proxy. */
export class AnthropicDirectDriver implements LlmDriver {
  readonly id: ApiDriverId = "anthropic-direct";

  constructor(
    private readonly cfg: Extract<DriverConfig, { driver: "anthropic-direct" }>,
    private readonly deps: DriverDeps,
  ) {}

  async complete(call: DriverCall): Promise<DriverResult> {
    const apiKey = await this.deps.secrets.get(call.credentialRef ?? this.cfg.apiKeyRef);
    const json = await postJson(
      {
        driver: this.id,
        url: `${trimSlash(this.cfg.baseUrl)}/v1/messages`,
        headers: { "x-api-key": apiKey, "anthropic-version": this.cfg.apiVersion, accept: "application/json" },
        body: messagesBody(call, { model: call.model }),
        timeoutMs: this.cfg.timeoutMs,
      },
      { deps: this.deps, bucket: this.deps.bucket, retry: this.deps.retry, counter: call.counter },
    );
    return parseMessagesResponse(this.id, json);
  }
}

export function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

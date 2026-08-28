import { describe, expect, it } from "vitest";
import {
  AnthropicDirectDriver,
  BedrockDriver,
  DriverConfig,
  LlmConfigError,
  LlmResponseError,
  OpenAiCompatDriver,
  RateLimitConfig,
  RetryConfig,
  TokenBucket,
  VertexDriver,
  type DriverDeps,
} from "../src/index.js";
import { type FetchStub, fakeClock, stubFetch, stubSecrets } from "./helpers.js";

function deps(stub: FetchStub, extra: Partial<DriverDeps> = {}): DriverDeps {
  const clock = fakeClock();
  return {
    secrets: stubSecrets({ "llm/anthropic": "sk-ant", "llm/vllm": "sk-vllm", "llm/seat": "sk-seat" }),
    fetchImpl: stub.fetchImpl,
    sleep: stub.sleep,
    now: clock.now,
    random: () => 0.5,
    bucket: new TokenBucket(RateLimitConfig.parse({}), clock.now),
    retry: RetryConfig.parse({}),
    ...extra,
  };
}

const call = { model: "claude-x", system: "be brief", prompt: "hello", maxTokens: 512, temperature: 0 };

const anthropicOk = {
  content: [{ type: "text", text: "part one " }, { type: "thinking" }, { type: "text", text: "part two" }],
  usage: { input_tokens: 60, output_tokens: 20, cache_read_input_tokens: 40 },
};

function cfg(input: Record<string, unknown>) {
  return DriverConfig.parse(input);
}

describe("AnthropicDirectDriver (M16)", () => {
  const config = () =>
    cfg({ driver: "anthropic-direct", apiKeyRef: "llm/anthropic" }) as Extract<
      DriverConfig,
      { driver: "anthropic-direct" }
    >;

  it("calls the Messages API with the key, version and message body", async () => {
    const stub = stubFetch([{ body: anthropicOk }]);
    await new AnthropicDirectDriver(config(), deps(stub)).complete(call);

    expect(stub.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(stub.calls[0]?.headers).toMatchObject({ "x-api-key": "sk-ant", "anthropic-version": "2023-06-01" });
    expect(stub.calls[0]?.body).toEqual({
      model: "claude-x",
      max_tokens: 512,
      temperature: 0,
      system: "be brief",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
  });

  it("joins text blocks and derives the cache share from the usage block", async () => {
    const stub = stubFetch([{ body: anthropicOk }]);
    const result = await new AnthropicDirectDriver(config(), deps(stub)).complete(call);

    expect(result).toEqual({ text: "part one part two", tokensIn: 100, tokensOut: 20, cachePct: 40 });
  });

  it("reports no cache share when the provider does not report one", async () => {
    const stub = stubFetch([{ body: { content: [{ type: "text", text: "hi" }], usage: { input_tokens: 5, output_tokens: 1 } } }]);
    const result = await new AnthropicDirectDriver(config(), deps(stub)).complete(call);

    expect(result.cachePct).toBeNull();
    expect(result.tokensIn).toBe(5);
  });

  it("uses the subscription seat credential when one is supplied (M55)", async () => {
    const stub = stubFetch([{ body: anthropicOk }]);
    await new AnthropicDirectDriver(config(), deps(stub)).complete({ ...call, credentialRef: "llm/seat" });

    expect(stub.calls[0]?.headers["x-api-key"]).toBe("sk-seat");
  });

  it("omits the system field when there is no system prompt", async () => {
    const stub = stubFetch([{ body: anthropicOk }]);
    await new AnthropicDirectDriver(config(), deps(stub)).complete({ ...call, system: null });

    expect(stub.calls[0]?.body).not.toHaveProperty("system");
  });

  it("rejects a response with no text or a shape it cannot read", async () => {
    const empty = stubFetch([{ body: { content: [{ type: "thinking" }], usage: { input_tokens: 1, output_tokens: 1 } } }]);
    await expect(new AnthropicDirectDriver(config(), deps(empty)).complete(call)).rejects.toBeInstanceOf(
      LlmResponseError,
    );

    const wrong = stubFetch([{ body: { content: [{ type: "text", text: "hi" }] } }]);
    await expect(new AnthropicDirectDriver(config(), deps(wrong)).complete(call)).rejects.toThrow(/usage/);
  });

  it("trims a trailing slash on the configured base url", async () => {
    const stub = stubFetch([{ body: anthropicOk }]);
    const proxied = cfg({
      driver: "anthropic-direct",
      apiKeyRef: "llm/anthropic",
      baseUrl: "https://egress.internal.bank/anthropic/",
    }) as Extract<DriverConfig, { driver: "anthropic-direct" }>;

    await new AnthropicDirectDriver(proxied, deps(stub)).complete(call);
    expect(stub.calls[0]?.url).toBe("https://egress.internal.bank/anthropic/v1/messages");
  });
});

describe("OpenAiCompatDriver (M16 on-prem lane)", () => {
  const config = () =>
    cfg({ driver: "openai-compat", baseUrl: "https://vllm.internal.bank", apiKeyRef: "llm/vllm", onPrem: true }) as Extract<
      DriverConfig,
      { driver: "openai-compat" }
    >;

  const okBody = {
    choices: [{ message: { content: "answer" } }],
    usage: { prompt_tokens: 80, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 20 } },
  };

  it("posts a chat completion with bearer auth and a system message", async () => {
    const stub = stubFetch([{ body: okBody }]);
    const result = await new OpenAiCompatDriver(config(), deps(stub)).complete(call);

    expect(stub.calls[0]?.url).toBe("https://vllm.internal.bank/v1/chat/completions");
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer sk-vllm");
    expect(stub.calls[0]?.body).toEqual({
      model: "claude-x",
      max_tokens: 512,
      temperature: 0,
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "hello" },
      ],
    });
    expect(result).toEqual({ text: "answer", tokensIn: 80, tokensOut: 10, cachePct: 25 });
  });

  it("drops the system message when there is none", async () => {
    const stub = stubFetch([{ body: okBody }]);
    await new OpenAiCompatDriver(config(), deps(stub)).complete({ ...call, system: null });

    expect(stub.calls[0]?.body).toMatchObject({ messages: [{ role: "user", content: "hello" }] });
  });

  it("rejects a null or empty first choice instead of returning empty text", async () => {
    const stub = stubFetch([{ body: { choices: [{ message: { content: null } }], usage: { prompt_tokens: 1, completion_tokens: 0 } } }]);
    await expect(new OpenAiCompatDriver(config(), deps(stub)).complete(call)).rejects.toBeInstanceOf(LlmResponseError);
  });

  it("reports no cache share when the server omits the details block", async () => {
    const stub = stubFetch([{ body: { choices: [{ message: { content: "a" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } } }]);
    const result = await new OpenAiCompatDriver(config(), deps(stub)).complete(call);

    expect(result.cachePct).toBeNull();
  });
});

describe("cloud driver skeletons (M16 config + failure path)", () => {
  const bedrockCfg = () =>
    cfg({ driver: "aws-bedrock", region: "eu-central-1" }) as Extract<DriverConfig, { driver: "aws-bedrock" }>;
  const vertexCfg = () =>
    cfg({ driver: "google-vertex", projectId: "bank-ai", location: "europe-west4" }) as Extract<
      DriverConfig,
      { driver: "google-vertex" }
    >;

  it("bedrock refuses to call without an injected SigV4 signer", async () => {
    const stub = stubFetch([]);
    await expect(new BedrockDriver(bedrockCfg(), deps(stub)).complete(call)).rejects.toBeInstanceOf(LlmConfigError);
    expect(stub.calls).toHaveLength(0);
  });

  it("bedrock signs the regional invoke endpoint and parses the Messages response", async () => {
    const stub = stubFetch([{ body: anthropicOk }]);
    const signed: string[] = [];
    const driver = new BedrockDriver(
      bedrockCfg(),
      deps(stub, {
        signRequest: (req) => {
          signed.push(req.url);
          return Promise.resolve({ authorization: "AWS4-HMAC-SHA256 ...", "x-amz-date": "20260808T090000Z" });
        },
      }),
    );

    const result = await driver.complete(call);

    expect(signed).toEqual(["https://bedrock-runtime.eu-central-1.amazonaws.com/model/claude-x/invoke"]);
    expect(stub.calls[0]?.headers["authorization"]).toBe("AWS4-HMAC-SHA256 ...");
    expect(stub.calls[0]?.body).toEqual({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 512,
      temperature: 0,
      system: "be brief",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    });
    expect(result.tokensIn).toBe(100);
  });

  it("bedrock honours a VPC endpoint override", async () => {
    const stub = stubFetch([{ body: anthropicOk }]);
    const withVpc = cfg({
      driver: "aws-bedrock",
      region: "eu-central-1",
      baseUrl: "https://vpce-123.bedrock-runtime.eu-central-1.vpce.amazonaws.com/",
    }) as Extract<DriverConfig, { driver: "aws-bedrock" }>;

    await new BedrockDriver(withVpc, deps(stub, { signRequest: () => Promise.resolve({}) })).complete(call);
    expect(stub.calls[0]?.url).toBe(
      "https://vpce-123.bedrock-runtime.eu-central-1.vpce.amazonaws.com/model/claude-x/invoke",
    );
  });

  it("vertex refuses to call without an injected token provider", async () => {
    const stub = stubFetch([]);
    await expect(new VertexDriver(vertexCfg(), deps(stub)).complete(call)).rejects.toBeInstanceOf(LlmConfigError);
    expect(stub.calls).toHaveLength(0);
  });

  it("vertex calls rawPredict on the publisher model with a bearer token", async () => {
    const stub = stubFetch([{ body: anthropicOk }]);
    const driver = new VertexDriver(vertexCfg(), deps(stub, { accessToken: () => Promise.resolve("ya29.token") }));

    const result = await driver.complete(call);

    expect(stub.calls[0]?.url).toBe(
      "https://europe-west4-aiplatform.googleapis.com/v1/projects/bank-ai/locations/europe-west4/publishers/anthropic/models/claude-x:rawPredict",
    );
    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer ya29.token");
    expect(stub.calls[0]?.body).toMatchObject({ anthropic_version: "vertex-2023-10-16" });
    expect(result.text).toBe("part one part two");
  });
});

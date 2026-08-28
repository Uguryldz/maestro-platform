import type { ApiDriverId } from "@maestro/contracts";
import type { DriverConfig } from "./config.js";
import { messagesBody, parseMessagesResponse, trimSlash } from "./driver-anthropic.js";
import type { DriverCall, DriverDeps, DriverResult, LlmDriver } from "./driver-types.js";
import { LlmConfigError } from "./errors.js";
import { postJson } from "./http.js";

/**
 * SKELETONS (M16 "written from day one, activated by config"). Endpoint,
 * config validation and the failure path are real and tested; the request body
 * is the minimal Messages payload and the credential machinery is INJECTED —
 * SigV4 signing and Google OAuth are deliberately outside this package (see
 * RAPOR.md §"intentionally left out"). Without those deps the driver refuses
 * to run instead of sending an unauthenticated request.
 */

/** `aws-bedrock`: POST /model/{modelId}/invoke, headers produced by an injected signer. */
export class BedrockDriver implements LlmDriver {
  readonly id: ApiDriverId = "aws-bedrock";

  constructor(
    private readonly cfg: Extract<DriverConfig, { driver: "aws-bedrock" }>,
    private readonly deps: DriverDeps,
  ) {}

  async complete(call: DriverCall): Promise<DriverResult> {
    const sign = this.deps.signRequest;
    if (!sign) {
      throw new LlmConfigError("aws-bedrock requires deps.signRequest (SigV4 signer) — refusing to call unsigned");
    }
    const url = `${this.endpoint()}/model/${encodeURIComponent(call.model)}/invoke`;
    const body = messagesBody(call, { anthropic_version: this.cfg.anthropicVersion });
    const headers = await sign({ method: "POST", url, body: JSON.stringify(body) });

    const json = await postJson(
      { driver: this.id, url, headers: { accept: "application/json", ...headers }, body, timeoutMs: this.cfg.timeoutMs },
      { deps: this.deps, bucket: this.deps.bucket, retry: this.deps.retry, counter: call.counter },
    );
    return parseMessagesResponse(this.id, json);
  }

  private endpoint(): string {
    return trimSlash(this.cfg.baseUrl ?? `https://bedrock-runtime.${this.cfg.region}.amazonaws.com`);
  }
}

/** `google-vertex`: publisher rawPredict, bearer token produced by an injected provider. */
export class VertexDriver implements LlmDriver {
  readonly id: ApiDriverId = "google-vertex";

  constructor(
    private readonly cfg: Extract<DriverConfig, { driver: "google-vertex" }>,
    private readonly deps: DriverDeps,
  ) {}

  async complete(call: DriverCall): Promise<DriverResult> {
    const accessToken = this.deps.accessToken;
    if (!accessToken) {
      throw new LlmConfigError("google-vertex requires deps.accessToken (OAuth token provider)");
    }
    const { projectId, location } = this.cfg;
    const url =
      `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
      `/locations/${location}/publishers/anthropic/models/${encodeURIComponent(call.model)}:rawPredict`;

    const json = await postJson(
      {
        driver: this.id,
        url,
        headers: { authorization: `Bearer ${await accessToken()}`, accept: "application/json" },
        body: messagesBody(call, { anthropic_version: this.cfg.anthropicVersion }),
        timeoutMs: this.cfg.timeoutMs,
      },
      { deps: this.deps, bucket: this.deps.bucket, retry: this.deps.retry, counter: call.counter },
    );
    return parseMessagesResponse(this.id, json);
  }
}

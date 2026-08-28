import { readFileSync } from "node:fs";
import { parseDotEnv } from "@maestro/secrets";

/**
 * Reads `maestro/.env` (git-ignored) with the same parser the env-file secret
 * driver uses. Values are returned, never printed: the only consumer is the
 * SecretPort record built in `secrets.ts`.
 */
export function loadRepoEnv(): Record<string, string> {
  const path = new URL("../../../.env", import.meta.url);
  try {
    return parseDotEnv(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export interface OpenRouterEnv {
  apiKey: string;
  /**
   * Base URL WITHOUT the `/v1` suffix: the `openai-compat` driver appends
   * `/v1/chat/completions` itself, so a base that already ends in `/v1` would
   * produce `/v1/v1/chat/completions`.
   */
  baseUrl: string;
}

/**
 * Resolves the OpenRouter credentials. Fails loudly and in Turkish — a demo
 * that silently runs without a model would be the "fake success" this repo
 * refuses everywhere else.
 */
export function resolveOpenRouter(env: Record<string, string>): OpenRouterEnv {
  const apiKey = process.env["OPENROUTER_API_KEY"] ?? env["OPENROUTER_API_KEY"] ?? "";
  if (apiKey.trim().length === 0) {
    throw new Error(
      "OPENROUTER_API_KEY bulunamadı. maestro/.env dosyasına OPENROUTER_API_KEY=... satırını ekleyin.",
    );
  }
  const raw = process.env["OPENROUTER_BASE_URL"] ?? env["OPENROUTER_BASE_URL"] ?? "https://openrouter.ai/api";
  return { apiKey: apiKey.trim(), baseUrl: raw.trim().replace(/\/+$/, "").replace(/\/v1$/, "") };
}

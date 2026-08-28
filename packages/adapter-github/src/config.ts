import { z } from "zod";
import { GithubConfigError } from "./errors.js";

/**
 * GitHub SCM driver configuration.
 *
 * One driver, two deployments:
 *  - github.com (cloud)      → REST at https://api.github.com,
 *                              GraphQL at https://api.github.com/graphql
 *  - GitHub Enterprise Server → REST at https://<host>/api/v3,
 *                              GraphQL at https://<host>/api/graphql
 *
 * Unlike Azure DevOps there is no collection/org split in the URL — the owner
 * and repo travel in the path of every call — so the only base decision is
 * cloud vs. an enterprise host, expressed as two explicit roots rather than
 * one guessed-at rewrite of `apiBaseUrl` into a GraphQL URL.
 */

/**
 * The `X-GitHub-Api-Version` header. GitHub dates its REST versions; pinning
 * one keeps the integration from silently drifting when GitHub ships a new
 * default. Overridable per install for a GHES box on a different cadence.
 */
export const GITHUB_API_VERSION = "2022-11-28";

/** Ceiling for a runner push credential when the config does not set one (M31). */
export const DEFAULT_MAX_PUSH_TTL_SECONDS = 3600;

/** Hardest ceiling: no deployment may configure a longer-lived push credential. */
export const PUSH_TTL_CEILING_SECONDS = 86_400;

const NonEmpty = z.string().trim().min(1);

/** A GitHub REST api-version date, e.g. "2022-11-28". */
const ApiVersion = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const commonFields = {
  /**
   * Key handed to the SecretPort — the adapter never holds a raw token (M80).
   * Resolves to a fine-grained PAT or a GitHub App installation token; both
   * are Bearer tokens as far as this driver is concerned.
   */
  tokenRef: NonEmpty,
  apiVersion: ApiVersion.optional(),
  /** Upper bound the driver enforces on `getPushCredential` TTLs (M31). */
  maxPushTtlSeconds: z
    .number()
    .int()
    .positive()
    .max(PUSH_TTL_CEILING_SECONDS)
    .default(DEFAULT_MAX_PUSH_TTL_SECONDS),
  /** Local development escape hatch for a plain-HTTP base URL; never in a bank. */
  allowInsecureHttp: z.boolean().default(false),
};

/**
 * The token travels in a Bearer header, so the transport decides whether it
 * travels in clear text. `z.url()` alone accepts `ftp:` and `javascript:`,
 * which is why the scheme is checked explicitly rather than by pattern.
 */
function checkUrlScheme(
  value: string | undefined,
  field: string,
  allowInsecureHttp: boolean,
): { message: string; path: string[]; input: unknown } | null {
  if (value === undefined) return null;
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    return { message: `${field} is not an absolute URL`, path: [field], input: value };
  }
  if (protocol === "https:") return null;
  if (protocol === "http:" && allowInsecureHttp) return null;
  const hint = protocol === "http:" ? "; set allowInsecureHttp for local development only" : "";
  return { message: `${field} must use https (got ${protocol}${hint})`, path: [field], input: value };
}

const CloudConfig = z
  .object({
    mode: z.literal("cloud").default("cloud"),
    apiBaseUrl: z.url().default("https://api.github.com"),
    graphqlUrl: z.url().default("https://api.github.com/graphql"),
    ...commonFields,
  })
  .check((ctx) => {
    const v = ctx.value;
    for (const issue of [
      checkUrlScheme(v.apiBaseUrl, "apiBaseUrl", v.allowInsecureHttp),
      checkUrlScheme(v.graphqlUrl, "graphqlUrl", v.allowInsecureHttp),
    ]) {
      if (issue) ctx.issues.push({ code: "custom", ...issue });
    }
  });

const EnterpriseConfig = z
  .object({
    mode: z.literal("enterprise"),
    /** REST root of the GHES box, e.g. https://ghe.bank.local/api/v3 */
    apiBaseUrl: z.url(),
    /** GraphQL endpoint of the GHES box, e.g. https://ghe.bank.local/api/graphql */
    graphqlUrl: z.url(),
    ...commonFields,
  })
  .check((ctx) => {
    const v = ctx.value;
    for (const issue of [
      checkUrlScheme(v.apiBaseUrl, "apiBaseUrl", v.allowInsecureHttp),
      checkUrlScheme(v.graphqlUrl, "graphqlUrl", v.allowInsecureHttp),
    ]) {
      if (issue) ctx.issues.push({ code: "custom", ...issue });
    }
  });

export const GithubConfig = z.discriminatedUnion("mode", [CloudConfig, EnterpriseConfig]);
export type GithubConfig = z.infer<typeof GithubConfig>;

/** Parses driver config, turning Zod issues into one typed error (fail-closed). */
export function parseGithubConfig(input: unknown): GithubConfig {
  // A bare object with no `mode` is the common cloud case; default it in so
  // callers do not have to spell out "cloud" for github.com.
  const seeded =
    input !== null && typeof input === "object" && !("mode" in (input as object))
      ? { mode: "cloud", ...(input as object) }
      : input;
  const parsed = GithubConfig.safeParse(seeded);
  if (!parsed.success) {
    throw new GithubConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** The api-version this config sends, honouring an explicit override. */
export function apiVersionFor(config: GithubConfig): string {
  return config.apiVersion ?? GITHUB_API_VERSION;
}

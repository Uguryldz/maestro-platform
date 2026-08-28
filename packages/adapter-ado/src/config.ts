import { z } from "zod";
import { AdoConfigError } from "./errors.js";

/**
 * Dual-mode configuration (M11): one driver, two deployments.
 *
 *  - `server`   → Azure DevOps Server 2022 / TFS on premises:
 *                 https://<host>[/tfs]/<Collection>/<Project>/_apis/...
 *  - `services` → Azure DevOps Services (cloud):
 *                 https://dev.azure.com/<org>/<Project>/_apis/...
 *
 * The collection only exists on premises, which is why the two shapes are a
 * discriminated union instead of one loose object with optional fields.
 */
export const AdoMode = z.enum(["server", "services"]);
export type AdoMode = z.infer<typeof AdoMode>;

/**
 * api-version is pinned PER MODE, never guessed at call time. Both product
 * lines publish several monikers (Server 2022 serves 6.0 through 7.1, and
 * Services keeps older ones alive), but an on-prem collection upgrades on
 * the bank's own cadence: the version a deployment is *known* to serve is a
 * deployment fact, not a call-site guess. Unpinned api-versions are how
 * integrations silently rot across upgrades, so each mode gets the lowest
 * version that carries every field this adapter reads, overridable per
 * install for a collection that has moved on.
 */
export const ADO_API_VERSIONS: Record<AdoMode, string> = {
  server: "6.0",
  services: "7.1",
};

/** Ceiling for a runner push credential when the config does not set one (M31). */
export const DEFAULT_MAX_PUSH_TTL_SECONDS = 3600;

/** Hardest ceiling: no deployment may configure a longer-lived push credential. */
export const PUSH_TTL_CEILING_SECONDS = 86_400;

const NonEmpty = z.string().trim().min(1);

/** A single api-version override, e.g. "7.0" or "7.1-preview.1". */
const ApiVersion = z.string().regex(/^\d+\.\d+(-preview(\.\d+)?)?$/);

/**
 * One build definition whose `build.complete` events may close the 10b CI
 * gate. Project and repository are part of the key on purpose: build ids and
 * definition ids are only unique inside a project, so a definition id alone
 * would let another project's pipeline answer for this repository.
 */
export const AdoPrValidationBuild = z.object({
  project: NonEmpty,
  repository: NonEmpty,
  definitionId: z.number().int().positive(),
});
export type AdoPrValidationBuild = z.infer<typeof AdoPrValidationBuild>;

/**
 * CI ingest configuration. Mandatory in both modes: without it a webhook
 * endpoint would either run unauthenticated or accept any pipeline's verdict
 * as the PR's verdict (fail-closed, M12).
 */
export const AdoCiConfig = z.object({
  /** SecretPort key of the Service Hook basic-auth shared secret. */
  webhookSecretRef: NonEmpty,
  /** Username half of the Service Hook credential; ADO allows it empty. */
  webhookUsername: z.string().default(""),
  /** Allow-list of PR-validation definitions; empty is refused, not "allow all". */
  prValidationBuilds: z
    .array(AdoPrValidationBuild)
    .min(1, "at least one PR validation build definition must be allow-listed"),
});
export type AdoCiConfig = z.infer<typeof AdoCiConfig>;

const commonFields = {
  /** Key handed to the SecretPort — the adapter never holds a raw PAT (M80). */
  tokenRef: NonEmpty,
  apiVersion: ApiVersion.optional(),
  ci: AdoCiConfig,
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
 * The PAT travels in a basic auth header, so the transport decides whether it
 * travels in clear text. `z.url()` alone accepts `ftp:` and `javascript:` as
 * well, which is why the scheme is checked explicitly rather than by pattern.
 */
function checkBaseUrlScheme(value: { baseUrl: string; allowInsecureHttp: boolean }): string[] {
  let protocol: string;
  try {
    protocol = new URL(value.baseUrl).protocol;
  } catch {
    return ["baseUrl is not an absolute URL"];
  }
  if (protocol === "https:") return [];
  if (protocol === "http:" && value.allowInsecureHttp) return [];
  return [
    `baseUrl must use https (got ${protocol}` +
      `${protocol === "http:" ? "; set allowInsecureHttp for local development only" : ""})`,
  ];
}

const withSchemeCheck = <T extends z.ZodObject>(schema: T): T =>
  schema.check((ctx) => {
    const value = ctx.value as { baseUrl: string; allowInsecureHttp: boolean };
    for (const message of checkBaseUrlScheme(value)) {
      ctx.issues.push({ code: "custom", message, input: value.baseUrl, path: ["baseUrl"] });
    }
  }) as T;

const ServerConfig = withSchemeCheck(
  z.object({
    mode: z.literal("server"),
    /** Server root, with or without a virtual directory: https://tfs.bank.local/tfs */
    baseUrl: z.url(),
    /** On-prem collection; may itself be a multi-segment path. */
    collection: NonEmpty,
    ...commonFields,
  }),
);

const ServicesConfig = withSchemeCheck(
  z.object({
    mode: z.literal("services"),
    org: NonEmpty,
    baseUrl: z.url().default("https://dev.azure.com"),
    ...commonFields,
  }),
);

export const AdoConfig = z.discriminatedUnion("mode", [ServerConfig, ServicesConfig]);
export type AdoConfig = z.infer<typeof AdoConfig>;

/** Parses driver config, turning Zod issues into one typed error (fail-closed). */
export function parseAdoConfig(input: unknown): AdoConfig {
  const parsed = AdoConfig.safeParse(input);
  if (!parsed.success) {
    throw new AdoConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** The api-version this config sends, honouring an explicit override. */
export function apiVersionFor(config: AdoConfig): string {
  return config.apiVersion ?? ADO_API_VERSIONS[config.mode];
}

function encodePath(segment: string): string {
  // A collection may be a multi-segment path ("tfs/DefaultCollection"); each
  // segment is encoded separately so the separators survive.
  return segment
    .split("/")
    .filter((s) => s.length > 0)
    .map(encodeURIComponent)
    .join("/");
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Project-scoped `_apis` root for the configured mode.
 * Server: <baseUrl>/<collection>/<project>/_apis
 * Services: <baseUrl>/<org>/<project>/_apis
 */
export function apiRoot(config: AdoConfig, project: string): string {
  const owner = config.mode === "server" ? config.collection : config.org;
  return `${trimTrailingSlash(config.baseUrl)}/${encodePath(owner)}/${encodePath(project)}/_apis`;
}

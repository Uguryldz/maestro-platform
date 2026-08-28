import { NonEmpty } from "@maestro/contracts";
import { z } from "zod";
import { isProductionStage } from "./stage.js";

export const SECRET_PORT = "secret";
export const VAULT_DRIVER = "vault";
export const ENV_FILE_DRIVER = "env-file";

/** Mount names an allow-list may contain — same grammar as a key's first segment. */
const Mount = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);

/**
 * Least privilege (M6): a driver refuses any key outside these KV mounts
 * BEFORE doing I/O, so a typo'd reference cannot walk another team's tree.
 */
const AllowedMounts = z.array(Mount).min(1);

/** 0 disables the in-memory cache; every entry is evicted at its deadline. */
const CacheTtlSeconds = z.number().int().min(0).max(300);

/**
 * Short-lived credential issuance (M31/M6): dynamic secrets read from
 * `<mount>/<pathPrefix>/<scope>`. `maxTtlSeconds` is the hard ceiling — a
 * larger request is rejected, never silently clamped.
 */
export const ShortLivedConfig = z.object({
  mount: Mount.default("git"),
  pathPrefix: NonEmpty.default("creds"),
  field: NonEmpty.default("token"),
  maxTtlSeconds: z.number().int().positive().max(86_400).default(900),
});
export type ShortLivedConfig = z.infer<typeof ShortLivedConfig>;

/**
 * TLS check for the Vault address. Everything that matters travels over this
 * connection in the clear otherwise: the AppRole `secret_id` on the way in and
 * the client token on the way back. Plain http is therefore a credential
 * disclosure, allowed only as an explicit, opt-in dev convenience (local
 * `http://127.0.0.1:8200`) and never in production, escape hatch or not.
 *
 * Returns the reason it is refused, or null when the address is acceptable.
 */
export function vaultAddrIssue(config: { addr: string; allowInsecureAddr?: boolean }): string | null {
  if (/^https:\/\//i.test(config.addr)) return null;
  if (isProductionStage()) {
    return `addr "${config.addr}" is not https — Vault must be reached over TLS in production (M6)`;
  }
  if (config.allowInsecureAddr !== true) {
    return `addr "${config.addr}" is not https — set allowInsecureAddr: true to accept it outside production`;
  }
  return null;
}

export const VaultConfig = z.object({
  allowedMounts: AllowedMounts,
  cacheTtlSeconds: CacheTtlSeconds.default(30),
  addr: z.url(),
  /** Dev-only opt-in for a plain-http `addr`; ignored in production. */
  allowInsecureAddr: z.boolean().default(false),
  /** Vault Enterprise namespace header, if the bank uses one. */
  namespace: NonEmpty.optional(),
  /** AppRole auth mount; role_id/secret_id are runtime deps, never config. */
  approleMount: Mount.default("approle"),
  requestTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
  /** Renew this many seconds before the client token's lease actually ends. */
  tokenRenewSkewSeconds: z.number().int().min(1).max(3_600).default(60),
  shortLived: ShortLivedConfig.prefault({}),
}).superRefine((config, ctx) => {
  const issue = vaultAddrIssue(config);
  if (issue) ctx.addIssue({ code: "custom", path: ["addr"], message: issue });
});
export type VaultConfig = z.infer<typeof VaultConfig>;

export const EnvFileConfig = z.object({
  allowedMounts: AllowedMounts,
  /** Dev only, so caching buys nothing and only widens the leak window. */
  cacheTtlSeconds: CacheTtlSeconds.default(0),
  /** Optional dotenv-style file; process env (or an injected record) wins over it. */
  filePath: NonEmpty.optional(),
  envPrefix: z.string().regex(/^[A-Z][A-Z0-9_]*_$/).default("MAESTRO_SECRET_"),
});
export type EnvFileConfig = z.infer<typeof EnvFileConfig>;

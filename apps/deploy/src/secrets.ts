import type { SecretPort } from "@maestro/ports";
import { createEnvFileSecretPort, createVaultSecretPort } from "@maestro/secrets";
import { requireVaultApprole, vaultMounts, type DeployEnv } from "./env.js";
import type { Profile } from "./profile.js";

/**
 * The bootstrap port.
 *
 * Every other driver resolves its credentials through a `SecretPort`, so this
 * one cannot itself be resolved through the registry — something has to exist
 * before the registry can be built. It is constructed directly here, from the
 * profile, and then registered like any other driver so that the worker's
 * `PortSelection` can still name it.
 *
 * The two drivers are not interchangeable and the choice is not a fallback
 * chain: `prod` means Vault or nothing. There is deliberately no "try Vault,
 * fall back to environment variables" path, because that is precisely the
 * shape that turns a Vault outage into a bank running on whatever happened to
 * be in the environment.
 */
export function buildSecretPort(env: DeployEnv, profile: Profile = env.profile): SecretPort {
  return profile === "prod" ? buildVaultSecrets(env) : buildEnvFileSecrets(env);
}

function buildVaultSecrets(env: DeployEnv): SecretPort {
  const addr = env.base.VAULT_ADDR;
  if (addr === undefined) {
    // `loadEnv` already enforces this in production; the check repeats here
    // because the prod PROFILE can be selected with NODE_ENV=development
    // (a staging box), and the driver's own error would be about a bad URL.
    throw new Error('VAULT_ADDR: required by the "prod" profile — there is no fallback secret source (M6/M80)');
  }
  return createVaultSecretPort({
    addr,
    allowedMounts: vaultMounts(env),
    // The AppRole is a runtime dep, never config: it must not end up inside a
    // parsed config object that something later decides to log.
    deps: { approle: requireVaultApprole(env) },
  });
}

/**
 * Dev secrets from `MAESTRO_SECRET_*` variables.
 *
 * `nodeEnv` is passed explicitly rather than left to the driver's own
 * `process.env` lookup: the driver refuses to serve in production (M80), and
 * handing it the value this deployment actually validated means that guard
 * fires on the same fact `loadDeployEnv` checked, not on a variable a
 * container entrypoint might have set differently.
 */
function buildEnvFileSecrets(env: DeployEnv): SecretPort {
  return createEnvFileSecretPort({
    allowedMounts: vaultMounts(env),
    deps: { nodeEnv: env.base.NODE_ENV },
  });
}

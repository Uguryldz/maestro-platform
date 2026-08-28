import { readFileSync } from "node:fs";
import { parseDotEnv } from "@maestro/secrets";

/**
 * Reads `maestro/.env` (git-ignored) with the same parser the env-file secret
 * driver uses. Values are returned, never printed: the only consumers are the
 * OpenRouter resolver and the SecretPort seed built in secrets.ts.
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
   * `/v1/chat/completions` itself.
   */
  baseUrl: string;
}

/**
 * Resolves the OpenRouter credentials. Fails loudly and in Turkish — a pilot
 * that silently runs without a model would be the "fake success" this repo
 * refuses everywhere else.
 */
export function resolveOpenRouter(env: Record<string, string>, authoritative = false): OpenRouterEnv {
  const get = (key: string): string | undefined =>
    authoritative ? env[key] : process.env[key] ?? env[key];
  const apiKey = get("OPENROUTER_API_KEY") ?? "";
  if (apiKey.trim().length === 0) {
    throw new Error(
      "OPENROUTER_API_KEY bulunamadı. maestro/.env dosyasına OPENROUTER_API_KEY=... satırını ekleyin.",
    );
  }
  const raw = get("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api";
  return { apiKey: apiKey.trim(), baseUrl: raw.trim().replace(/\/+$/, "").replace(/\/v1$/, "") };
}

export interface GithubEnv {
  owner: string;
  repo: string;
  /** GitHub token — NEVER logged; handed straight to the SecretPort seed. */
  token: string;
  /** Bare host of the API base; https://api.github.com for github.com. */
  apiBaseUrl: string;
  graphqlUrl: string;
  /**
   * Base of the git remote the runner clones/pushes over HTTPS, WITHOUT the
   * `owner/repo.git` tail (that is appended per-repo). github.com by default.
   */
  gitBaseUrl: string;
}

/**
 * Resolves the GitHub edge from the environment. ONLY called when
 * `PILOT_SCM=github`; on the default `fake` path GitHub is never touched, so a
 * missing token is not an error there. When github is selected, all three of
 * GITHUB_OWNER / GITHUB_REPO / GITHUB_TOKEN are mandatory and a miss is a hard,
 * loud, Turkish failure — a github run with no token would be the "fake
 * success" this repo refuses everywhere.
 */
export function resolveGithub(env: Record<string, string>, authoritative = false): GithubEnv {
  const get = (key: string): string =>
    (authoritative ? env[key] ?? "" : process.env[key] ?? env[key] ?? "").trim();
  const owner = get("GITHUB_OWNER");
  const repo = get("GITHUB_REPO");
  const token = get("GITHUB_TOKEN");

  const missing = [
    owner.length === 0 ? "GITHUB_OWNER" : null,
    repo.length === 0 ? "GITHUB_REPO" : null,
    token.length === 0 ? "GITHUB_TOKEN" : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(
      `PILOT_SCM=github için ${missing.join(", ")} eksik. maestro/.env dosyasına ekleyin (pilot gerçek GitHub deposuna push eder).`,
    );
  }

  const strip = (value: string): string => value.replace(/\/+$/, "");
  const apiBaseUrl = strip(get("GITHUB_API_BASE_URL") || "https://api.github.com");
  const graphqlUrl = strip(get("GITHUB_GRAPHQL_URL") || "https://api.github.com/graphql");
  const gitBaseUrl = strip(get("GITHUB_GIT_BASE_URL") || "https://github.com");
  return { owner, repo, token, apiBaseUrl, graphqlUrl, gitBaseUrl };
}

export interface JiraCloudEnv {
  baseUrl: string;
  email: string;
  /** The Atlassian API token — NEVER logged; handed straight to the SecretPort. */
  apiToken: string;
}

/** Injected so the identity/fallback warning is testable and does not hard-wire console. */
export type WarnFn = (message: string) => void;

const defaultWarn: WarnFn = (message) => {
  console.warn(message);
};

/**
 * Resolves the LIVE Jira Cloud credentials from the environment — as the
 * MAESTRO BOT.
 *
 * The identity Maestro binds to is now the dedicated bot account, not the
 * operator's personal token: `email` and `apiToken` are read from
 * MAESTRO_BOT_EMAIL / MAESTRO_BOT_API_TOKEN. So Maestro sees the tickets
 * ASSIGNED to the bot and writes its gate comments under the bot identity.
 *
 * When BOTH bot values are present they win. When either is missing the
 * personal JIRA_CLOUD_EMAIL / JIRA_CLOUD_API_TOKEN are used as a fallback and a
 * loud warning is emitted — a pilot silently running under the wrong identity
 * would be exactly the "fake success" this repo refuses. `baseUrl` is always
 * JIRA_CLOUD_BASE_URL (the site is the same whichever identity connects).
 *
 * Missing the base URL, or lacking BOTH a bot and a personal identity, is a
 * hard, loud failure — the whole point of the pilot is to talk to the real
 * site, so we never fall back to a fake.
 */
export function resolveJiraCloud(
  env: Record<string, string>,
  authoritative = false,
  warn: WarnFn = defaultWarn,
): JiraCloudEnv {
  const get = (key: string): string =>
    (authoritative ? env[key] ?? "" : process.env[key] ?? env[key] ?? "").trim();
  const baseUrl = get("JIRA_CLOUD_BASE_URL");
  const botEmail = get("MAESTRO_BOT_EMAIL");
  const botToken = get("MAESTRO_BOT_API_TOKEN");
  const personalEmail = get("JIRA_CLOUD_EMAIL");
  const personalToken = get("JIRA_CLOUD_API_TOKEN");

  // The Maestro Bot identity wins whenever it is complete; otherwise fall back
  // to the personal identity with a loud warning (never silently).
  let email: string;
  let apiToken: string;
  if (botEmail.length > 0 && botToken.length > 0) {
    email = botEmail;
    apiToken = botToken;
  } else {
    email = personalEmail;
    apiToken = personalToken;
    if (botEmail.length > 0 || botToken.length > 0) {
      const missing = [
        botEmail.length === 0 ? "MAESTRO_BOT_EMAIL" : null,
        botToken.length === 0 ? "MAESTRO_BOT_API_TOKEN" : null,
      ].filter((n): n is string => n !== null);
      warn(
        `! Maestro Bot kimliği eksik (${missing.join(", ")}); kişisel JIRA_CLOUD_* kimliğine düşülüyor. ` +
          `Bot hesabıyla bağlanmak için maestro/.env dosyasına iki değeri de ekleyin.`,
      );
    } else {
      warn(
        "! Maestro Bot kimliği tanımlı değil (MAESTRO_BOT_EMAIL / MAESTRO_BOT_API_TOKEN); " +
          "kişisel JIRA_CLOUD_* kimliğine düşülüyor.",
      );
    }
  }

  const missing = [
    baseUrl.length === 0 ? "JIRA_CLOUD_BASE_URL" : null,
    email.length === 0 ? "JIRA_CLOUD_EMAIL veya MAESTRO_BOT_EMAIL" : null,
    apiToken.length === 0 ? "JIRA_CLOUD_API_TOKEN veya MAESTRO_BOT_API_TOKEN" : null,
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(
      `Canlı Jira için ${missing.join(", ")} eksik. maestro/.env dosyasına ekleyin (pilot gerçek siteye bağlanır).`,
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), email, apiToken };
}

/**
 * Resolves the Maestro Bot's Cloud accountId from MAESTRO_BOT_ACCOUNT_ID — the
 * value the assignment-based discovery JQL filters on (`assignee = "<id>"`).
 *
 * It is NEVER hard-coded. When present it flows into `discoveryJql`; when
 * missing a loud warning is emitted and an empty string is returned, which
 * `discoveryJql` renders as `currentUser()` — the query stays bounded and valid
 * but then follows whoever the token authenticates as, which is only correct if
 * the bot token is the one connected.
 */
export function resolveMaestroBotAccountId(
  env: Record<string, string>,
  authoritative = false,
  warn: WarnFn = defaultWarn,
): string {
  const get = (key: string): string =>
    (authoritative ? env[key] ?? "" : process.env[key] ?? env[key] ?? "").trim();
  const accountId = get("MAESTRO_BOT_ACCOUNT_ID");
  if (accountId.length === 0) {
    warn(
      "! MAESTRO_BOT_ACCOUNT_ID tanımlı değil; keşif JQL'i assignee = currentUser() ile çalışacak " +
        "(bağlı token neyse ona atanmış ticket'lar). Atama tabanlı keşif için maestro/.env dosyasına ekleyin.",
    );
  }
  return accountId;
}

/**
 * Resolves the REQUESTER's Cloud accountId from MAESTRO_REQUESTER_ACCOUNT_ID —
 * the person a ticket is handed BACK to when the intake role finds it too thin
 * to analyse (the İADE branch). Same injectable-env contract as the bot id: when
 * `authoritative`, only the injected map is read; otherwise `process.env` layers
 * over it.
 *
 * NEVER hard-coded, and empty is a valid "not configured" state — an empty
 * string turns the return branch's REASSIGN into a no-op (the ticket is still
 * moved to the backlog, just not reassigned), with a loud warning, rather than
 * throwing at boot. This is the BOOTSTRAP seed only; the running system is meant
 * to read it as a UI-editable param (Studio), never from env at use time.
 */
export function resolveMaestroRequesterAccountId(
  env: Record<string, string>,
  authoritative = false,
  warn: WarnFn = defaultWarn,
): string {
  const get = (key: string): string =>
    (authoritative ? env[key] ?? "" : process.env[key] ?? env[key] ?? "").trim();
  const accountId = get("MAESTRO_REQUESTER_ACCOUNT_ID");
  if (accountId.length === 0) {
    warn(
      "! MAESTRO_REQUESTER_ACCOUNT_ID tanımlı değil; uygun-değil (İADE) dalında ticket geri " +
        "atanamaz — yalnız statüsü geri alınır. Talep açana geri atama için maestro/.env dosyasına ekleyin.",
    );
  }
  return accountId;
}

/**
 * Resolves the Analyst Manager's Cloud accountId from MAESTRO_MANAGER_ACCOUNT_ID
 * — the person a ticket is handed to for ANALYSIS APPROVAL (onay devri). When the
 * analysis is complete and its Word/PDF are attached, the pilot reassigns the
 * ticket to this accountId and moves it into review ("İNCELEMEDE"), so the
 * approval physically sits in the manager's queue. Same injectable-env contract
 * as the bot/requester ids: when `authoritative`, only the injected map is read;
 * otherwise `process.env` layers over it.
 *
 * NEVER hard-coded, and empty is a valid "not configured" state — an empty string
 * turns the analysis-handover REASSIGN into a no-op (the ticket is still moved
 * into review, just not reassigned), with a loud warning, rather than throwing at
 * boot. This is the BOOTSTRAP seed only; the running system is meant to read it
 * as a UI-editable param (Studio), never from env at use time.
 */
export function resolveMaestroManagerAccountId(
  env: Record<string, string>,
  authoritative = false,
  warn: WarnFn = defaultWarn,
): string {
  const get = (key: string): string =>
    (authoritative ? env[key] ?? "" : process.env[key] ?? env[key] ?? "").trim();
  const accountId = get("MAESTRO_MANAGER_ACCOUNT_ID");
  if (accountId.length === 0) {
    warn(
      "! MAESTRO_MANAGER_ACCOUNT_ID tanımlı değil; analiz onayı dalında ticket Analist Yönetici'ye " +
        "atanamaz — yalnız statüsü İNCELEMEDE'ye taşınır. Onay devri için maestro/.env dosyasına ekleyin.",
    );
  }
  return accountId;
}

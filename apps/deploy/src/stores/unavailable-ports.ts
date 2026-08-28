import type { CiPort, ScanPort, WorkPort } from "@maestro/ports";

/**
 * The ports that are WIRED but not yet CONFIGURED: work, ci and scan.
 *
 * Each needs something an operator has to supply before it can do anything — a
 * Jira address, a PR-validation allow-list (M12), a digest-pinned scanner image
 * (M27) — and none has a default that would be safe to invent. So the port
 * exists, it composes, and it answers with a sentence naming what is missing
 * and where it is set.
 *
 * WHY THE SENTENCE CHANGED. These used to say "bu sürüm bunu yapmaz" and told
 * the operator to change `MAESTRO_PROFILE`. Both halves were wrong, and wrong
 * in a way that cost a run: the product DOES do this, and the thing standing in
 * the way was not a release boundary but an empty setting. An operator reading
 * the old message had no reason to look at the panel — they had been told to go
 * and edit a file on the server, or that the feature did not exist at all.
 *
 * The `scm` port is NOT here any more, deliberately. It was the entry that made
 * a deployment decide whether the product could write code: the wizard offered
 * "Hata düzeltme", the rule was written, the run started, and the engineering
 * step met a refusal that came from a profile string. The real GitHub driver is
 * composed for every deployment now, and whether an install can reach a
 * repository is a question about a CONNECTION — which the setup wizard reads
 * and reports BEFORE the operator commits to a flow, rather than three steps
 * and one human approval later.
 *
 * Same shape as before, and for the same reason: reject with a named error,
 * never resolve with an empty value. A stub that answered "no findings" would
 * let a gate that blocks on findings pass on a repository nobody scanned.
 */

/**
 * The marker every message here carries.
 *
 * It is what makes the difference between "not set up yet" and "broken"
 * MACHINE-READABLE. A caller that catches one of these rejections can tell the
 * operator which setting is empty instead of rendering a stack trace, and a
 * test can assert the state is reported rather than swallowed.
 */
export const NOT_CONFIGURED_MARKER = "MAESTRO_NOT_CONFIGURED";

/** Whether a thrown value is one of these "not configured yet" refusals. */
export function isNotConfigured(error: unknown): boolean {
  return error instanceof Error && error.message.includes(NOT_CONFIGURED_MARKER);
}

const WHY_CI =
  `${NOT_CONFIGURED_MARKER} ci: build doğrulaması bu kurulumda henüz yapılandırılmadı. ` +
  "PR'lar açılır ve incelenebilir; yalnızca yapı sonucunu bekleyen kapı çalışmaz. " +
  "Açmak için Ayarlar'dan bir CI bağlantısı tanımlayın ve doğrulama yapılarını listeleyin (M12).";

const WHY_SCAN =
  `${NOT_CONFIGURED_MARKER} scan: kod taraması bu kurulumda henüz yapılandırılmadı. ` +
  "Boş sonuç DÖNDÜRÜLMEZ — taranmamış bir depo 'bulgu yok' olarak okunamaz (M27). " +
  "Açmak için tarayıcı imajını digest'e sabitleyerek tanımlayın (SCAN_IMAGE_TRIVY).";

const WHY_WORK =
  `${NOT_CONFIGURED_MARKER} work: bu kuruluma henüz bir Jira adresi tanımlanmadı. ` +
  "Jira Cloud kullanıyorsanız JIRA_CLOUD_BASE_URL, Jira Data Center kullanıyorsanız " +
  "JIRA_BASE_URL değişkenini doldurun — ikisi İKİ AYRI sürücüyü besler, yalnızca birini yazın.";

/**
 * The work port of an install that has not been given a Jira yet.
 *
 * A FRESH STACK MUST BOOT. That is the whole reason this exists: the wizard is
 * how a Jira gets configured, and a process that refuses to start until one is
 * configured can never be configured through its own panel. Composing a port
 * that fails on first USE keeps the panel reachable while still making the gap
 * impossible to mistake for working.
 *
 * `verifyWebhook` and `parseCommand` reject rather than answering "not mine".
 * Both are tempting to make permissive — a webhook this install cannot verify
 * is arguably not its business — but a silent `null` would turn an unconfigured
 * Jira into a stream of ignored tickets, which looks exactly like a working
 * install that nobody assigned anything to.
 */
export function notConfiguredWorkPort(): WorkPort {
  const refuse = (): Promise<never> => Promise.reject(new Error(WHY_WORK));
  return {
    verifyWebhook: refuse,
    getTicket: refuse,
    addComment: refuse,
    updateComment: refuse,
    setLabels: refuse,
    assign: refuse,
    createLinkedIssue: refuse,
    parseCommand: refuse,
    verifyMembership: refuse,
    transition: refuse,
  };
}

/**
 * The CI port's one method.
 *
 * `parseBuildEvent` may legitimately answer `null` — "this webhook is not a
 * build result" — so refusing here is a deliberate choice rather than a
 * transcription of the interface: a deployment that runs no builds should not
 * be receiving build webhooks, and answering `null` would make a misrouted CI
 * hook look like an ordinary uninteresting one.
 */
export function notConfiguredCiPort(): CiPort {
  return {
    parseBuildEvent: () => Promise.reject(new Error(WHY_CI)),
  };
}

/**
 * Rejecting rather than answering "no findings" is the point: a scan port that
 * resolved with an empty result would let a gate that blocks on findings pass
 * on a repository nobody scanned (M27).
 */
export function notConfiguredScanPort(): ScanPort {
  return {
    run: () => Promise.reject(new Error(WHY_SCAN)),
  };
}

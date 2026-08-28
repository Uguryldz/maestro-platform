import { z } from "zod";

/** Non-empty trimmed string — the default for any human-facing text field. */
export const NonEmpty = z.string().trim().min(1);

/** Jira issue key, e.g. UGURPAY-123 (Jira DC — M46). */
export const TicketKey = z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/);
export type TicketKey = z.infer<typeof TicketKey>;

/** Jira project key, e.g. UGURPAY. */
export const ProjectKey = z.string().regex(/^[A-Z][A-Z0-9]+$/);
export type ProjectKey = z.infer<typeof ProjectKey>;

/** Application id in the Application Registry (M100). */
export const AppId = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
export type AppId = z.infer<typeof AppId>;

/**
 * Temporal workflow run id. Charset is constrained because the id becomes a
 * SINGLE path segment in storage keys (evidence/<year>/<ticket>/<runId>/…):
 * a slash inside it writes a key that can never be parsed back.
 */
export const RunId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,}$/);
export type RunId = z.infer<typeof RunId>;

export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export type Sha256Hex = z.infer<typeof Sha256Hex>;

export const GitSha = z.string().regex(/^[0-9a-f]{7,40}$/);
export type GitSha = z.infer<typeof GitSha>;

/** Data classification; drives LLM routing policy (M18). */
export const DataClass = z.enum(["acik", "dahili", "gizli"]);
export type DataClass = z.infer<typeof DataClass>;

/** Risk tier; decided by analysis, PO may raise but never lower (M51). */
export const RiskTier = z.enum(["dusuk", "orta", "kritik"]);
export type RiskTier = z.infer<typeof RiskTier>;

/** Work modes (M46). */
export const WorkMode = z.enum(["full_auto", "ai_assist", "human_lead", "human_only"]);
export type WorkMode = z.infer<typeof WorkMode>;

/**
 * What a listening rule asks Maestro to DO with a ticket it picks up.
 *
 * A different axis from {@link WorkMode}, and the two are easy to confuse:
 * `WorkMode` says how much the AI may decide on its own, `FlowType` says which
 * steps run at all. A `full_auto` `analiz` ticket is fully automatic AND stops
 * at the analysis document — no code, no PR, no merge.
 *
 *  - **analiz** — analyse and stop. The document IS the deliverable.
 *  - **duzeltme** — a small fix: skip the analysis gate, still gate the PR.
 *  - **gelistirme** — the full SDLC.
 *
 * Lives in contracts rather than beside the listening store because both the
 * BFF (which reads the rule) and `@maestro/workflows` (which acts on it) need
 * it, and the workflow package may not import the BFF (M44).
 */
export const FlowType = z.enum(["analiz", "duzeltme", "gelistirme"]);
export type FlowType = z.infer<typeof FlowType>;

/** Runner platform profiles (K60). */
export const PlatformProfile = z.enum([
  "linux-node",
  "linux-android",
  "macos-xcode",
  "windows-dotnet",
]);
export type PlatformProfile = z.infer<typeof PlatformProfile>;

/**
 * Supported locales (M104). Adding a locale = adding a catalog file in
 * packages/config/locales; this enum is the only code touchpoint.
 */
export const Locale = z.enum(["tr", "en"]);
export type Locale = z.infer<typeof Locale>;

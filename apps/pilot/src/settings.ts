import { isAbsolute } from "node:path";

import { DataClass } from "@maestro/contracts";

/**
 * The pilot's operational settings, editable FROM THE UI at runtime (M71 spirit:
 * "birçok şey env yerine UI'dan çalışmalı"). The six values below used to be read
 * from the environment at module load in `config.ts`; they now live here, SEEDED
 * from the same env defaults so nothing changes if the panel is never touched —
 * the environment remains the seed, not the source of truth.
 *
 * Scope, on purpose: this is SETTINGS, not SECRETS. Tokens (OpenRouter, Jira
 * Cloud) and structural constants (ADO_*, fixed ports/URLs, the discovery JQL)
 * stay in `config.ts`/env — they are never exposed or writable here.
 *
 * In-memory only. The pilot runs one flow at a time on one machine, so a process
 * map is enough; a DB-backed, audited settings store is the Studio / Dalga-3 job.
 * A restart re-seeds from env — that is the documented behaviour, not a bug.
 *
 * Every value is VALIDATED on write (see `validateSettings`); an invalid write is
 * rejected with a clear Turkish message and the store keeps its previous values —
 * junk is never stored.
 */

/** The UI-editable settings. */
export interface PilotSettings {
  /** Group whose membership every gate approval is checked against (M32/M51). */
  approverGroup: string;
  /** Model used for every thinking role. */
  model: string;
  /** Gate comment poll interval while a gate is open (ms). */
  commandPollMs: number;
  /** Discovery re-list interval while idle (ms). */
  discoveryPollMs: number;
  /** Data class of the payloads — drives PII masking strictness. */
  dataClass: DataClass;
  /** Corporate account a Cloud comment author falls back to (audit needs user@corp). */
  operatorAccount: string;
  /**
   * The permanent KÖK (root) for the single analysis sandbox. Every ticket runs
   * in its own ISOLATED subdirectory under this root (`<root>/<ticketKey>/`),
   * and the root itself is never torn down. Empty string means "no persistent
   * root" — the pilot falls back to a throwaway per-run `mkdtemp` dir (the legacy
   * behaviour). UI-editable; env only seeds the default at bootstrap.
   */
  sandboxRoot: string;
  /**
   * The review status name the analysis-approval handover moves a ticket to
   * (default "İNCELEMEDE"). NEVER the sole selection key — the driver matches
   * this name first, then falls back to the In-Progress status category — so a
   * site that renamed its review column still works. UI-editable; env only seeds
   * the default at bootstrap.
   */
  reviewStatusName: string;
  /**
   * Auto-merge (B14). OFF by default: merge stays a HUMAN action — the pilot
   * opens the PR, CI runs, a human approves the gate, and a human clicks merge.
   * When ON, and ONLY on the github path with real CI green and the PR gate
   * approved, the pilot performs the merge itself via the real merge API. This
   * is the one switch that lets Maestro write to the trunk, so it is guarded,
   * off by default, and never inferred.
   */
  autoMerge: boolean;
  /**
   * Auto-start (the engine's heartbeat). ON by default: when discovery lists a
   * ticket a LISTENING RULE can classify (flowTypeFor ≠ null) and no run is in
   * progress, the pilot starts it by itself — dragging a ticket onto the bot IS
   * the trigger, no human click needed. A ticket NO rule classifies is never
   * auto-started (it waits for a manual start, with a log line saying so), and
   * a ticket that failed or was returned is not retried automatically.
   */
  autoStart: boolean;
}

/** Bounds for the poll intervals — a positive integer, not absurdly small/large. */
export const POLL_MS_MIN = 1_000;
export const POLL_MS_MAX = 120_000;

/**
 * A throwaway base the seed is validated ON TOP of. Every field is supplied by a
 * real seed (see `defaultSettings`), so these placeholders are always overwritten
 * before they can be read; they exist only so `validateSettings` has a complete
 * `current` to start from.
 */
const SEED_BASE: PilotSettings = {
  approverGroup: "-",
  model: "-",
  commandPollMs: POLL_MS_MIN,
  discoveryPollMs: POLL_MS_MIN,
  dataClass: "gizli",
  operatorAccount: "-",
  sandboxRoot: "",
  reviewStatusName: "İNCELEMEDE",
  autoMerge: false,
  autoStart: true,
};

/** Human-readable field labels, reused in validation messages (Turkish). */
const LABELS = {
  approverGroup: "onaylayan grup",
  model: "model",
  commandPollMs: "komut yoklama aralığı",
  discoveryPollMs: "keşif yoklama aralığı",
  dataClass: "veri sınıfı",
  operatorAccount: "operatör hesabı",
  sandboxRoot: "sandbox kökü",
  reviewStatusName: "inceleme statüsü",
  autoMerge: "otomatik birleştirme",
  autoStart: "otomatik başlatma",
} as const;

/** Thrown when a write is rejected; carries a UI-safe Turkish message. */
export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SettingsValidationError(`${label} boş olamaz`);
  }
  // Reject control characters (CR/LF/tab/etc.) at the panel. These fields flow
  // into an audit actor (operatorAccount) and a group query (approverGroup);
  // a newline is neutralized downstream, but catching it HERE makes a bad value
  // fail at settings-write time instead of surfacing as a gate-time audit throw.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new SettingsValidationError(`${label} kontrol karakteri içeremez`);
  }
  return value.trim();
}

/**
 * The sandbox KÖK: EITHER empty (persistent root off → mkdtemp fallback) OR an
 * ABSOLUTE path with no control characters. A relative root is rejected because
 * it would resolve against whatever cwd the runner happens to have, and the
 * whole point of the root is a single, stable, operator-chosen location. The
 * per-ticket subdir is derived from a slugged ticket key downstream, so the root
 * itself only needs to be a sane absolute directory here.
 */
function requireOptionalAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new SettingsValidationError(`${label} metin olmalı`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return "";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new SettingsValidationError(`${label} kontrol karakteri içeremez`);
  }
  if (!isAbsolute(trimmed)) {
    throw new SettingsValidationError(`${label} mutlak bir yol olmalı (veya boş bırakılmalı)`);
  }
  return trimmed;
}

function requirePollMs(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SettingsValidationError(`${label} tam sayı milisaniye olmalı`);
  }
  if (value < POLL_MS_MIN || value > POLL_MS_MAX) {
    throw new SettingsValidationError(
      `${label} ${POLL_MS_MIN}–${POLL_MS_MAX} ms aralığında olmalı`,
    );
  }
  return value;
}

/**
 * Validate an arbitrary partial payload against the current settings, returning a
 * fully-typed, normalised `PilotSettings`. Any invalid field throws
 * `SettingsValidationError` with a clear Turkish message BEFORE anything is
 * stored, so a rejected write never leaves the store half-updated.
 *
 * A field absent from `patch` keeps its current value — the POST route can send a
 * partial update, and the seed path passes a complete map.
 */
export function validateSettings(
  current: PilotSettings,
  patch: Partial<Record<keyof PilotSettings, unknown>>,
): PilotSettings {
  const next: PilotSettings = { ...current };

  if ("approverGroup" in patch) {
    next.approverGroup = requireNonEmpty(patch.approverGroup, LABELS.approverGroup);
  }
  if ("model" in patch) {
    next.model = requireNonEmpty(patch.model, LABELS.model);
  }
  if ("commandPollMs" in patch) {
    next.commandPollMs = requirePollMs(patch.commandPollMs, LABELS.commandPollMs);
  }
  if ("discoveryPollMs" in patch) {
    next.discoveryPollMs = requirePollMs(patch.discoveryPollMs, LABELS.discoveryPollMs);
  }
  if ("dataClass" in patch) {
    const parsed = DataClass.safeParse(patch.dataClass);
    if (!parsed.success) {
      throw new SettingsValidationError(`${LABELS.dataClass} yalnız acik | dahili | gizli olabilir`);
    }
    next.dataClass = parsed.data;
  }
  if ("operatorAccount" in patch) {
    next.operatorAccount = requireNonEmpty(patch.operatorAccount, LABELS.operatorAccount);
  }
  if ("sandboxRoot" in patch) {
    next.sandboxRoot = requireOptionalAbsolutePath(patch.sandboxRoot, LABELS.sandboxRoot);
  }
  if ("reviewStatusName" in patch) {
    next.reviewStatusName = requireNonEmpty(patch.reviewStatusName, LABELS.reviewStatusName);
  }
  if ("autoMerge" in patch) {
    if (typeof patch.autoMerge !== "boolean") {
      throw new SettingsValidationError(`${LABELS.autoMerge} yalnız açık/kapalı olabilir`);
    }
    next.autoMerge = patch.autoMerge;
  }
  if ("autoStart" in patch) {
    if (typeof patch.autoStart !== "boolean") {
      throw new SettingsValidationError(`${LABELS.autoStart} yalnız açık/kapalı olabilir`);
    }
    next.autoStart = patch.autoStart;
  }

  return next;
}

/**
 * The runtime settings store. Callers read from it at USE time (not at module
 * load), so a change takes effect on the next run/poll without a restart. The
 * seed is validated too, so a broken env value fails loudly at boot rather than
 * poisoning a run.
 */
export class SettingsStore {
  private settings: PilotSettings;

  constructor(seed: Record<keyof PilotSettings, unknown>) {
    // The seed passes through the same validation as a UI write — a bad env
    // default is a boot-time error, never a silently-stored junk value. The
    // `current` base is a throwaway; every field is present in `seed`, so it is
    // fully overwritten before it is ever read.
    this.settings = validateSettings(SEED_BASE, seed);
  }

  /** A snapshot of the current values. No field here is a secret. */
  snapshot(): PilotSettings {
    return { ...this.settings };
  }

  /**
   * Validate a (possibly partial) patch and, if it passes, replace the settings.
   * Returns the new snapshot. Throws `SettingsValidationError` on invalid input
   * WITHOUT mutating — the store keeps its previous values.
   */
  update(patch: Partial<Record<keyof PilotSettings, unknown>>): PilotSettings {
    this.settings = validateSettings(this.settings, patch);
    return this.snapshot();
  }
}

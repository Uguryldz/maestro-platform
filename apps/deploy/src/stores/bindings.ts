import type { BindingWrite, BindingWriter, JiraBinding, JiraProjectBindings } from "@maestro/bff";

/**
 * The Postgres-backed `JiraProjectBindings` (M102).
 *
 * The composition root used to pass `new StaticJiraProjectBindings([])` — an
 * EMPTY list, which resolves every project to `null`, which the intake path
 * drops. The direction was right (an unbound project must never start a run)
 * but the effect was total: every Jira webhook the bank delivered was accepted
 * and thrown away, and the only trace was an in-process counter. An operator
 * asking "why is the Jira integration doing nothing" had nothing to read.
 *
 * The bindings are a real table (`JiraProjectBinding`), so the honest fix is to
 * read it rather than to hard-code an empty list. A project that genuinely has
 * no row still resolves to `null` and is still dropped — that is the M102 rule
 * and it stays — but now "no binding" means somebody did not bind the project,
 * not that the deployment forgot to wire the store.
 *
 * Prisma stays out of `apps/bff` for the same reason `PrismaUserDirectory`
 * lives here: the BFF's tests all run offline against the interface, and the
 * delegate is taken structurally so this file compiles before `prisma generate`
 * has run.
 */

/** The `JiraProjectBinding` row as read back. JSON columns arrive as `unknown`. */
export interface BindingRow {
  projectKey: string;
  trigger: string;
  triggerLabel: string;
  defaultsJson: unknown;
  state: string;
}

/** The one delegate method the READ store uses. */
export interface BindingDelegate {
  findUnique(args: { where: { projectKey: string } }): Promise<BindingRow | null>;
}

/**
 * The columns `PrismaBindingWriter` writes. `trigger`/`state` are the Prisma
 * enums' literal unions (not bare `string`) so the delegate matches the generated
 * client; `triggerLabel`/`dryRunSampleSize`/`version` take their schema defaults
 * on create.
 */
type TriggerLiteral = "auto" | "label" | "command";
type StateLiteral = "draft" | "dry_run" | "active" | "paused" | "unbound";

export interface BindingWriteRow {
  projectKey: string;
  trigger: TriggerLiteral;
  state: StateLiteral;
  defaultsJson: object;
}

export interface BindingUpsertDelegate {
  upsert(args: {
    where: { projectKey: string };
    create: BindingWriteRow;
    update: { trigger: TriggerLiteral; state: StateLiteral; defaultsJson: object };
  }): Promise<unknown>;
}

/**
 * Which persisted states mean "this project is live".
 *
 * `BindingStateE` has five values and `JiraBinding.active` is a boolean, so the
 * narrowing happens HERE, once, and it is deliberately conservative: only
 * `active` is active. `dry_run` in particular must not resolve to `true` — a
 * dry-run binding exists precisely so an operator can watch what WOULD happen
 * without a run starting, and treating it as live would turn a rehearsal into
 * production work on a bank's ticket. `draft`, `paused` and `unbound` are
 * plainly not live.
 */
export const LIVE_BINDING_STATES: readonly string[] = ["active"];

/**
 * `TriggerModeE` (`auto` | `label` | `command`) as the BFF's two-valued
 * `triggerMode`.
 *
 * `auto` is the only mode that starts a run from any ticket. Both `label` and
 * `command` require somebody to ASK — a label on the issue or an `/ai-start`
 * comment — which is exactly what `opt_in` means to the intake path (M48a).
 * Anything unrecognised also maps to `opt_in`: a trigger mode this code does
 * not understand must fail towards "wait to be asked", never towards "start
 * runs on everything".
 */
export function triggerModeOf(trigger: string): JiraBinding["triggerMode"] {
  return trigger === "auto" ? "auto" : "opt_in";
}

export class PrismaJiraProjectBindings implements JiraProjectBindings {
  constructor(private readonly bindings: BindingDelegate) {}

  async resolve(projectKey: string): Promise<JiraBinding | null> {
    const row = await this.bindings.findUnique({ where: { projectKey } });
    if (row === null) return null;

    const defaults = parseDefaults(row.defaultsJson);
    return {
      projectKey: row.projectKey,
      active: LIVE_BINDING_STATES.includes(row.state),
      triggerMode: triggerModeOf(row.trigger),
      appId: defaults.appId,
      mode: defaults.mode,
      dataClass: defaults.dataClass,
    };
  }
}

/**
 * Writes a project's binding when an onboarding proposal is approved (M93).
 *
 * An UPSERT keyed on `projectKey`: re-approving a re-onboarded project overwrites
 * its binding rather than failing. `defaultsJson` is written in exactly the
 * `{ appId, mode, dataClass }` shape `parseDefaults` reads back, so a binding
 * this writes resolves cleanly on the intake path — a mismatch would silently
 * fail-close the project to `human_only`/`gizli`.
 *
 * Separate from `PrismaJiraProjectBindings` (the reader) so the read path keeps
 * no write delegate; both sit on `db.jiraProjectBinding`.
 */
export class PrismaBindingWriter implements BindingWriter {
  constructor(private readonly bindings: BindingUpsertDelegate) {}

  async bind(binding: BindingWrite): Promise<void> {
    const defaultsJson = {
      appId: binding.defaults.appId,
      mode: binding.defaults.mode,
      dataClass: binding.defaults.dataClass,
    };
    await this.bindings.upsert({
      where: { projectKey: binding.projectKey },
      create: {
        projectKey: binding.projectKey,
        trigger: binding.trigger,
        state: binding.state,
        defaultsJson,
      },
      update: { trigger: binding.trigger, state: binding.state, defaultsJson },
    });
  }
}

/**
 * `defaultsJson` holds `{ mode, dataClass }` and is a JSON column, so what
 * comes out is genuinely unknown.
 *
 * The fallbacks are the safe end of each axis rather than the convenient one.
 * An unreadable `mode` becomes `human_only`: a corrupt column must not be the
 * reason an AI is given a free hand on a ticket. An unreadable `dataClass`
 * becomes `gizli`, which is the same fail-closed default the knowledge policy
 * applies to an unlabelled document (M18/M63) — the classification decides
 * which model may see the content, so guessing low is the one guess that leaks.
 */
function parseDefaults(value: unknown): {
  appId: string | null;
  mode: JiraBinding["mode"];
  dataClass: JiraBinding["dataClass"];
} {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const appId = record["appId"];
  const mode = record["mode"];
  const dataClass = record["dataClass"];
  return {
    appId: typeof appId === "string" ? appId : null,
    mode: MODES.includes(mode as string) ? (mode as JiraBinding["mode"]) : "human_only",
    dataClass: DATA_CLASSES.includes(dataClass as string)
      ? (dataClass as JiraBinding["dataClass"])
      : "gizli",
  };
}

/**
 * The two vocabularies, as literals.
 *
 * Written out rather than imported from `@maestro/contracts` for the same
 * reason `ROLE_BY_GROUP` is: this file is a driver and must stay compilable on
 * its own. `test/bindings.test.ts` pins both lists against the contract's own
 * enums, so a value added upstream fails the suite rather than the deployment.
 */
const MODES: readonly string[] = ["full_auto", "ai_assist", "human_lead", "human_only"];
const DATA_CLASSES: readonly string[] = ["acik", "dahili", "gizli"];

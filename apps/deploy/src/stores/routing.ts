import type { RoutingProjectView, RoutingReader, RoutingRuleView } from "@maestro/bff";
import { triggerModeOf } from "./bindings.js";

/**
 * The Postgres-backed routing reader (M99/M102), for Studio's routing screen.
 *
 * Two real tables answer it: `JiraProjectBinding` says which projects are bound
 * and how a ticket enters the flow, and `RoutingRule` says which application a
 * ticket lands on. Neither is invented and neither has a compiled-in fallback —
 * a project with no binding is a project nobody bound, and the screen showing
 * an empty list is then the truth rather than a disconnected store.
 *
 * The rules are read here purely to be DISPLAYED. The matching itself is
 * `@maestro/workflows`' job through `ParamReader.routingRules`, and duplicating
 * the evaluation in a read model is how a screen ends up confidently showing a
 * routing decision the platform does not make.
 */

export interface RoutingBindingRow {
  projectKey: string;
  trigger: string;
  triggerLabel: string;
  defaultsJson: unknown;
  state: string;
}

export interface RoutingBindingListDelegate {
  findMany(args: { orderBy: { projectKey: "asc" } }): Promise<RoutingBindingRow[]>;
}

export interface RoutingRuleRow {
  ruleId: string;
  projectKey: string | null;
  conditionJson: unknown;
  effectJson: unknown;
  priority: number;
}

export interface RoutingRuleListDelegate {
  findMany(args: {
    orderBy: [{ priority: "asc" }, { ruleId: "asc" }];
  }): Promise<RoutingRuleRow[]>;
}

export class PrismaRoutingReader implements RoutingReader {
  constructor(
    private readonly bindings: RoutingBindingListDelegate,
    /**
     * Named `ruleRows` rather than `rules`: the interface's own method is
     * `rules()`, and a field of the same name would shadow it.
     */
    private readonly ruleRows: RoutingRuleListDelegate,
  ) {}

  /**
   * Bound projects and the applications their rules can send work to.
   *
   * The application list per project comes from the rules rather than from the
   * binding's own default: a project with three component rules routes to three
   * applications, and showing only the default would tell an operator the
   * platform can reach one.
   */
  async projects(): Promise<readonly RoutingProjectView[]> {
    const [rows, rules] = await Promise.all([
      this.bindings.findMany({ orderBy: { projectKey: "asc" } }),
      this.ruleRows.findMany({ orderBy: [{ priority: "asc" }, { ruleId: "asc" }] }),
    ]);

    return rows.map((row) => {
      const apps = new Set<string>();
      const fallback = appIdOf(row.defaultsJson);
      if (fallback !== null) apps.add(fallback);
      for (const rule of rules) {
        // `null` projectKey is an org-wide rule and applies to every project.
        if (rule.projectKey !== null && rule.projectKey !== row.projectKey) continue;
        const appId = appIdOf(rule.effectJson);
        if (appId !== null) apps.add(appId);
      }

      const note = notePhrase(row);
      return {
        projectKey: row.projectKey,
        // The screen's vocabulary is `auto` | `label` | `command`, which is the
        // column's own enum — passed through rather than narrowed to the
        // intake path's two-valued `opt_in`, because an operator reading this
        // screen needs to know WHICH opt-in gesture their project uses.
        trigger: TRIGGERS.includes(row.trigger) ? row.trigger : "command",
        apps: [...apps].sort(),
        noteKey: note.key,
        // Omitted rather than sent as `undefined`: the wire schema marks it
        // optional, and a present-but-undefined field serialises as `null`,
        // which the screen would have to special-case.
        ...(note.params === undefined ? {} : { noteParams: note.params }),
      };
    });
  }

  async rules(): Promise<readonly RoutingRuleView[]> {
    const rows = await this.ruleRows.findMany({
      orderBy: [{ priority: "asc" }, { ruleId: "asc" }],
    });
    return rows.map((row) => {
      const condition = conditionPhrase(row.conditionJson);
      return {
        ruleId: row.ruleId,
        conditionKey: condition.key,
        ...(condition.params === undefined ? {} : { conditionParams: condition.params }),
        effect: appIdOf(row.effectJson) ?? "assignment queue",
        priority: row.priority,
        // `"*"` is how the contract spells the org-wide scope the column stores
        // as NULL. The translation happens once, here, so no caller invents a
        // second sentinel.
        projectKey: row.projectKey ?? "*",
      };
    });
  }
}

/** `TriggerModeE`. An unrecognised value renders as the most restrictive one. */
const TRIGGERS: readonly string[] = ["auto", "label", "command"];

/** `{ appId?, mode?, dataClass? }` — a JSON column, so genuinely unknown. */
function appIdOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const appId = (value as Record<string, unknown>)["appId"];
  return typeof appId === "string" && appId.length > 0 ? appId : null;
}

/** A catalog key plus the substitutions its sentence needs (M104). */
interface Phrase {
  key: string;
  params?: Readonly<Record<string, string>>;
}

/**
 * `RuleCondition` as a catalog key.
 *
 * This used to return the finished English sentence, with a comment arguing it
 * was "rendered server-side so the same rule reads identically wherever it
 * appears". That is true and it is also how `component = odeme` and `every
 * ticket` ended up untranslated in a Turkish table: identical everywhere
 * includes identically English. Sending the key keeps the single source of
 * truth AND lets each screen render it in the reader's language.
 *
 * An unrecognised type still says so rather than rendering an empty cell — a
 * blank condition looks like a rule that matches nothing, when a condition type
 * this code does not recognise may well match everything.
 */
function conditionPhrase(value: unknown): Phrase {
  if (typeof value !== "object" || value === null) return { key: "routing.condition.unreadable" };
  const record = value as Record<string, unknown>;
  const type = record["type"];

  if (type === "always") return { key: "routing.condition.always" };
  if (type === "component" && typeof record["component"] === "string") {
    return { key: "routing.condition.component", params: { value: record["component"] } };
  }
  if (type === "label" && typeof record["label"] === "string") {
    return { key: "routing.condition.label", params: { value: record["label"] } };
  }
  return {
    key: "routing.condition.unknown_type",
    params: { value: typeof type === "string" ? type : "(none)" },
  };
}

/**
 * What the binding's state means for tickets arriving now.
 *
 * `dry_run` gets its own sentence rather than being folded into "not active":
 * a dry-run binding is deliberately watching without acting, and an operator
 * who reads that as "broken" will go looking for a fault, while one who reads
 * it as "active" will wonder why no run started.
 */
function notePhrase(row: RoutingBindingRow): Phrase {
  switch (row.state) {
    case "active":
      return row.trigger === "auto"
        ? { key: "routing.note.active_auto" }
        : { key: "routing.note.active_label", params: { label: row.triggerLabel } };
    case "dry_run":
      return { key: "routing.note.dry_run" };
    case "paused":
      return { key: "routing.note.paused" };
    case "draft":
      return { key: "routing.note.draft" };
    case "unbound":
      return { key: "routing.note.unbound" };
    default:
      return { key: "routing.note.unrecognised", params: { state: row.state } };
  }
}

export { triggerModeOf };

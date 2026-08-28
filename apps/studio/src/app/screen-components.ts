import type { ComponentType } from "react";
import { AuditScreen } from "../screens/Audit.tsx";
import { CacheScreen } from "../screens/Cache.tsx";
import { ClarifyScreen } from "../screens/Clarify.tsx";
import { CommandsScreen } from "../screens/Commands.tsx";
import { AiUsageScreen } from "../screens/AiUsage.tsx";
import { DashScreen } from "../screens/Dash.tsx";
import { DetailScreen } from "../screens/Detail.tsx";
import { DoctemplateScreen } from "../screens/Doctemplate.tsx";
import { EvalScreen } from "../screens/Eval.tsx";
import { EvidenceScreen } from "../screens/Evidence.tsx";
import { FanoutScreen } from "../screens/Fanout.tsx";
import { GreenfieldScreen } from "../screens/Greenfield.tsx";
import { HealthScreen } from "../screens/Health.tsx";
import { HelpScreen } from "../screens/Help.tsx";
import { IssuesScreen } from "../screens/Issues.tsx";
import { JiraScreen } from "../screens/Jira.tsx";
import { KnowledgeScreen } from "../screens/Knowledge.tsx";
import { LiveScreen } from "../screens/Live.tsx";
import { McpScreen } from "../screens/Mcp.tsx";
import { NotifyScreen } from "../screens/Notify.tsx";
import { ProjectsScreen } from "../screens/Projects.tsx";
import { ParamsScreen } from "../screens/Params.tsx";
import { PiiScreen } from "../screens/Pii.tsx";
import { RunnersScreen } from "../screens/Runners.tsx";
import { SandboxScreen } from "../screens/Sandbox.tsx";
import { SecurityScreen } from "../screens/Security.tsx";
import { SettingsScreen } from "../screens/Settings.tsx";
import { SetupScreen } from "../screens/Setup.tsx";
import { TemplateScreen } from "../screens/Template.tsx";
import { UsersScreen } from "../screens/Users.tsx";
import { VariantScreen } from "../screens/Variant.tsx";
import { VariantsScreen } from "../screens/Variants.tsx";
import { WorkmodeScreen } from "../screens/Workmode.tsx";
import { YamlScreen } from "../screens/Yaml.tsx";

/**
 * id -> component. Generated to mirror src/app/screens.ts; every SCREENS row
 * must have an entry here (test/routes.test.tsx asserts it both ways).
 *
 * Screen agents: your entry already exists and points at your stub file. Edit
 * the stub, not this registry.
 */
export const SCREEN_COMPONENTS: Readonly<Record<string, ComponentType>> = {
  dash: DashScreen,
  help: HelpScreen,
  live: LiveScreen,
  fanout: FanoutScreen,
  clarify: ClarifyScreen,
  workmode: WorkmodeScreen,
  greenfield: GreenfieldScreen,
  jira: JiraScreen,
  commands: CommandsScreen,
  detail: DetailScreen,
  runners: RunnersScreen,
  sandbox: SandboxScreen,
  cache: CacheScreen,
  yaml: YamlScreen,
  variants: VariantsScreen,
  variant: VariantScreen,
  eval: EvalScreen,
  knowledge: KnowledgeScreen,
  template: TemplateScreen,
  doctemplate: DoctemplateScreen,
  pii: PiiScreen,
  cost: AiUsageScreen,
  audit: AuditScreen,
  evidence: EvidenceScreen,
  security: SecurityScreen,
  notify: NotifyScreen,
  setup: SetupScreen,
  projects: ProjectsScreen,
  params: ParamsScreen,
  mcp: McpScreen,
  users: UsersScreen,
  settings: SettingsScreen,
  health: HealthScreen,
  issues: IssuesScreen,
};

import type { AppRegistration, AppRegistryWriter } from "@maestro/bff";

/**
 * The Postgres-backed `AppRegistryWriter` (M93/M100).
 *
 * The onboarding wizard is what CREATES an application row: an operator picks a
 * repo off the live SCM list, and submitting registers it into the inventory
 * (`createdVia: "onboarding"`) before the binding proposal is filed. Without this
 * writer the submit stays at its older proposal-only behaviour, where the repo
 * had to have been onboarded through some other path first.
 *
 * It writes the same `Application` table the `PrismaOnboardingReader` and
 * `PrismaAppRegistry` READ, so the row this writes is visible to the very next
 * `assertBindable` in the same request — the property that lets the wizard both
 * register a new repo and propose binding it in one submit.
 *
 * `register` is an UPSERT keyed on `appId`: re-running the wizard for a repo
 * already in the registry updates the mutable columns rather than failing, since
 * the operator's intent the second time is the same as the first. `jiraComponent`
 * and `maestroYamlPresent` are NOT touched on update — they are set by other
 * paths (impact matrix, `.maestro.yaml` observation) and the wizard has no say
 * over them, so overwriting them here would erase another subsystem's fact.
 */
export interface ApplicationWriteRow {
  appId: string;
  displayName: string;
  adoProject: string;
  adoRepo: string;
  platform: string;
  createdVia: "onboarding" | "import";
}

export interface ApplicationUpsertDelegate {
  upsert(args: {
    where: { appId: string };
    create: ApplicationWriteRow & { maestroYamlPresent: boolean };
    update: { displayName: string; adoProject: string; adoRepo: string; platform: string };
  }): Promise<unknown>;
}

export class PrismaAppRegistryWriter implements AppRegistryWriter {
  constructor(private readonly applications: ApplicationUpsertDelegate) {}

  async register(app: AppRegistration): Promise<void> {
    await this.applications.upsert({
      where: { appId: app.appId },
      create: {
        appId: app.appId,
        displayName: app.displayName,
        adoProject: app.adoProject,
        adoRepo: app.adoRepo,
        platform: app.platform,
        // A freshly onboarded repo has not been scanned for a policy file yet;
        // the observer flips this true when it first sees one (M52).
        maestroYamlPresent: false,
        createdVia: "onboarding",
      },
      // Re-onboarding may correct the display name, owner, repo or platform; it
      // never re-stamps `createdVia` or the policy/component columns.
      update: {
        displayName: app.displayName,
        adoProject: app.adoProject,
        adoRepo: app.adoRepo,
        platform: app.platform,
      },
    });
  }
}

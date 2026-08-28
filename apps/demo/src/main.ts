import { bootDemo } from "./boot.js";

/**
 * Entry point of `pnpm -F @maestro/demo start`. Starts the two prop servers
 * and the Maestro side, then prints the one address to open. Nothing is
 * daemonised: Ctrl-C stops everything.
 */
async function main(): Promise<void> {
  const stage = await bootDemo();
  process.stdout.write(
    [
      "",
      "  Maestro demo hazır.",
      "",
      `  ▶ Tarayıcıdan aç:   ${stage.uiUrl}`,
      `    sahte Jira:       ${stage.jiraUrl}`,
      `    sahte Azure DevOps: ${stage.adoUrl}`,
      "",
      "  Jira ve ADO sahtedir; model gerçektir. Durdurmak için Ctrl-C.",
      "",
    ].join("\n"),
  );

  const shutdown = (): void => {
    void stage.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`\n  Demo başlatılamadı: ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});

import { bootPilot } from "./boot.js";

/**
 * Entry point of `pnpm -F @maestro/pilot start`. Starts the fake ADO prop and
 * the Maestro side wired to the LIVE Jira Cloud site, turns the discovery poll
 * loop on, and prints the one address to open. Nothing is daemonised: Ctrl-C
 * stops everything.
 */
async function main(): Promise<void> {
  const stage = await bootPilot({ startDiscovery: true });
  process.stdout.write(
    [
      "",
      "  Maestro pilot hazır — Jira GERÇEK, ADO sahte.",
      "",
      `  ▶ Tarayıcıdan aç:   ${stage.uiUrl}`,
      `    canlı Jira:       ${stage.jiraSite}`,
      `    sahte Azure DevOps: ${stage.adoUrl}`,
      "",
      "  Onaylar GERÇEK Jira'ya /approve yorumu yazılarak verilir. Durdurmak için Ctrl-C.",
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
  process.stderr.write(`\n  Pilot başlatılamadı: ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});

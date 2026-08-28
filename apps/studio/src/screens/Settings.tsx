import type { ReactNode } from "react";
import { ConnectorsPanel } from "./settings/ConnectorsPanel.tsx";
import { InfrastructurePanel } from "./settings/InfrastructurePanel.tsx";
import { KillSwitchPanel } from "./settings/KillSwitchPanel.tsx";

/**
 * Ayarlar & bağlantılar — the platform's outbound connections, the
 * infrastructure it runs on, and the kill switch.
 *
 * Three sections, all real:
 *  · {@link ConnectorsPanel} — the ADMIN-EDITABLE outbound connections (Jira,
 *    GitHub, OpenRouter…): add a URL + token, test it LIVE, token stored
 *    AES-encrypted and shown only as a mask (M9/migration 0010).
 *  · {@link InfrastructurePanel} — the READ-ONLY deployment facts from
 *    `/settings`: the workflow engine, the database, the LLM endpoint and the
 *    ports wired (or not) by `deploy/.env`.
 *  · {@link KillSwitchPanel} — the two-level emergency stop (M58).
 *
 * The engine-settings panel that sat between them is gone with the pilot it
 * proxied to: its fields were the pilot's own runtime vocabulary, and the
 * Temporal line takes none of them.
 *
 * A read-only "deployment facts" table was once removed from this screen
 * because it restated the editable panel under the same heading. That was true
 * of the list it removed — jira/ado/vault-shaped rows and nothing else. It is
 * no longer true of the list `/settings` returns: `temporal`, `database` and
 * `llm` are now in it, none of them appear in the editable panel, and without
 * them an operator had no screen on which to ask where the engine is pointed or
 * whether it is up. It returns under its OWN heading, stating in its subtitle
 * what makes it different, which is the part the first attempt was missing.
 *
 * The stub notify-driver table stayed removed — notify drivers live on the
 * dedicated "Bildirim & eskalasyon" screen (M45).
 */
export function SettingsScreen(): ReactNode {
  return (
    <div className="scr-stack">
      <ConnectorsPanel />
      <InfrastructurePanel />
      <KillSwitchPanel />
    </div>
  );
}

/**
 * Dev launcher: the demo stack, but with the identity/session/user surface
 * pointed at the REAL Postgres (so the DB-seeded `admin` bootstrap account —
 * random password printed once by the migrate log, or fixed via
 * MAESTRO_BOOTSTRAP_PASSWORD before the first migrate — and its
 * must-change-password flow can be exercised in a browser).
 *
 * Everything ELSE stays the demo's in-memory reality — this needs no corporate
 * Jira/ADO/S3/LLM endpoints, unlike the prod `apps/deploy` boot which is
 * fail-closed on them (M6). It exists only to demo the first-run login flow
 * against the real durable user store; it is NOT a production entrypoint.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AuditChain } from "@maestro/audit";
import {
  buildServer,
  compositeHealthReader,
  connectionHealthReader,
  LocalIdentityProvider,
  BcryptPasswordHasher,
  StaticSettingsReader,
} from "@maestro/bff";
import { createDb } from "@maestro/db";
import { createJiraCloudWorkPort } from "@maestro/adapter-jira";
import type { SecretPort } from "@maestro/ports";
import { PrismaUserDirectory } from "../../../deploy/src/stores/users.js";
import { PrismaSessionStore } from "../../../deploy/src/stores/sessions.js";
import { PrismaKillSwitchStore } from "../../../deploy/src/stores/killswitch.js";
import { PrismaParamStore } from "../../../deploy/src/stores/params-store.js";
import { PrismaRoutingReader } from "../../../deploy/src/stores/routing.js";
import { PrismaTemplateStore } from "../../../deploy/src/stores/template.js";
import { PrismaDocTemplateStore } from "../../../deploy/src/stores/doc-template.js";
import { PrismaBindingWriter, PrismaJiraProjectBindings } from "../../../deploy/src/stores/bindings.js";
import { liveReadModels } from "../../../deploy/src/stores/read-live.js";
import { postgresChainLock, PrismaAuditStore } from "../../../deploy/src/stores/audit.js";
import { prismaTransactionRunner } from "../../../deploy/src/stores/sql.js";
import { postgresProbe, httpProbe } from "../../../deploy/src/stores/read-health.js";
import { PrismaVariantCatalog } from "../../../deploy/src/stores/read-variants.js";
import { PrismaVariantWriter } from "../../../deploy/src/stores/write-variants.js";
import { AuditPiiReader, AuditDecisionReader } from "../../../deploy/src/stores/read-governance.js";
import { PrismaAppRegistryWriter } from "../../../deploy/src/stores/app-registry-writer.js";
import { PrismaConnectionStore } from "../../../deploy/src/stores/connections.js";
import { PrismaListeningStore } from "../../../deploy/src/stores/listening.js";
import { PrismaGuidanceStore } from "../../../deploy/src/stores/guidance.js";
import { EncryptedSecretStore, resolveMasterKey } from "../../../deploy/src/stores/encrypted-secret.js";
import { buildDemoStack } from "../deps.js";
import { listenAddress } from "../address.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ??
  "postgresql://maestro:DEGISTIR-parola-uret-openssl-rand-hex-24@localhost:55432/maestro";

async function main(): Promise<void> {
  const db = createDb(DATABASE_URL);
  const users = new PrismaUserDirectory(db.user);
  const sessions = new PrismaSessionStore(db.session);
  const identity = new LocalIdentityProvider(users, new BcryptPasswordHasher(10));

  // The REAL audit chain, over Postgres `AuditLog` with the cross-process
  // advisory lock — the SAME chain the live pilot appends to. One chain means
  // the Studio "Denetim izi" screen finally shows the pilot's gate approvals,
  // PII maskings and sandbox events next to the BFF's own login/param events,
  // and a restart no longer erases the trail (it used to be in-memory here).
  const auditStore = new PrismaAuditStore(db.auditLog);
  const audit = new AuditChain({
    store: auditStore,
    lock: postgresChainLock(prismaTransactionRunner(db)),
  });

  // Start from the demo deps for the parts that need a Jira/ADO/runner
  // (work/ci/scm — not exercised by login or the read screens), then swap
  // EVERYTHING that has a Postgres home for the REAL database. This is why the
  // İş akışları screen shows the real (empty) run set, not the demo's 17.
  const demo = await buildDemoStack();
  // System-health probes (Sistem sağlığı screen / M6): the services THIS
  // launcher actually depends on, each really contacted — never reported from a
  // config file. Postgres is probed with a real `SELECT 1`; the pilot engine is
  // probed over its own HTTP liveness URL. A probe that cannot reach its target
  // reports `down` with a secret-free note, which is the whole point of the
  // screen. The URLs are fixed deployment facts, not caller input.
  // Jira Cloud bootstrap credentials (git-ignored .env) — used by the Flow
  // screen's workflow reader below. (The system-health Jira row no longer
  // reads them: it comes from the managed connection, further down.)
  const jiraBaseUrl = process.env["JIRA_CLOUD_BASE_URL"];
  const jiraEmail = process.env["JIRA_CLOUD_EMAIL"];
  const jiraToken = process.env["JIRA_CLOUD_API_TOKEN"];
  const JIRA_TOKEN_REF = "jira-cloud-token";

  // System-health probes (Sistem sağlığı screen / M6): the services THIS
  // launcher actually depends on, each really contacted — never reported from a
  // config file. Postgres → real `SELECT 1`; pilot/BFF/Studio → their own HTTP
  // liveness URLs. A probe that cannot reach its target reports `down` with a
  // secret-free note, which is the whole point of the screen.
  // Built BEFORE the read models: the connection rows (Ayarlar > Bağlantılar)
  // now feed the Sistem sağlığı screen too, so the store and the cipher must
  // exist first. The SAME instances go into `deps` below — one store, one truth.
  const connections = new PrismaConnectionStore(db.connection);
  const connectorSecrets = new EncryptedSecretStore(
    resolveMasterKey({
      envValue: process.env["CONNECTOR_MASTER_KEY"],
      isProduction: false,
    }),
    db.connectorSecret,
  );

  const { port: selfPort } = listenAddress();
  const bffHealthUrl = `http://127.0.0.1:${selfPort}/healthz`;
  const studioHealthUrl = process.env["STUDIO_HEALTH_URL"] ?? "http://127.0.0.1:7000/";
  const pilotHealthUrl = process.env["PILOT_HEALTH_URL"] ?? "http://127.0.0.1:7020/api/state";
  const probeRead = liveReadModels({
    db,
    audit: auditStore,
    probes: [
      postgresProbe(db, "postgres-16"),
      // BFF probes ITSELF: this process answers, so it is up whenever the screen
      // can be reached — but listing it keeps the health table complete and
      // catches a hung event loop that still holds the socket.
      httpProbe("bff", bffHealthUrl, { version: "bff", authOptional: true }),
      httpProbe("studio", studioHealthUrl, { version: "studio", authOptional: true }),
      httpProbe("pilot", pilotHealthUrl, { version: "pilot", authOptional: true }),
      // The env-based Jira probe that used to sit here is gone ON PURPOSE: the
      // connection-backed reader below now owns the "jira" row (same
      // authenticated `/myself` check, run by `runConnectionTest` against the
      // credential the PANEL manages — the editable source of truth, per the
      // note on `settings` below). Keeping both would render two "jira" rows
      // with two possibly different verdicts, which is exactly the "which
      // screen do I believe" split this platform keeps refusing to ship.
    ],
  });
  // The install-rehearsal finding, closed: the health screen listed the
  // infrastructure but said nothing about the model key — the very credential
  // whose 403 quietly stalled OPS runs for days. The connection-backed reader
  // adds llm/jira/scm rows from the managed connections, with three honest
  // states (sağlıklı / kapalı / yapılandırılmadı) and the last test's verdict
  // cached on the row, so a one-minute poll never hammers OpenRouter or Jira.
  const read = {
    ...probeRead,
    health: compositeHealthReader([
      probeRead.health,
      connectionHealthReader({ store: connections, secrets: connectorSecrets, fetchImpl: fetch }),
    ]),
  };

  // The Flow screen imports the live Jira workflow (statuses + transitions).
  // It needs a real Cloud driver, which needs a real Jira credential — read it
  // from the same bootstrap env above. When absent the reader stays UNWIRED and
  // the route answers a named 503 rather than a broken screen: no fake graph.
  const jiraWorkflow =
    jiraBaseUrl && jiraEmail && jiraToken
      ? createJiraCloudWorkPort({
          baseUrl: jiraBaseUrl,
          email: jiraEmail,
          apiTokenRef: JIRA_TOKEN_REF,
          // `createJiraCloudWorkPort` reads the SecretPort from `deps.secrets`.
          // A minimal in-process port holding only the Jira token; the value
          // lives in this closure, is never logged, and write/short-lived paths
          // are not needed by the read-only workflow reader.
          deps: {
            secrets: {
              get: (key: string) =>
                key === JIRA_TOKEN_REF
                  ? Promise.resolve(jiraToken)
                  : Promise.reject(new Error(`unknown secret ${key}`)),
              set: () => Promise.reject(new Error("read-only secret port")),
              issueShortLived: () => Promise.reject(new Error("read-only secret port")),
            } satisfies SecretPort,
          },
        })
      : undefined;

  const deps = {
    ...demo.deps,
    users,
    sessions,
    identity,
    audit,
    read,
    killSwitch: new PrismaKillSwitchStore(db.killSwitch),
    params: new PrismaParamStore(db.param, db.paramVersion, db.pendingParamChange),
    routing: new PrismaRoutingReader(db.jiraProjectBinding, db.routingRule),
    bindings: new PrismaJiraProjectBindings(db.jiraProjectBinding),
    templates: new PrismaTemplateStore(
      db.analysisTemplateVersion,
      db.jiraProjectBinding,
      db.workflowRun,
    ),
    // Durable, like `templates` above — the demo left this in-memory, so an
    // uploaded corporate .docx vanished on restart ("kaydettim, gitti"). The
    // Prisma store and its tables (DocTemplateVersion / DocTemplateOutputRow)
    // already exist; the prod boot wires them, and the launcher must match.
    docTemplates: new PrismaDocTemplateStore(db.docTemplateVersion, db.docTemplateOutputRow),
    // The old "deployment facts" connection list (jira.ugurbank.local etc.) was
    // demo scaffolding — empty it. The real, editable connections live in the
    // connector panel below (Ayarlar > Bağlantılar), backed by `connections`.
    settings: new StaticSettingsReader([], []),
    // Real connector management (Ayarlar > Bağlantılar): the DB-seeded Jira +
    // OpenRouter connections, tokens AES-encrypted under CONNECTOR_MASTER_KEY.
    // Flow screen: the live Jira workflow reader (undefined → named 503).
    ...(jiraWorkflow ? { jiraWorkflow } : {}),
    connections,
    // Uygulama ekle (Onboard, M100): submitting the wizard registers the picked
    // repo into the real `Application` table this reads elsewhere, so a brand-new
    // repo becomes bindable without a separate import step. Binding stays four-eyes.
    appRegistry: new PrismaAppRegistryWriter(db.application),
    // Approved onboarding proposal → live JiraProjectBinding (M93).
    bindingWriter: new PrismaBindingWriter(db.jiraProjectBinding),
    // The listening-rules store (Ayarlar > Dinleme Kuralları): status/issuetype
    // → flow-type rows an admin edits from Studio, backing the real DB table.
    listening: new PrismaListeningStore(db.listeningRule),
    // The analysis-guidance store (Bilgi kütüphanesi): "öğren" notes an admin
    // uploads; the enabled ones feed the analyst on a new analysis.
    guidance: new PrismaGuidanceStore(db.analysisGuidance),
    connectorSecrets,
    studio: {
      variants: new PrismaVariantCatalog(db.variant, db.variantVersion),
      // The write side, so an admin can genuinely create/re-version an agent
      // variant from Studio against the real DB — the whole point of this
      // launcher is exercising the real durable stores in a browser.
      variantWriter: new PrismaVariantWriter(db.variant, db.variantVersion),
      pii: new AuditPiiReader(auditStore, db.llmCall),
      decisions: new AuditDecisionReader(auditStore),
    },
  };

  const { host, port } = listenAddress();
  const server = await buildServer(deps);
  await server.listen({ host, port });

  console.log(`\n  BFF (gerçek kullanıcı DB'si) http://${host}:${port}`);
  console.log(
    `  Giriş: admin / <ilk migrate logundaki GEÇİCİ PAROLA ya da MAESTRO_BOOTSTRAP_PASSWORD>  → ilk girişte parola değiştirme\n`,
  );

  const studioDir = fileURLToPath(new URL("../../../studio", import.meta.url));
  spawn("pnpm", ["dev"], { cwd: studioDir, stdio: "inherit" });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

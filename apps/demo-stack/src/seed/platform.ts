import type {
  ApplicationRecord,
  RepoCard,
  SubscriptionAccount,
} from "@maestro/contracts";
import type {
  JiraBinding,
  KnowledgeDoc,
  OnboardingOptionsRecord,
  RepoPolicyRecord,
  RunnerRecord,
  SandboxRecord,
  ScanRecord,
  ServiceHealth,
} from "@maestro/bff";
import { stampBefore } from "./runs.js";

/**
 * The platform's own inventory: which applications exist, which Jira projects
 * are bound, what the fleet looks like, what the quota pool is doing, and what
 * the scanners found. Everything the operator screens read that is not a run.
 */

export const DEMO_APPS: readonly ApplicationRecord[] = [
  {
    appId: "ugurpay",
    displayName: "UgurPay — Ödeme çekirdeği",
    adoProject: "UgurBank",
    adoRepo: "ugurpay-core",
    platform: "linux-node",
    jiraComponent: "payments",
    maestroYamlPresent: true,
    createdVia: "onboarding",
  },
  {
    appId: "ugurweb",
    displayName: "UgurWeb — İnternet şubesi",
    adoProject: "UgurBank",
    adoRepo: "ugurweb",
    platform: "linux-node",
    jiraComponent: "web",
    maestroYamlPresent: true,
    createdVia: "onboarding",
  },
  {
    appId: "ugurmobil-ios",
    displayName: "UgurMobil — iOS",
    adoProject: "UgurBank",
    adoRepo: "ugurmobil-ios",
    platform: "macos-xcode",
    jiraComponent: "ios",
    maestroYamlPresent: true,
    createdVia: "onboarding",
  },
  {
    appId: "ugurmobil-android",
    displayName: "UgurMobil — Android",
    adoProject: "UgurBank",
    adoRepo: "ugurmobil-android",
    platform: "linux-android",
    jiraComponent: "android",
    maestroYamlPresent: true,
    createdVia: "onboarding",
  },
  {
    appId: "ugurdesk",
    displayName: "UgurDesk — Şube masaüstü",
    adoProject: "UgurBank",
    adoRepo: "ugurdesk",
    platform: "windows-dotnet",
    jiraComponent: "desktop",
    // Deliberately absent: the flow stops rather than inventing build commands
    // (M52), and an operator should be able to see one such app in the demo.
    maestroYamlPresent: false,
    createdVia: "import",
  },
];

/** Repo cards exist for the two apps whose analyses run most (M100). */
export function demoRepoCards(now: Date): readonly RepoCard[] {
  return [
    {
      appId: "ugurpay",
      modules: [
        { name: "refund", path: "src/refund", summary: "İade akışı, tutar yuvarlama ve mutabakat." },
        { name: "limits", path: "src/limits", summary: "Kredi ve kart limit hesaplama kuralları." },
        { name: "iban", path: "src/iban", summary: "TR IBAN doğrulama ve blok kontrolü." },
      ],
      generatedFromSha: "9f3ac21",
      version: 4,
      updatedAt: stampBefore(now, 30),
    },
    {
      appId: "ugurweb",
      modules: [
        { name: "auth", path: "app/auth", summary: "Giriş, captcha ve oturum yönetimi." },
        { name: "widgets", path: "app/widgets", summary: "Döviz ve kampanya bileşenleri." },
      ],
      generatedFromSha: "71bd4a0",
      version: 2,
      updatedAt: stampBefore(now, 96),
    },
  ];
}

/**
 * Jira project bindings (M102). `UGURKREDI` is bound but PAUSED, and an unbound
 * project is simply absent — the single global webhook delivers everything, and
 * "not listed" must never read as "take it anyway".
 */
export const DEMO_BINDINGS: readonly JiraBinding[] = [
  { projectKey: "UGURPAY", active: true, triggerMode: "auto", appId: "ugurpay", mode: "full_auto", dataClass: "gizli" },
  { projectKey: "UGURWEB", active: true, triggerMode: "auto", appId: "ugurweb", mode: "full_auto", dataClass: "dahili" },
  { projectKey: "UGURMOB", active: true, triggerMode: "opt_in", appId: "ugurmobil-ios", mode: "full_auto", dataClass: "dahili" },
  { projectKey: "UGURDESK", active: true, triggerMode: "auto", appId: "ugurdesk", mode: "full_auto", dataClass: "gizli" },
  { projectKey: "UGURKREDI", active: false, triggerMode: "opt_in", appId: null, mode: "human_lead", dataClass: "dahili" },
];

/** The runner fleet (M60). `mac-02` is unreachable, as the mock's scenario has it. */
export function demoRunners(now: Date): readonly RunnerRecord[] {
  return [
    { runnerId: "lnx-01", pool: "docker-linux", platform: "linux-node", state: "busy", capacity: 6, activeSandboxes: 3, lastHeartbeatAt: stampBefore(now, 0.01), note: null },
    { runnerId: "lnx-02", pool: "docker-linux", platform: "linux-android", state: "busy", capacity: 6, activeSandboxes: 1, lastHeartbeatAt: stampBefore(now, 0.02), note: null },
    { runnerId: "win-01", pool: "agent-windows", platform: "windows-dotnet", state: "busy", capacity: 2, activeSandboxes: 1, lastHeartbeatAt: stampBefore(now, 0.03), note: null },
    { runnerId: "win-02", pool: "agent-windows", platform: "windows-dotnet", state: "idle", capacity: 2, activeSandboxes: 0, lastHeartbeatAt: stampBefore(now, 0.05), note: null },
    { runnerId: "mac-01", pool: "agent-macos", platform: "macos-xcode", state: "busy", capacity: 2, activeSandboxes: 1, lastHeartbeatAt: stampBefore(now, 0.04), note: null },
    {
      runnerId: "mac-02",
      pool: "agent-macos",
      platform: "macos-xcode",
      state: "unreachable",
      capacity: 2,
      activeSandboxes: 0,
      // Two hours since the last heartbeat: the state and the timestamp tell the
      // same story, so the screen does not have to be believed on its own.
      lastHeartbeatAt: stampBefore(now, 2),
      note: "Xcode güncellemesi sonrası ajan bağlanmıyor — iOS kapasitesi yarıya düştü.",
    },
  ];
}

/** Live and left-behind sandboxes (M31/M65). */
export function demoSandboxes(now: Date): readonly SandboxRecord[] {
  return [
    { ticketKey: "UGURPAY-501", runnerId: "lnx-01", state: "resumable", sizeBytes: 1_932_735_283, lastAccessAt: stampBefore(now, 0.2) },
    { ticketKey: "UGURWEB-88", runnerId: "lnx-01", state: "active", sizeBytes: 486_539_264, lastAccessAt: stampBefore(now, 0.05) },
    { ticketKey: "UGURPAY-503", runnerId: "lnx-02", state: "active", sizeBytes: 723_517_440, lastAccessAt: stampBefore(now, 0.1) },
    { ticketKey: "UGURDESK-45", runnerId: "win-01", state: "resumable", sizeBytes: 966_367_641, lastAccessAt: stampBefore(now, 0.4) },
    { ticketKey: "UGURPAY-502", runnerId: "mac-01", state: "active", sizeBytes: 1_288_490_188, lastAccessAt: stampBefore(now, 0.08) },
    { ticketKey: "UGURWEB-95", runnerId: "lnx-01", state: "human_held", sizeBytes: 314_572_800, lastAccessAt: stampBefore(now, 6) },
  ];
}

/**
 * The subscription pool (M55). One account is exhausted and one is cooling,
 * which is why UGURPAY-689 is queued rather than failed — the pool still has
 * capacity, so the platform waits instead of giving up.
 */
export function demoAccounts(now: Date): readonly SubscriptionAccount[] {
  return [
    {
      accountId: "claude-pool-01",
      driver: "claude-sub",
      windows: [
        { kind: "5h", usedPct: 41, resetsAt: stampBefore(now, -2.4) },
        { kind: "weekly", usedPct: 62, resetsAt: stampBefore(now, -70) },
      ],
      state: "ready",
      lastUsedAt: stampBefore(now, 0.02),
    },
    {
      accountId: "claude-pool-02",
      driver: "claude-sub",
      windows: [
        { kind: "5h", usedPct: 100, resetsAt: stampBefore(now, -1.1) },
        { kind: "weekly", usedPct: 88, resetsAt: stampBefore(now, -70) },
      ],
      state: "exhausted",
      lastUsedAt: stampBefore(now, 1.2),
    },
    {
      accountId: "claude-pool-03",
      driver: "claude-sub",
      windows: [
        { kind: "5h", usedPct: 94, resetsAt: stampBefore(now, -0.6) },
        { kind: "weekly", usedPct: 71, resetsAt: stampBefore(now, -70) },
      ],
      state: "cooling",
      lastUsedAt: stampBefore(now, 0.6),
    },
    {
      accountId: "gemini-pool-01",
      driver: "gemini-sub",
      windows: [{ kind: "weekly", usedPct: 12, resetsAt: stampBefore(now, -90) }],
      state: "disabled",
      lastUsedAt: null,
    },
  ];
}

/** Scanner findings (M27). UGURDESK-52 fails closed, which is why its run is `fail`. */
export function demoScans(now: Date): readonly ScanRecord[] {
  return [
    {
      ticketKey: "UGURDESK-52",
      finding: { tool: "gitleaks", severity: "critical", ruleId: "generic-api-key", file: "src/Eft/BatchImporter.cs", line: 118, message: "Kaynak kodda gömülü kimlik bilgisi bulundu." },
      outcome: "fail",
      at: stampBefore(now, 1.5),
    },
    {
      ticketKey: "UGURDESK-45",
      finding: { tool: "semgrep", severity: "high", ruleId: "csharp.sqli.string-concat", file: "src/Report/Exporter.cs", line: 244, message: "SQL sorgusu dizge birleştirmeyle kuruluyor." },
      outcome: "fail",
      at: stampBefore(now, 3),
    },
    {
      ticketKey: "UGURPAY-501",
      finding: { tool: "trivy", severity: "medium", ruleId: "CVE-2025-31921", file: "package-lock.json", message: "Geliştirme bağımlılığında orta seviye güvenlik açığı." },
      outcome: "pass",
      at: stampBefore(now, 50),
    },
    {
      ticketKey: "UGURPAY-123",
      finding: { tool: "semgrep", severity: "info", ruleId: "javascript.lang.correctness.no-floating-decimal", file: "src/refund/round.ts", line: 27, message: "Ondalık karşılaştırmada kayan nokta toleransı önerilir." },
      outcome: "pass",
      at: stampBefore(now, 6),
    },
    {
      ticketKey: "UGURWEB-72",
      finding: { tool: "trivy", severity: "low", ruleId: "CVE-2025-11002", file: "yarn.lock", message: "Düşük seviye bağımlılık uyarısı; geliştirme zincirinde." },
      outcome: "pass",
      at: stampBefore(now, 8),
    },
  ];
}

/**
 * The knowledge index (M18/M63). `gizli` documents are in the index but the BFF
 * drops them on the way out for anyone without the clearance — so a `viewer`
 * searching "limit" sees a shorter list AND a count of what was withheld, which
 * is the behaviour worth demonstrating.
 */
export function demoKnowledge(now: Date): readonly KnowledgeDoc[] {
  return [
    { id: "kb-001", title: "Kredi limiti artırma iş kuralları", snippet: "Limit artırım talepleri BDDK bildirim eşiğinin üzerinde ikinci onay gerektirir.", source: "confluence://UGURBANK/krediler/limit-kurallari", score: 0.94, dataClass: "gizli", appId: "ugurpay", updatedBy: "can.ozturk", updatedAt: stampBefore(now, 200) },
    { id: "kb-002", title: "IBAN doğrulama standardı (TR)", snippet: "TR IBAN'ları 26 karakterdir; blok kontrolü mod-97 ile yapılır.", source: "confluence://UGURBANK/odeme/iban", score: 0.88, dataClass: "dahili", appId: "ugurpay", updatedBy: "mert.demir", updatedAt: stampBefore(now, 420) },
    { id: "kb-003", title: "İade akışı mutabakat notları", snippet: "İade tutarları gün sonu mutabakatında kuruş bazında eşleşmelidir.", source: "confluence://UGURBANK/odeme/iade", score: 0.81, dataClass: "dahili", appId: "ugurpay", updatedBy: "deniz.yilmaz", updatedAt: stampBefore(now, 310) },
    { id: "kb-004", title: "Mobil sertifika sabitleme politikası", snippet: "Pinning anahtarları yıllık döner; yedek anahtar zorunludur.", source: "confluence://UGURBANK/mobil/pinning", score: 0.79, dataClass: "dahili", appId: "ugurmobil-ios", updatedBy: "selin.aydin", updatedAt: stampBefore(now, 500) },
    { id: "kb-005", title: "Erişilebilirlik kontrol listesi (WCAG AA)", snippet: "Form etiketleri, odak sırası ve kontrast oranı için asgari ölçütler.", source: "confluence://UGURBANK/web/erisilebilirlik", score: 0.72, dataClass: "acik", appId: "ugurweb", updatedBy: "ayse.kaya", updatedAt: stampBefore(now, 620) },
    { id: "kb-006", title: "Şube masaüstü EFT dosya formatı", snippet: "Toplu EFT dosyaları müşteri numarası ve IBAN alanlarını içerir; maskeleme zorunludur.", source: "confluence://UGURBANK/sube/eft-format", score: 0.9, dataClass: "gizli", appId: "ugurdesk", updatedBy: "ayse.kaya", updatedAt: stampBefore(now, 150) },
  ];
}

/**
 * Platform dependency health (M6).
 *
 * This is where the demo announces itself. Studio's health screen renders each
 * row's `note` through the message catalog (`useLabel`), so `demo.stack.note` is
 * a KEY that resolves to the tr/en sentence in `packages/config/locales` — not a
 * sentence this file made up and shipped to a browser. The rows are honest in
 * both directions: the BFF really is healthy, and Postgres, Temporal, Jira, ADO,
 * Vault and the LLM gateway really are `down`, because in the demo they are not
 * connected at all.
 */
export function demoServices(now: Date): readonly ServiceHealth[] {
  const checkedAt = now.toISOString();
  const down = (service: string): ServiceHealth => ({
    service,
    state: "down",
    version: "—",
    checkedAt,
    note: "demo.stack.not_connected",
  });
  return [
    { service: "bff", state: "healthy", version: "0.1.0-demo", checkedAt, note: "demo.stack.note" },
    { service: "studio", state: "healthy", version: "0.1.0-demo", checkedAt, note: "demo.stack.note" },
    down("postgres"),
    down("temporal"),
    down("vault"),
    down("storage"),
    down("egress_proxy"),
    down("worker"),
    down("runner"),
  ];
}

/**
 * The onboarding wizard's lists, derived from the demo's OWN inventory rather
 * than typed out again (M93/M102).
 *
 * Derived on purpose: a second hand-written copy of the applications would
 * drift from `DEMO_APPS` the first time somebody added one, and the wizard
 * would then offer a repository the registry does not have.
 */
export function demoOnboardingOptions(): OnboardingOptionsRecord {
  const repos = DEMO_APPS.map((app) => ({
    appId: app.appId,
    repo: `${app.adoProject}/_git/${app.adoRepo}`,
    platform: app.platform,
  }));
  return {
    // `JiraBinding.active` is a boolean here, so the state is spelled the way
    // the binding table would: the wizard refuses `active` and allows `draft`.
    projects: DEMO_BINDINGS.map((binding) => ({
      projectKey: binding.projectKey,
      state: binding.active ? "active" : "draft",
    })),
    repos,
    platforms: [...new Set(repos.map((repo) => repo.platform))].sort(),
  };
}

/**
 * One policy per demo application (M52/M71). `ugurdesk` has no `.maestro.yaml`
 * and keeps that property here: the screen must show "never observed" for it
 * rather than a plausible-looking empty document.
 */
export function demoRepoPolicies(now: Date): readonly RepoPolicyRecord[] {
  return DEMO_APPS.map((app) => ({
    appId: app.appId,
    platform: app.platform,
    repo: `${app.adoProject}/_git/${app.adoRepo}`,
    yamlPresent: app.maestroYamlPresent,
    repoAdditions: app.appId === "ugurpay" ? ["src/payment-core/**"] : [],
    verification: app.maestroYamlPresent
      ? [
          { name: "lint", command: ["pnpm", "lint"] },
          { name: "test", command: ["pnpm", "test"] },
        ]
      : [],
    observedAt: app.maestroYamlPresent ? stampBefore(now, 24) : null,
  }));
}

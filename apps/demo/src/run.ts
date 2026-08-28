import type { AdoCiDriver, AdoScmDriver } from "@maestro/adapter-ado";
import {
  bulletList,
  doc,
  heading,
  inlineCode,
  paragraph,
  strong,
  text,
  type JiraDcWorkPort,
} from "@maestro/adapter-jira";
import type { AuditChain } from "@maestro/audit";
import {
  AnalysisDoc,
  type AuditAction,
  type CommandEnvelope,
  type LlmRole,
  type TicketKey,
} from "@maestro/contracts";
import type { LlmGateway } from "@maestro/llm-gateway";
import { compiledProfileFor, scanForPii, type LoadedPiiPolicy } from "@maestro/pii";
import type { RepoRef } from "@maestro/ports";
import { z } from "zod";
import {
  ADO_PROJECT,
  ADO_REPO,
  APPROVER_GROUP,
  DEMO_DATA_CLASS,
  DEMO_VARIANT,
  TICKET_KEY,
} from "./config.js";
import type { StateStore } from "./state.js";
import {
  createWorkspace,
  IMPLEMENTATION_PATH,
  TEST_PATH,
  type DemoWorkspace,
} from "./workspace.js";

/**
 * The shortened delivery flow. Temporal, the 19 steps and the six gates are
 * wave 3; what runs here is the honest subset the masterplan §5 story needs:
 *
 *   intake → analiz → İNSAN KAPISI → kod → tarama → test → PR → İNSAN KAPISI → merge
 *
 * Every step goes through the REAL packages. Nothing is simulated inside
 * Maestro itself: the only props are the two servers on the other side of
 * localhost, and the one place a human would click "Complete" in Azure DevOps.
 */

/** A step that failed for a reason worth showing on screen rather than a stack. */
export class DemoStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoStepError";
  }
}

const IntakeVerdict = z
  .object({
    complete: z.boolean(),
    missing: z.array(z.string()).max(5),
    note: z.string().min(1),
  })
  .strict();
type IntakeVerdict = z.infer<typeof IntakeVerdict>;

const CodeDraft = z
  .object({
    summary: z.string().min(1),
    implementation: z.string().min(1),
    test: z.string().min(1),
  })
  .strict();
type CodeDraft = z.infer<typeof CodeDraft>;

const APP_IDS = ["ugurpay", "ugurweb", "ugurmobil-android", "ugurmobil-ios", "ugurmasaustu"];

/**
 * How many times the engineer role may try before the step is called failed.
 * The rounds are the real dev loop — a scan finding or a red test goes back to
 * the model with the reason — and they are visible on screen, not swallowed.
 */
const MAX_ENGINEER_ATTEMPTS = 3;

/** Models sometimes fence code even when told not to; the fence is not code. */
function stripFences(value: string): string {
  const fenced = /^\s*```(?:[a-zA-Z]*)\n([\s\S]*?)```\s*$/.exec(value);
  return (fenced?.[1] ?? value).trim();
}

const APPLICATION = {
  appId: "ugurpay",
  displayName: "Ugur Payments",
  adoProject: ADO_PROJECT,
  adoRepo: ADO_REPO,
  platform: "linux-node",
  jiraComponent: null,
  maestroYamlPresent: false,
  createdVia: "import",
} as const;

/** Corporate accounts of the Jira usernames the demo knows (audit needs `user@corp`). */
const ACCOUNTS: Record<string, string> = {
  "mert.demir": "mert.demir@bank.example",
  "selin.arslan": "selin.arslan@bank.example",
  "ayse.kaya": "ayse.kaya@bank.example",
};

export interface DemoRunDeps {
  work: JiraDcWorkPort;
  scm: AdoScmDriver;
  ci: AdoCiDriver;
  llm: LlmGateway;
  audit: AuditChain;
  piiPolicy: LoadedPiiPolicy;
  store: StateStore;
  /** Stands in for the human who presses "Complete" in the ADO PR screen. */
  completePullRequest: (prId: number) => boolean;
  /** Called whenever the Jira side changed, so the UI can refresh its pane. */
  onJiraChanged?: () => void;
  ciTimeoutMs?: number;
  mergePollMs?: number;
}

interface GateWaiter {
  step: string;
  resolve: (envelope: CommandEnvelope) => void;
  reject: (error: Error) => void;
}

export class DemoRun {
  private readonly ticketKey = TICKET_KEY as TicketKey;
  private runId = "";
  private gate: GateWaiter | null = null;
  private ciWaiter: { prId: number; resolve: (ok: boolean) => void } | null = null;
  private progressCommentId: string | null = null;
  private workspace: DemoWorkspace | null = null;
  private repo: RepoRef | null = null;
  private branch = "";

  constructor(private readonly deps: DemoRunDeps) {}

  // ---------------------------------------------------------------- run

  async start(): Promise<void> {
    const { store } = this.deps;
    if (store.snapshot().running) throw new Error("akış zaten çalışıyor");
    this.runId = `demo-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
    this.progressCommentId = null;
    this.repo = null;
    this.branch = "";
    store.update((state) => {
      state.running = true;
      state.finished = false;
      state.failure = null;
      state.runId = this.runId;
      state.awaitingGate = null;
      // A second run on the same ticket starts from a clean board; the Jira
      // history stays, exactly as it would in a real re-run.
      state.log = [];
      state.llmCalls = 0;
      state.tokens = 0;
      state.maskedFields = 0;
      for (const step of state.steps) {
        step.state = "bekliyor";
        step.notes = [];
      }
    });
    store.log("info", `▶ akış başladı · run ${this.runId}`);

    try {
      await this.record("RUN_STARTED", { ticket: this.ticketKey });
      const analysis = await this.stepIntakeAndAnalysis();
      await this.stepAnalysisGate();
      const draft = await this.stepEngineering(analysis);
      const prId = await this.stepPullRequest(draft, analysis);
      await this.stepPrGate(prId);
      await this.stepMerge(prId);
      store.update((state) => {
        state.finished = true;
        state.running = false;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.log("err", `✗ akış durdu: ${message}`);
      store.update((state) => {
        state.failure = message;
        state.running = false;
      });
    } finally {
      await this.workspace?.dispose();
      this.workspace = null;
      await this.verifyAudit();
    }
  }

  // -------------------------------------------------------------- steps

  /** ① ticket read + ② analysis. */
  private async stepIntakeAndAnalysis(): Promise<AnalysisDoc> {
    const { store, work } = this.deps;
    store.step("1", "calisiyor");

    const ticket = await work.getTicket(this.ticketKey);
    store.log("ok", `✓ Jira'dan okundu: ${ticket.key} — ${ticket.summary}`);
    store.note("1", `bildiren: ${ticket.reporter} · bileşen: ${ticket.components.join(", ") || "—"}`);

    const labels = ticket.labels.includes("maestro") ? ticket.labels : [...ticket.labels, "maestro"];
    await work.setLabels(this.ticketKey, labels);
    store.log("dim", `→ etiketler güncellendi: ${labels.join(", ")}`);

    const progress = await work.addComment(
      this.ticketKey,
      doc(
        paragraph([strong("▶ Maestro durum:"), text(" analiz hazırlanıyor…")]),
        paragraph("Bu yorum yenisi açılmadan düzenlenerek güncellenir (M75)."),
      ),
    );
    this.progressCommentId = progress.commentId;
    this.deps.onJiraChanged?.();
    store.step("1", "tamam", "Jira'ya durum yorumu bırakıldı");

    store.step("2", "calisiyor");
    const intake = await this.think<IntakeVerdict>("intake", "IntakeVerdict", IntakeVerdict, {
      gorev: "Ticket geliştirmeye başlamak için yeterli mi? Eksikleri listele.",
      dil: "tr",
      ticket: {
        key: ticket.key,
        ozet: ticket.summary,
        aciklama: ticket.description,
        bilesenler: ticket.components,
      },
      kurallar: ["Kısa yaz.", "missing en fazla 3 madde.", "note tek cümle, Türkçe."],
    });
    store.log(
      intake.display.complete ? "ok" : "warn",
      `${intake.display.complete ? "✓" : "!"} intake: ${intake.display.note}`,
    );
    if (!intake.display.complete && intake.display.missing.length > 0) {
      store.note("2", `eksik görülen: ${intake.display.missing.join(" · ")}`);
      store.log(
        "warn",
        "! gerçek akışta burada 2b clarification kapısı açılır (reporter'a soru); bu kısaltılmış demoda devam ediliyor",
      );
    }

    const analysis = await this.think<AnalysisDoc>("analyst", "AnalysisDoc", AnalysisDoc, {
      gorev: "Bu ticket için kurum analiz şablonunu doldur (7 bölüm).",
      sablonSurumu: "demo-v3",
      dil: "tr",
      uygulama: APPLICATION,
      gecerliAppIdler: APP_IDS,
      ticket: {
        key: ticket.key,
        ozet: ticket.summary,
        aciklama: ticket.description,
        bilesenler: ticket.components,
      },
      kurallar: [
        "language alanı 'tr' olacak.",
        "templateVersion alanı 'demo-v3' olacak.",
        "impactMatrix yalnız gecerliAppIdler listesindeki appId değerlerini kullanır.",
        "impactMatrix'te en az ugurpay satırı bulunmalı.",
        "riskTier: dusuk | orta | kritik.",
        "Metinler Türkçe, kısa ve somut olsun.",
        "Köşeli parantezli belirteçler (ör. [EMAIL_1.ab12]) maskeleme çıktısıdır; aynen bırak.",
      ],
    });
    store.log(
      "ok",
      `✓ analyst: şablon 7/7 doğrulandı · risk: ${analysis.display.riskTier} · etki satırı: ${analysis.display.impactMatrix.length}`,
    );
    store.note("2", `risk: ${analysis.display.riskTier} — ${analysis.display.riskReason}`);

    await this.updateProgress("analiz hazır — onay bekleniyor");
    await work.addComment(this.ticketKey, analysisComment(analysis.display));
    this.deps.onJiraChanged?.();
    store.step("2", "tamam");
    return analysis.display;
  }

  /** ③ human gate on the analysis (M51 gate "5"). */
  private async stepAnalysisGate(): Promise<void> {
    const { store } = this.deps;
    await this.record("GATE_OPEN", { step: "5", group: APPROVER_GROUP });
    store.step("3", "onay");
    store.log("warn", `⏸ kapı açık — Jira'ya ${"/approve"} yazılmasını bekliyorum (${APPROVER_GROUP})`);
    const envelope = await this.awaitApproval("3");
    store.step("3", "tamam", `onaylayan: ${envelope.author}`);
    store.log("ok", `✓ analiz onayı: ${envelope.author} · grup üyeliği doğrulandı`);
  }

  /** ④ + ⑤ + ⑥ — engineering, scan and the test that really runs. */
  private async stepEngineering(analysis: AnalysisDoc): Promise<CodeDraft> {
    const { store, scm } = this.deps;
    store.step("4", "calisiyor");

    const repo = await scm.resolveRepo(APPLICATION);
    store.log("ok", `✓ ADO deposu çözüldü: ${repo.project}/${repo.repo}`);
    const branch = `feature/${this.ticketKey}-demo`;
    await scm.createBranch(repo, branch, "refs/heads/main");
    store.log("ok", `✓ dal açıldı: ${branch}`);
    store.note("4", `dal: ${branch}`);
    this.repo = repo;
    this.branch = branch;

    this.workspace = await createWorkspace();
    const profile = compiledProfileFor(this.deps.piiPolicy, DEMO_DATA_CLASS).profile;

    let feedback: string | null = null;
    let previousCode: CodeDraft | null = null;
    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ENGINEER_ATTEMPTS; attempt += 1) {
      if (attempt > 1) {
        store.step("4", "calisiyor", `düzeltme turu ${attempt}`);
        store.log("warn", `↻ mühendis düzeltme turu ${attempt}: ${lastError}`);
      }
      const draft = await this.think<CodeDraft>("engineer", "CodeDraft", CodeDraft, {
        gorev: "Aşağıdaki analize göre küçük ve çalışır bir modül + testini yaz.",
        dil: "tr",
        analiz: {
          amac: analysis.purpose,
          kabulKriterleri: analysis.acceptanceCriteria,
          testYaklasimi: analysis.testApproach,
        },
        dosyalar: { uygulama: IMPLEMENTATION_PATH, test: TEST_PATH },
        kurallar: [
          "Her iki dosya da ESM'dir (.mjs): require() KULLANMA, yalnız import kullan.",
          "implementation: saf ESM JavaScript modülü, dışa `export` ile açılır, yalnız node: yerleşiklerini kullanabilir.",
          `test: '${TEST_PATH}' dosyasının içeriği; uygulamayı "import { ... } from '../src/impl.mjs'" ile alır.`,
          "test dosyası \"import assert from 'node:assert/strict'\" kullanır ve başarılıysa konsola 'OK' yazar.",
          "Test kendi kendine yeterli olmalı; ağ, dosya sistemi, zamanlayıcı kullanma.",
          "Kodun ve testin içine e-posta adresi, telefon, TCKN, IBAN veya kart numarası YAZMA — örnek/sahte olanları bile. '@' işareti geçen metin kullanma.",
          "summary: 1-2 cümle Türkçe özet.",
          "Markdown kod bloğu (```) kullanma; alanlar düz metin olacak.",
        ],
        ...(feedback === null ? {} : { oncekiHata: feedback }),
        ...(previousCode === null ? {} : { oncekiKod: previousCode }),
      });

      const code: CodeDraft = {
        summary: draft.masked.summary,
        implementation: stripFences(draft.masked.implementation),
        test: stripFences(draft.masked.test),
      };
      previousCode = code;
      await this.workspace.write(IMPLEMENTATION_PATH, code.implementation);
      await this.workspace.write(TEST_PATH, code.test);
      store.log("ok", `✓ engineer: ${IMPLEMENTATION_PATH} + ${TEST_PATH} yazıldı`);
      store.note("4", draft.display.summary);
      store.step("4", "tamam");

      // ---- ⑤ scan (fail-closed)
      store.step("5", "calisiyor");
      const counts = scanForPii({ implementation: code.implementation, test: code.test }, profile);
      if (counts.occurrences > 0) {
        const types = Object.keys(counts.byType).join(", ");
        lastError = `üretilen kodda kişisel veri bulundu (${types}); temizlenmeli`;
        feedback = lastError;
        store.step("5", "hata", lastError);
        await this.record("SECURITY_SCAN_FAIL", { occurrences: counts.occurrences });
        store.log("err", `✗ tarama: ${lastError}`);
        continue;
      }
      await this.record("SECURITY_SCAN_PASS", { scanner: "pii", files: 2 });
      store.step("5", "tamam", "kişisel veri bulunmadı (0 bulgu)");
      store.log("ok", "✓ tarama: kişisel veri sızıntısı yok (gitleaks/semgrep/trivy Dalga 2'de)");

      // ---- ⑥ the test really runs
      store.step("6", "calisiyor");
      const run = await this.workspace.runTest();
      await this.record("TEST_RUN_COMPLETE", {
        passed: run.ok,
        exitCode: run.exitCode ?? -1,
        durationMs: run.durationMs,
      });
      if (!run.ok) {
        lastError = (run.stderr || run.stdout || "test çıkış kodu != 0").split("\n").slice(0, 6).join(" | ");
        feedback = lastError;
        store.step("6", "hata", lastError);
        store.log("err", `✗ test koştu ve DÜŞTÜ (${run.durationMs} ms): ${lastError}`);
        continue;
      }
      store.step("6", "tamam", `çıkış kodu 0 · ${run.durationMs} ms`);
      store.log("ok", `✓ test gerçekten koştu: çıkış kodu 0 (${run.durationMs} ms) ${run.stdout ? `· ${run.stdout.split("\n")[0]}` : ""}`);
      return code;
    }

    throw new DemoStepError(
      `kod/tarama/test döngüsü ${MAX_ENGINEER_ATTEMPTS} turda yeşile dönmedi — son hata: ${lastError}`,
    );
  }

  /** ⑦ pull request + the CI signal that arrives as a Service Hook. */
  private async stepPullRequest(draft: CodeDraft, analysis: AnalysisDoc): Promise<number> {
    const { store, scm } = this.deps;
    const repo = this.repo;
    if (repo === null) throw new DemoStepError("depo çözülmeden PR açılamaz");
    store.step("7", "calisiyor");

    const { prId } = await scm.openPr(repo, {
      sourceBranch: this.branch,
      targetBranch: "main",
      title: `[AI] ${this.ticketKey} ${analysis.purpose.slice(0, 60)}`,
      description: `${draft.summary}\n\nMaestro demo çalışması — ${this.ticketKey}`,
      draft: true,
    });
    store.log("ok", `✓ PR #${prId} taslak olarak açıldı`);
    await this.record("PR_OPENED", { prId, branch: this.branch });

    await scm.activatePr(repo, prId);
    store.log("dim", `→ PR #${prId} taslaktan çıktı — ADO branch policy build validation'ı kuyruğa aldı`);

    const threads = await scm.listPrThreads(repo, prId);
    store.note("7", `PR #${prId} · açık inceleme yorumu: ${threads.length}`);

    const green = await this.awaitCi(prId);
    if (!green) {
      store.step("7", "hata", "CI kırmızı");
      throw new DemoStepError(`CI build'i başarısız döndü (PR #${prId})`);
    }
    store.step("7", "tamam", `CI yeşil · PR #${prId}`);
    return prId;
  }

  /** ⑧ human gate on the pull request (M51 gate "12"). */
  private async stepPrGate(prId: number): Promise<void> {
    const { store, work } = this.deps;
    await work.addComment(
      this.ticketKey,
      doc(
        heading(3, "✅ PR hazır"),
        paragraph([text("Pull request "), strong(`#${prId}`), text(" açıldı, testler ve CI yeşil.")]),
        paragraph([text("Onay için "), inlineCode("/approve"), text(" yazın.")]),
      ),
    );
    this.deps.onJiraChanged?.();
    await this.record("GATE_OPEN", { step: "12", prId });
    store.step("8", "onay");
    store.log("warn", `⏸ ikinci kapı açık — PR #${prId} onayı bekleniyor`);
    const envelope = await this.awaitApproval("8");
    store.step("8", "tamam", `onaylayan: ${envelope.author}`);
    store.log("ok", `✓ PR onayı: ${envelope.author}`);
  }

  /** ⑨ merge (by a human, in ADO) + closure. */
  private async stepMerge(prId: number): Promise<void> {
    const { store, scm, work } = this.deps;
    const repo = this.repo;
    if (repo === null) throw new DemoStepError("depo yok");
    store.step("9", "calisiyor");

    // M: merge is a HUMAN action in Azure DevOps. The demo presses that button
    // for you and says so — Maestro itself never merges.
    const merged = this.deps.completePullRequest(prId);
    store.log(
      "dim",
      merged
        ? "→ (demo) ADO ekranında PR'ı bir insan 'Complete' ile birleştirdi — Maestro merge etmez"
        : "→ (demo) PR zaten birleşmişti",
    );

    const deadline = Date.now() + 10_000;
    let status = await scm.getPrStatus(repo, prId);
    while (status.state !== "completed" && Date.now() < deadline) {
      await sleep(this.deps.mergePollMs ?? 300);
      status = await scm.getPrStatus(repo, prId);
    }
    if (status.state !== "completed") {
      throw new DemoStepError(`PR #${prId} birleşmedi (durum: ${status.state})`);
    }
    store.log("ok", `✓ merge doğrulandı · commit ${status.mergeSha?.slice(0, 8) ?? "?"}`);
    await this.record("PR_MERGED", { prId, mergeSha: status.mergeSha ?? null });

    await this.updateProgress("tamamlandı — PR birleşti");
    await work.addComment(
      this.ticketKey,
      doc(
        heading(3, "🎉 Tamamlandı"),
        paragraph(`${this.ticketKey} için PR #${prId} birleşti. Analiz, kod, test ve onay zinciri kayıt altında.`),
      ),
    );
    this.deps.onJiraChanged?.();
    await this.record("RUN_CLOSED", { prId });
    store.step("9", "tamam");
  }

  // ------------------------------------------------------------ webhooks

  /**
   * Jira delivery. Verification runs on the RAW body before anything else
   * touches it; a bad signature is refused, loudly (fail-closed).
   */
  async handleJiraWebhook(rawBody: string, headers: Record<string, string>): Promise<void> {
    const { store, work } = this.deps;
    await work.verifyWebhook(rawBody, headers);
    const payload: unknown = JSON.parse(rawBody);
    const parsed = work.parseCommandDetailed(payload);
    this.deps.onJiraChanged?.();

    if (parsed.invalid !== null) {
      store.log("warn", `! komut geçersiz: /${parsed.invalid.command} (${parsed.invalid.messageKey})`);
      return;
    }
    const envelope = parsed.envelope;
    if (envelope === null) return;
    store.log("dim", `→ jira webhook · imza ✓ · komut /${envelope.command.name} · ${envelope.author}`);

    if (envelope.command.name === "reject") {
      this.gate?.reject(new DemoStepError(`kapı reddedildi: ${envelope.command.reason}`));
      this.gate = null;
      return;
    }
    if (envelope.command.name !== "approve") return;

    const waiter = this.gate;
    if (!waiter) {
      store.log("warn", "! şu an açık bir onay kapısı yok — /approve yok sayıldı");
      return;
    }

    const member = await work.verifyMembership(envelope.author, APPROVER_GROUP);
    if (!member) {
      store.log("err", `✗ ${envelope.author} ${APPROVER_GROUP} grubunda değil — onay reddedildi`);
      await work.addComment(
        this.ticketKey,
        doc(paragraph(`❌ ${envelope.author} bu kapıyı onaylayamaz (${APPROVER_GROUP} üyesi değil).`)),
      );
      this.deps.onJiraChanged?.();
      return;
    }

    await this.record("GATE_APPROVE", { step: waiter.step, group: APPROVER_GROUP }, actorOf(envelope.author));
    this.gate = null;
    waiter.resolve(envelope);
  }

  /** ADO Service Hook delivery: authenticated, allow-listed, then parsed. */
  async handleAdoWebhook(headers: Record<string, string>, body: unknown): Promise<void> {
    const { store, ci } = this.deps;
    const signal = await ci.parseBuildEvent({ headers, body });
    if (signal === null) {
      store.log("dim", "→ ado service hook · ilgisiz olay, yok sayıldı");
      return;
    }
    store.log(
      signal.status === "succeeded" ? "ok" : "err",
      `→ ado build.complete · PR #${signal.prId} · build ${signal.buildId} · ${signal.status}`,
    );
    await this.record("CI_RESULT", {
      prId: signal.prId,
      buildId: signal.buildId,
      status: signal.status,
    });
    const waiter = this.ciWaiter;
    if (waiter && waiter.prId === signal.prId) {
      this.ciWaiter = null;
      waiter.resolve(signal.status === "succeeded");
    }
  }

  // ------------------------------------------------------------- helpers

  /** One thinking-role call: masked on the way out, re-opened for the screen. */
  private async think<T>(
    role: LlmRole,
    schemaName: string,
    schema: z.ZodType<T>,
    input: unknown,
  ): Promise<{ masked: T; display: T }> {
    const outcome = await this.deps.llm.generateObject(
      { role, variantId: DEMO_VARIANT, dataClass: DEMO_DATA_CLASS, schemaName, input },
      schema,
    );
    if (outcome.status !== "ok") {
      throw new DemoStepError(
        outcome.status === "queued"
          ? `model kuyruğa alındı (kota) — ${outcome.resumeAt}`
          : `model çağrısı '${outcome.status}': ${outcome.messageKey}`,
      );
    }
    const unmask = outcome.unmask;
    return { masked: outcome.value, display: unmask ? unmask(outcome.value) : outcome.value };
  }

  private awaitApproval(step: string): Promise<CommandEnvelope> {
    return new Promise<CommandEnvelope>((resolve, reject) => {
      this.gate = { step, resolve, reject };
    });
  }

  private awaitCi(prId: number): Promise<boolean> {
    const timeoutMs = this.deps.ciTimeoutMs ?? 60_000;
    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ciWaiter = null;
        reject(new DemoStepError(`CI sinyali ${timeoutMs / 1000} sn içinde gelmedi`));
      }, timeoutMs);
      this.ciWaiter = {
        prId,
        resolve: (ok) => {
          clearTimeout(timer);
          resolve(ok);
        },
      };
    });
  }

  private async updateProgress(message: string): Promise<void> {
    if (this.progressCommentId === null) return;
    await this.deps.work.updateComment(
      this.ticketKey,
      this.progressCommentId,
      doc(paragraph([strong("▶ Maestro durum:"), text(` ${message}`)])),
    );
    this.deps.onJiraChanged?.();
  }

  private async record(
    action: AuditAction,
    meta: Record<string, unknown>,
    actor = "maestro-worker",
  ): Promise<void> {
    const event = await this.deps.audit.append({
      actor,
      action,
      subject: this.ticketKey,
      meta: { ...meta, runId: this.runId },
    });
    this.deps.store.update((state) => {
      state.audit.records = event.seq;
    });
  }

  /** Re-verify the hash chain from genesis; the demo shows the answer as-is. */
  private async verifyAudit(): Promise<void> {
    const { store, audit } = this.deps;
    try {
      const result = await audit.verify();
      store.update((state) => {
        state.audit.verified = result.ok;
        state.audit.detail = result.ok ? null : JSON.stringify(result);
      });
      store.log(
        result.ok ? "ok" : "err",
        result.ok
          ? `✓ denetim zinciri doğrulandı — ${store.snapshot().audit.records} kayıt, hash zinciri kopuk değil`
          : "✗ denetim zinciri doğrulanamadı",
      );
    } catch (error) {
      store.log("err", `✗ denetim doğrulaması hata verdi: ${String(error)}`);
    }
  }
}

function actorOf(jiraUser: string): string {
  return ACCOUNTS[jiraUser] ?? `${jiraUser}@bank.example`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The analysis, rendered as the Jira comment a reviewer actually reads. */
function analysisComment(analysis: AnalysisDoc): ReturnType<typeof doc> {
  const impacted = analysis.impactMatrix
    .filter((cell) => cell.impacted)
    .map((cell) => `${cell.appId}: ${cell.summary}`);
  return doc(
    heading(3, "📋 Analiz hazır"),
    paragraph([strong("Amaç: "), text(analysis.purpose)]),
    paragraph([strong("Kapsam: "), text(analysis.scope.included.join(" · "))]),
    paragraph([strong("Kabul kriterleri:")]),
    bulletList(analysis.acceptanceCriteria),
    paragraph([strong("Etkilenen uygulamalar: "), text(impacted.join(" | ") || "yalnız bu uygulama")]),
    paragraph([strong("Ekran/API: "), text(analysis.uiApiChanges)]),
    paragraph([strong("Test yaklaşımı: "), text(analysis.testApproach)]),
    paragraph([
      strong("Risk: "),
      text(`${analysis.riskTier} — ${analysis.riskReason} · azaltma: ${analysis.riskAndRollback.mitigation}`),
    ]),
    paragraph([text("Onay için "), inlineCode("/approve"), text(" yazın.")]),
  );
}

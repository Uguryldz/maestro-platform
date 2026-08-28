/** Everything the watching browser sees. Plain data, broadcast over SSE. */

export type StepState = "bekliyor" | "calisiyor" | "onay" | "tamam" | "hata";

export interface PilotStep {
  id: string;
  title: string;
  /** One-line plain-language explanation, shown under the title. */
  hint: string;
  state: StepState;
  notes: string[];
}

export type LogLevel = "dim" | "info" | "ok" | "warn" | "err";

export interface LogLine {
  seq: number;
  at: string;
  level: LogLevel;
  text: string;
}

/** A ticket discovered on the live site by the discovery poll. */
export interface DiscoveredTicketView {
  key: string;
  summary: string;
  status: string | null;
  /** Issue type NAME — the auto-start guard classifies issuetype rules with it. */
  issueType: string | null;
  createdAt: string | null;
}

export interface PilotState {
  runId: string | null;
  /** The ticket the current/last run works on — chosen from discovery. */
  ticketKey: string | null;
  /** Deep link to the ticket on the REAL site (or null before one is picked). */
  browseUrl: string | null;
  model: string;
  /** Live Jira site the pilot is wired to (shown so nobody mistakes it for a prop). */
  jiraSite: string;
  approverGroup: string;
  running: boolean;
  finished: boolean;
  failure: string | null;
  /** Step id whose human gate is open right now, or null. */
  awaitingGate: string | null;
  /**
   * The flow type a listening rule classified the current ticket as
   * ("analiz" | "duzeltme" | "gelistirme"), or null when no rule matched (the
   * default, un-classified flow). Set at the start of a run, shown in the UI.
   */
  flowType: string | null;
  /** True once the analysis .docx/.pdf are generated and downloadable. */
  docsReady: boolean;
  /** Tickets opted in on the live site, newest first (from discovery poll). */
  discovered: DiscoveredTicketView[];
  steps: PilotStep[];
  log: LogLine[];
  audit: { records: number; verified: boolean | null; detail: string | null };
  maskedFields: number;
  llmCalls: number;
  tokens: number;
}

export const STEP_DEFINITIONS: ReadonlyArray<{ id: string; title: string; hint: string }> = [
  { id: "1", title: "Ticket okundu", hint: "Maestro GERÇEK Jira'dan ticket'ı çekti, etiketledi, durum yorumunu açtı." },
  { id: "2", title: "Analiz üretildi", hint: "Yapay zeka analizi yazdı; şablon 7 bölüm olarak doğrulandı." },
  { id: "3", title: "İnsan kapısı — analiz onayı", hint: "GERÇEK Jira'da yoruma /approve yazılmasını yokluyor (yetki + grup)." },
  { id: "4", title: "Kod yazıldı", hint: "Yapay zeka gerçek dosya içeriği üretti; çalışma alanına yazıldı." },
  { id: "5", title: "Tarama", hint: "Üretilen kod kişisel veri sızıntısına karşı tarandı (fail-closed)." },
  { id: "6", title: "Testler koştu", hint: "Üretilen test dosyası gerçekten çalıştırıldı — sonuç uydurulmadı." },
  { id: "7", title: "PR açıldı + CI", hint: "ADO'da (sahte) dal ve pull request açıldı; build sonucu webhook ile geldi." },
  { id: "8", title: "İnsan kapısı — PR onayı", hint: "GERÇEK Jira'da ikinci /approve yoklanıyor." },
  { id: "9", title: "Merge + kapanış", hint: "PR birleşti, ticket kapatıldı, denetim kaydı doğrulandı. Maestro burada durur — prod'a çıkış (release) kurumun kendi sürecidir." },
];

export function initialState(options: {
  model: string;
  jiraSite: string;
  approverGroup: string;
}): PilotState {
  return {
    runId: null,
    ticketKey: null,
    browseUrl: null,
    model: options.model,
    jiraSite: options.jiraSite,
    approverGroup: options.approverGroup,
    running: false,
    finished: false,
    failure: null,
    awaitingGate: null,
    flowType: null,
    docsReady: false,
    discovered: [],
    steps: STEP_DEFINITIONS.map((step) => ({ ...step, state: "bekliyor", notes: [] })),
    log: [],
    audit: { records: 0, verified: null, detail: null },
    maskedFields: 0,
    llmCalls: 0,
    tokens: 0,
  };
}

/**
 * A finished run, kept so the operator sees a HISTORY of past work — not just
 * the one run happening now. The pilot's live `PilotState` is overwritten by
 * each new run; this is the durable-per-process summary of the ones that ended.
 * (Process-local: it lives as long as the pilot does. That is enough to answer
 * "what has Maestro done", and keeps this off the run's hot path.)
 */
export interface RunHistoryEntry {
  runId: string;
  ticketKey: string;
  browseUrl: string | null;
  flowType: string | null;
  /** How it ended: completed cleanly, stopped at a gate, or failed. */
  outcome: "tamamlandı" | "durduruldu" | "hata";
  /** The failure/return reason when outcome is not "tamamlandı". */
  detail: string | null;
  /** How many of the nine steps reached "tamam". */
  stepsDone: number;
  stepsTotal: number;
  finishedAt: string;
}

/** How many finished runs the pilot remembers (newest kept, oldest dropped). */
const MAX_HISTORY = 100;

/** Tiny observable store; the UI server subscribes and forwards over SSE. */
export class StateStore {
  private state: PilotState;
  private seq = 0;
  private readonly listeners = new Set<(state: PilotState) => void>();
  private readonly history: RunHistoryEntry[] = [];

  constructor(initial: PilotState) {
    this.state = initial;
  }

  snapshot(): PilotState {
    return this.state;
  }

  /** The finished runs, newest first — the "geçmiş işler" list. */
  historySnapshot(): readonly RunHistoryEntry[] {
    return this.history;
  }

  /**
   * Record the CURRENT run into history. Called once when a run ends (finished
   * or failed), BEFORE the next run resets the live state. A run with no runId
   * (nothing has started) is ignored, and a runId already recorded is not
   * duplicated — so a double-call is safe.
   */
  archiveCurrent(): void {
    const s = this.state;
    if (s.runId === null || s.ticketKey === null) return;
    if (this.history.some((h) => h.runId === s.runId)) return;
    const stepsDone = s.steps.filter((step) => step.state === "tamam").length;
    // `failure` set = a real error. Otherwise the run ended cleanly: "tamamlandı"
    // if it ran to the last step, "durduruldu" if it stopped early on purpose (an
    // "analiz" flow that skips engineering, a clarification return, a rejected
    // analysis) — those finish without an error but do not complete all steps.
    const ranToEnd = s.steps[s.steps.length - 1]?.state === "tamam";
    const outcome: RunHistoryEntry["outcome"] =
      s.failure !== null ? "hata" : ranToEnd ? "tamamlandı" : "durduruldu";
    this.history.unshift({
      runId: s.runId,
      ticketKey: s.ticketKey,
      browseUrl: s.browseUrl,
      flowType: s.flowType,
      outcome,
      detail: s.failure,
      stepsDone,
      stepsTotal: s.steps.length,
      finishedAt: new Date().toISOString(),
    });
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
  }

  subscribe(listener: (state: PilotState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(mutate: (state: PilotState) => void): void {
    mutate(this.state);
    for (const listener of this.listeners) listener(this.state);
  }

  log(level: LogLevel, text: string): void {
    this.update((state) => {
      state.log.push({ seq: ++this.seq, at: new Date().toISOString(), level, text });
      if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
    });
  }

  step(id: string, state: StepState, note?: string): void {
    this.update((current) => {
      const step = current.steps.find((candidate) => candidate.id === id);
      if (!step) return;
      step.state = state;
      if (note !== undefined) step.notes.push(note);
      current.awaitingGate = state === "onay" ? id : current.awaitingGate === id ? null : current.awaitingGate;
    });
  }

  note(id: string, note: string): void {
    this.update((current) => {
      current.steps.find((candidate) => candidate.id === id)?.notes.push(note);
    });
  }
}

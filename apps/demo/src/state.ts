/** Everything the watching browser sees. Plain data, broadcast over SSE. */

export type StepState = "bekliyor" | "calisiyor" | "onay" | "tamam" | "hata";

export interface DemoStep {
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

export interface DemoState {
  runId: string | null;
  ticketKey: string;
  model: string;
  jiraUrl: string;
  adoUrl: string;
  approver: string;
  running: boolean;
  finished: boolean;
  failure: string | null;
  /** Step id whose human gate is open right now, or null. */
  awaitingGate: string | null;
  steps: DemoStep[];
  log: LogLine[];
  audit: { records: number; verified: boolean | null; detail: string | null };
  maskedFields: number;
  llmCalls: number;
  tokens: number;
}

export const STEP_DEFINITIONS: ReadonlyArray<{ id: string; title: string; hint: string }> = [
  { id: "1", title: "Ticket okundu", hint: "Maestro Jira'dan ticket'ı çekti, etiketledi, durum yorumunu açtı." },
  { id: "2", title: "Analiz üretildi", hint: "Yapay zeka analizi yazdı; şablon 7 bölüm olarak doğrulandı." },
  { id: "3", title: "İnsan kapısı — analiz onayı", hint: "Jira'ya /approve yazılmasını bekliyor (yetki + grup kontrolü)." },
  { id: "4", title: "Kod yazıldı", hint: "Yapay zeka gerçek dosya içeriği üretti; çalışma alanına yazıldı." },
  { id: "5", title: "Tarama", hint: "Üretilen kod kişisel veri sızıntısına karşı tarandı (fail-closed)." },
  { id: "6", title: "Testler koştu", hint: "Üretilen test dosyası gerçekten çalıştırıldı — sonuç uydurulmadı." },
  { id: "7", title: "PR açıldı + CI", hint: "ADO'da dal ve pull request açıldı; build sonucu webhook ile geldi." },
  { id: "8", title: "İnsan kapısı — PR onayı", hint: "İkinci /approve bekleniyor." },
  { id: "9", title: "Merge + denetim izi", hint: "PR birleşti; hash zincirli denetim kaydı doğrulandı." },
];

export function initialState(options: {
  ticketKey: string;
  model: string;
  jiraUrl: string;
  adoUrl: string;
  approver: string;
}): DemoState {
  return {
    runId: null,
    ticketKey: options.ticketKey,
    model: options.model,
    jiraUrl: options.jiraUrl,
    adoUrl: options.adoUrl,
    approver: options.approver,
    running: false,
    finished: false,
    failure: null,
    awaitingGate: null,
    steps: STEP_DEFINITIONS.map((step) => ({ ...step, state: "bekliyor", notes: [] })),
    log: [],
    audit: { records: 0, verified: null, detail: null },
    maskedFields: 0,
    llmCalls: 0,
    tokens: 0,
  };
}

/** Tiny observable store; the UI server subscribes and forwards over SSE. */
export class StateStore {
  private state: DemoState;
  private seq = 0;
  private readonly listeners = new Set<(state: DemoState) => void>();

  constructor(initial: DemoState) {
    this.state = initial;
  }

  snapshot(): DemoState {
    return this.state;
  }

  subscribe(listener: (state: DemoState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(mutate: (state: DemoState) => void): void {
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

import type { JiraCloudWorkPort } from "@maestro/adapter-jira";
import { t } from "@maestro/config";
import type { AnalysisDoc, RunId, TicketKey } from "@maestro/contracts";
import {
  buildDocumentModel,
  renderAnalysisMarkdown,
  renderDocx,
  renderPdf,
  type DocTemplateFile,
  type DocumentModel,
} from "@maestro/publish";

/**
 * Turning the REAL analysis (the model's structured `AnalysisDoc`) into a real
 * `.docx` and `.pdf` a reviewer can download from the pilot page.
 *
 * There is NO new renderer here. The publish package already owns the whole
 * chain, and every path this reuses is the one the bank's Confluence/Jira
 * publish uses in production:
 *
 *   AnalysisDoc → renderAnalysisMarkdown → buildDocumentModel → renderDocx / renderPdf
 *
 * The one document, one text principle (see `doc-model.ts`): the Word file and
 * the PDF are two renderings of ONE model derived from ONE canonical markdown,
 * so a section that appears in the download is a section that would appear on
 * the reviewed page. Turkish survives because the publish package guarantees it
 * (a Unicode font is embedded in the PDF; the docx carries UTF-8) — this module
 * only has to avoid mangling it on the way in, which it does by passing the
 * analysis through untouched.
 */

/** A generated download: the raw bytes plus the MIME type the route must set. */
export interface GeneratedDoc {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  /** Attachment file name, e.g. `OPS-7-analiz.pdf`. */
  readonly fileName: string;
}

export interface GeneratedDocs {
  readonly pdf: GeneratedDoc;
  readonly docx: GeneratedDoc;
}

export const DOC_CONTENT_TYPE = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
} as const;

export type DocKind = keyof typeof DOC_CONTENT_TYPE;

export const DOC_KINDS: readonly DocKind[] = ["pdf", "docx"];

/** `OPS-7` → `OPS-7-analiz.pdf`. */
export function docFileName(ticketKey: string, kind: DocKind): string {
  return `${ticketKey}-analiz.${kind}`;
}

/**
 * Build the neutral `DocumentModel` from the analysis — the shared shape both
 * renderers consume. Exposed on its own so a test can assert all seven sections
 * survive the mapping (purpose, scope, impact, acceptance, ui/api, test, risk +
 * clarifications) without rendering bytes.
 *
 * `renderAnalysisMarkdown` validates the AnalysisDoc fail-closed and asserts the
 * language matches the locale, so a six-section analysis never reaches a file.
 * The künye date is injected (not `new Date()`) so the same analysis always
 * renders to the same bytes.
 */
export function analysisToDocModel(
  analysis: AnalysisDoc,
  ticketKey: TicketKey,
  runId: RunId,
  date: string,
): DocumentModel {
  const locale = analysis.language;
  const markdownSource = renderAnalysisMarkdown(analysis, {
    translate: t,
    locale,
    runId,
    ticketKey,
  });
  return buildDocumentModel({
    markdownSource,
    translate: t,
    locale,
    ticketKey,
    runId,
    templateVersion: analysis.templateVersion,
    date,
  });
}

/**
 * The active corporate Word template, as the composition root loads it from the
 * DB (`DocTemplateVersion`): the scan metadata `renderDocx` patches against plus
 * the raw uploaded bytes. Null everywhere a deployment has none — the plain
 * built-in layout is then used, exactly the old behaviour.
 */
export interface PilotDocTemplate {
  file: DocTemplateFile;
  bytes: Uint8Array;
}

/**
 * Render BOTH artefacts from one model. `renderDocx` patches the corporate
 * template when one is provided (the bank's own cover/styles survive; the
 * analysis sections land in its `{{bolum:N}}` slots). Without one it produces
 * the plain built-in layout and a `no_template` warning we do not need to
 * surface here — the same behaviour the pilot always had.
 */
export async function analysisToDocs(
  analysis: AnalysisDoc,
  ticketKey: TicketKey,
  runId: RunId,
  now: () => Date = () => new Date(),
  template: PilotDocTemplate | null = null,
): Promise<GeneratedDocs> {
  const date = now().toISOString().slice(0, 10);
  const model = analysisToDocModel(analysis, ticketKey, runId, date);

  const rendered = await renderDocx({
    model,
    template: template?.file ?? null,
    templateBytes: template?.bytes ?? null,
  });
  const pdfBytes = await renderPdf(model);

  return {
    docx: {
      bytes: rendered.bytes,
      contentType: DOC_CONTENT_TYPE.docx,
      fileName: docFileName(ticketKey, "docx"),
    },
    pdf: {
      bytes: pdfBytes,
      contentType: DOC_CONTENT_TYPE.pdf,
      fileName: docFileName(ticketKey, "pdf"),
    },
  };
}

/** The `addAttachment` capability the pilot needs from the concrete Cloud driver. */
export type AttachCapableWork = Pick<JiraCloudWorkPort, "addAttachment">;

/** Minimal logger seam so this is testable without the whole StateStore. */
export type AttachLog = (kind: "ok" | "warn", message: string) => void;

/** Outcome of the attach attempt — `true` iff BOTH files reached the ticket. */
export interface AttachResult {
  readonly attached: boolean;
  readonly ids: string[];
}

/**
 * Attach the generated Word + PDF to the live ticket (M103r) via the concrete
 * Cloud driver's `addAttachment` — a DRIVER capability, not a frozen WorkPort
 * method (see the driver's doc comment; the port surface would throw
 * `CapabilityNotSupportedError`).
 *
 * FAIL-SOFT by contract: the analysis comment and the download buttons already
 * stand by the time this runs, so a Jira hiccup here is logged and swallowed —
 * it NEVER throws, so it can never crash the run. A partial upload (docx lands,
 * pdf fails) still returns `attached: false` and logs the warning; the reviewer
 * falls back to the download buttons for whatever did not land.
 *
 * Order is docx then pdf so the log line and the recorded ids are deterministic.
 */
export async function attachAnalysisDocs(
  work: AttachCapableWork,
  ticketKey: TicketKey,
  generated: GeneratedDocs,
  log: AttachLog,
): Promise<AttachResult> {
  const ids: string[] = [];
  try {
    for (const doc of [generated.docx, generated.pdf]) {
      const res = await work.addAttachment(ticketKey, doc.fileName, doc.bytes, doc.contentType);
      ids.push(...res.ids);
    }
    log("ok", "✓ analiz belgesi Jira'ya eklendi: 2 dosya");
    return { attached: true, ids };
  } catch (error) {
    log("warn", `! analiz belgesi Jira'ya eklenemedi (akış etkilenmedi): ${String(error)}`);
    return { attached: false, ids };
  }
}

/**
 * Where the generated files live between generation and download. In-memory,
 * keyed by runId: the pilot runs one flow at a time and the page only ever
 * offers the current run's documents, so a single slot is enough — but keying
 * by runId means a download request for a stale run is a clean 404 rather than
 * the wrong file.
 */
export class DocStore {
  private runId: string | null = null;
  private docs: GeneratedDocs | null = null;

  /** Replace whatever was held with a fresh run's documents. */
  put(runId: string, docs: GeneratedDocs): void {
    this.runId = runId;
    this.docs = docs;
  }

  /** Drop the held documents (called when a new run starts). */
  clear(): void {
    this.runId = null;
    this.docs = null;
  }

  /** The current run's document of the given kind, or null if none is ready. */
  get(kind: DocKind): GeneratedDoc | null {
    return this.docs === null ? null : this.docs[kind];
  }

  /** Which run the held documents belong to, or null. */
  currentRunId(): string | null {
    return this.runId;
  }
}

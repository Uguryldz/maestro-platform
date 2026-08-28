import { z } from "zod";
import { NonEmpty, type PublishReceipt, type PublishRequest, type PublishTarget } from "@maestro/contracts";
import { buildDocumentModel } from "../doc-model.js";
import type { DocTemplateFile, DocumentSink, GeneratedDocument, TemplateWarning } from "../doc-template.js";
import { renderDocx } from "../docx-render.js";
import { PublishConfigError, PublishRenderError } from "../errors.js";
import { DOC_TITLE_KEY } from "../keys.js";
import { contentHash, label } from "../md.js";
import { renderPdf } from "../pdf-render.js";
import type { PublishStateStore, RunContextResolver, TargetPublisher, Translate } from "../types.js";

/**
 * The `docx` and `pdf` targets (M103r).
 *
 * Both produce a FILE, which is what makes them different from the other three
 * targets: Jira and Confluence own the artefact they create, whereas a binary
 * document has to be parked somewhere durable before a receipt can name it.
 * The sink is injected (`StoragePort.put` in production) so this package keeps
 * no storage dependency.
 *
 * Generation happens on the PLATFORM, never inside the sandbox: the sandbox
 * reaches only the egress proxy (M26), the corporate template is platform data,
 * and a file produced inside the sandbox would bypass the PII boundary that the
 * port applies to `markdownSource` before any driver sees it.
 */

export const BinaryDocPublishConfig = z
  .object({
    /** Key prefix inside the object store; `evidence/...` inherits retention. */
    keyPrefix: NonEmpty.default("evidence"),
    /** Documents are records; WORM by default (M56). */
    objectLock: z.boolean().default(true),
  })
  .strict();
export type BinaryDocPublishConfig = z.infer<typeof BinaryDocPublishConfig>;

/**
 * Supplies the institution's corporate `.docx` (M103r/M108). Returns null when
 * none is uploaded — a documented fallback, not an error.
 */
export interface DocTemplateSource {
  current(): Promise<{ template: DocTemplateFile; bytes: Uint8Array } | null>;
}

export interface BinaryDocPublisherDeps {
  sink: DocumentSink;
  state: PublishStateStore;
  runContext: RunContextResolver;
  translate: Translate;
  /** Absent = the institution has no template designer wired yet. */
  templates?: DocTemplateSource;
  /** Injected so the künye date is deterministic in tests. */
  now?: () => Date;
  /** Reported to the caller/Studio; the file itself also travels with them. */
  onWarnings?: (warnings: readonly TemplateWarning[], req: PublishRequest) => void;
}

const StoredDoc = z.object({ key: z.string().min(1), hash: z.string().min(1) });

export class BinaryDocPublisher implements TargetPublisher {
  constructor(
    readonly target: PublishTarget,
    private readonly config: BinaryDocPublishConfig,
    private readonly deps: BinaryDocPublisherDeps,
  ) {
    if (typeof deps.sink?.put !== "function") {
      throw new PublishConfigError(`the ${target} target needs deps.sink (StoragePort-shaped)`);
    }
    if (target !== "docx" && target !== "pdf") {
      throw new PublishConfigError(`BinaryDocPublisher does not serve the "${target}" target`);
    }
  }

  async publish(req: PublishRequest, markdownSource: string): Promise<PublishReceipt> {
    const { ticketKey } = await this.deps.runContext(req.runId);
    const hash = contentHash(markdownSource);
    const stateKey = `publish:${this.target}:${req.runId}:${req.doc}`;

    // Same bytes already stored: re-rendering would write an identical object
    // and, with object lock on, burn a new version of an immutable record.
    const previous = await this.readState(stateKey);
    if (previous && previous.hash === hash) return { target: this.target, ref: previous.key };

    const generated = await this.generate(req, markdownSource, ticketKey);
    // A zero-byte "successful" document is the failure this whole package is
    // built to prevent: it passes every downstream check and is discovered by
    // whoever opens the file at a gate.
    if (generated.bytes.byteLength === 0) {
      throw new PublishRenderError(`the ${this.target} renderer produced an empty file for ${req.doc}`);
    }

    const key = `${this.config.keyPrefix}/${ticketKey}/${req.runId}/${generated.fileName}`;
    await this.deps.sink.put(key, generated.bytes, {
      contentType: generated.contentType,
      objectLock: this.config.objectLock,
    });
    await this.deps.state.set(stateKey, JSON.stringify({ key, hash }));
    if (generated.warnings.length > 0) this.deps.onWarnings?.(generated.warnings, req);
    return { target: this.target, ref: key };
  }

  /** Build the model once, then hand it to the renderer this target owns. */
  private async generate(req: PublishRequest, markdownSource: string, ticketKey: string): Promise<GeneratedDocument> {
    const now = this.deps.now?.() ?? new Date();
    const model = buildDocumentModel({
      markdownSource,
      translate: this.deps.translate,
      locale: req.locale,
      ticketKey,
      runId: req.runId,
      templateVersion: templateVersionOf(markdownSource),
      date: now.toISOString().slice(0, 10),
    });
    if (model.sections.length === 0 && model.preamble.length === 0) {
      throw new PublishRenderError(`document ${req.doc} has no content to render as ${this.target}`);
    }

    const title = label(this.deps.translate, req.locale, DOC_TITLE_KEY[req.doc], { ticket: ticketKey });
    const base = `${ticketKey}-${req.doc}`;
    if (this.target === "pdf") {
      return {
        bytes: await renderPdf({ ...model, title: model.title === "" ? title : model.title }),
        contentType: "application/pdf",
        fileName: `${base}.pdf`,
        warnings: [],
        sectionMapping: model.sections.map((s, i) => ({ index: i + 1, title: s.title, token: "", mapped: true })),
      };
    }

    const loaded = (await this.deps.templates?.current()) ?? null;
    const rendered = await renderDocx({
      model: { ...model, title: model.title === "" ? title : model.title },
      template: loaded?.template ?? null,
      templateBytes: loaded?.bytes ?? null,
    });
    return {
      bytes: rendered.bytes,
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileName: `${base}.docx`,
      warnings: rendered.warnings,
      sectionMapping: rendered.sectionMapping,
    };
  }

  private async readState(key: string): Promise<{ key: string; hash: string } | null> {
    const raw = await this.deps.state.get(key);
    if (raw === null) return null;
    try {
      const parsed = StoredDoc.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

const TEMPLATE_PIN = /<!--\s*maestro:doc[^>]*\btemplate=(\S+?)\s/;

/**
 * The M83 pin the markdown writer stamped into the document. Read back out
 * rather than passed separately so the künye cannot disagree with the marker an
 * auditor reads off the Confluence page.
 */
function templateVersionOf(markdownSource: string): string {
  return TEMPLATE_PIN.exec(markdownSource)?.[1] ?? "unpinned";
}

import { type AnalysisDoc, PublishTarget, type TicketKey } from "@maestro/contracts";
import { renderAnalysisMarkdown } from "@maestro/publish";
import type { ActivityDeps, RunContext } from "./deps.js";
import { record } from "./record.js";

/**
 * The analysis as a real `.docx` and `.pdf` on the ticket (M103r).
 *
 * The pilot proved this on live tickets (`apps/pilot/src/docs.ts`), but it
 * proved it with its OWN render chain: it called `renderDocx`/`renderPdf`
 * directly, which means the bytes it attached never passed the publish port's
 * PII gate. That was tolerable for a single-operator pilot and is not
 * tolerable for the platform, so the logic is not copied here — it is routed
 * through the seam the platform already owns:
 *
 *   deps.publish.publish({ doc: "analysis", targets: ["docx","pdf"] })
 *     → MaestroPublishPort (masks ONCE, M20/M82)
 *       → BinaryDocPublisher (renders, refuses empty bytes, stores via sink)
 *
 * `BinaryDocPublisher` already owns everything the pilot's helper hand-rolled:
 * the corporate Word template, the M83 pin read back out of the markdown, the
 * zero-byte refusal, and content-hash idempotency. Re-implementing any of it
 * here would be the second copy the platform is trying not to grow.
 *
 * M44: no driver is imported. Generation is a PORT call, and the attachment
 * goes through the `DocAttacher` seam (`deps.ts`) that the composition root
 * satisfies with the concrete Jira driver.
 */

/** The two binary targets, in the order the ticket should show them. */
export const DOC_TARGETS = ["docx", "pdf"] as const;
export type DocTarget = (typeof DOC_TARGETS)[number];

const CONTENT_TYPE: Record<DocTarget, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

/**
 * Minimum plausible size for a rendered office document, in bytes.
 *
 * A `.docx` is a zip with a dozen XML parts and a `.pdf` carries an embedded
 * Unicode font, so both are comfortably past this in every real render — while
 * a truncated write or a renderer that produced only a header lands under it.
 * `BinaryDocPublisher` already refuses exactly zero bytes; this catches the
 * nearly-empty file, which is the one that survives a size check nobody wrote
 * and is discovered by whoever opens it at a gate.
 */
export const MIN_DOC_BYTES = 1000;

/** A document that was generated, fetched back, and is ready for the ticket. */
export interface AnalysisDocFile {
  readonly target: DocTarget;
  /** Object-store key the publish receipt named — the durable copy. */
  readonly storageKey: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
}

/** What `deliverAnalysisDocs` did, for the journal and for tests. */
export interface AnalysisDocsResult {
  readonly files: readonly AnalysisDocFile[];
  /** True only when EVERY generated file reached the ticket as an attachment. */
  readonly attached: boolean;
  /** Human-readable reason the run degraded, or null when all went well. */
  readonly problem: string | null;
}

/** `PAY-101` + `pdf` → `PAY-101-analiz.pdf`. */
export function docFileName(ticket: TicketKey, target: DocTarget): string {
  return `${ticket}-analiz.${target}`;
}

/**
 * Generate both documents, then attach them to the ticket.
 *
 * FAIL-SOFT BUT NEVER SILENT. By the time this runs the analysis comment is
 * already on the ticket and the requester already has it, so a renderer or a
 * Jira hiccup must not fail the activity — three Temporal retries would end in
 * a FAILED run whose actual deliverable was complete. It therefore never
 * throws. What it does instead is say so, in both places a human looks: the
 * journal (`record`) and the ticket itself (a Jira comment).
 */
export async function deliverAnalysisDocs(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  analysis: AnalysisDoc | null,
): Promise<AnalysisDocsResult> {
  if (analysis === null) {
    // Not a failure: the engineering flow calls the same delivery step without
    // a document. Nothing to render, nothing to say.
    return { files: [], attached: false, problem: null };
  }

  let files: readonly AnalysisDocFile[];
  try {
    files = await generateDocs(deps, run, ticket, analysis);
  } catch (error) {
    await reportProblem(deps, run, ticket, `belge üretilemedi: ${String(error)}`, "docs:generate-failed");
    return { files: [], attached: false, problem: String(error) };
  }

  await record(deps, run, {
    kind: "analysis",
    title: "analiz belgesi üretildi",
    detail: describeFiles(files, run.templateVersion),
    key: "docs:generated",
  });

  return attachDocs(deps, run, ticket, files);
}

/**
 * `OPS-9-analiz.docx (48231 B) · OPS-9-analiz.pdf (9214 B) · şablon analysis sürüm 1.0.0`
 *
 * M83: the pin travels with the journal line, not only inside the file, so the
 * standard a document was written against is readable without opening it.
 *
 * Spelled out rather than written `analysis@1.0.0`, because the journal masker
 * is right about what that looks like: `name@dotted.version` is an email
 * address to every detector, and the raw form came back from the journal as
 * `şablon: [EMAIL_1.e2c05cc8]` — the pin destroyed by the gate that protects
 * it. The publish path solves the same problem with an explicit exemption
 * (`assertTemplatePinSurvived` in `packages/publish/src/pii.ts`); the journal
 * has no exemption list, so the fix here is to not write an email in the first
 * place. The version is still exact, which is all M83 asks.
 */
function describeFiles(files: readonly AnalysisDocFile[], templateVersion: string): string {
  const listed = files.map((f) => `${f.fileName} (${String(f.bytes.byteLength)} B)`).join(" · ");
  return `${listed} · şablon ${readablePin(templateVersion)}`;
}

/** `analysis@1.0.0` → `analysis sürüm 1.0.0`; anything else is passed through. */
export function readablePin(templateVersion: string): string {
  const at = templateVersion.lastIndexOf("@");
  if (at <= 0 || at === templateVersion.length - 1) return templateVersion;
  return `${templateVersion.slice(0, at)} sürüm ${templateVersion.slice(at + 1)}`;
}

/**
 * Render through the publish port, then read the bytes back from storage.
 *
 * The port hands back a RECEIPT (`{ target, ref }`), not bytes — deliberately,
 * because the durable copy is the object in the store and the attachment is a
 * convenience copy of it. Fetching it back means the file on the ticket is
 * byte-identical to the retained record, rather than a second render that
 * could differ from it.
 */
async function generateDocs(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  analysis: AnalysisDoc,
): Promise<readonly AnalysisDocFile[]> {
  const markdown = renderAnalysisMarkdown(analysis, {
    translate: deps.translate,
    locale: run.locale,
    runId: run.runId,
    ticketKey: ticket,
  });

  // Idempotent: a retried activity replays the first run's receipts instead of
  // rendering and storing the documents a second time.
  const receipts = await deps.idempotency.once(`${run.runId}:publish:analysis-docs`, () =>
    deps.publish.publish(
      {
        runId: run.runId,
        doc: "analysis",
        targets: [...DOC_TARGETS].map((t) => PublishTarget.parse(t)),
        locale: run.locale,
      },
      markdown,
    ),
  );

  const files: AnalysisDocFile[] = [];
  for (const target of DOC_TARGETS) {
    const receipt = receipts.find((r) => r.target === target);
    if (receipt === undefined) throw new Error(`publish returned no ${target} receipt`);
    const bytes = await deps.storage.get(receipt.ref);
    assertRealDocument(target, receipt.ref, bytes);
    files.push({
      target,
      storageKey: receipt.ref,
      fileName: docFileName(ticket, target),
      contentType: CONTENT_TYPE[target],
      bytes,
    });
  }
  return files;
}

/**
 * An empty or stub file is worse than no file: it passes every downstream
 * check and is found by a reviewer at a gate. Both the size floor and the
 * format's magic bytes are checked, because a renderer that writes a header
 * and then fails produces something that is neither empty nor a document.
 */
export function assertRealDocument(target: DocTarget, key: string, bytes: Uint8Array): void {
  if (bytes.byteLength < MIN_DOC_BYTES) {
    throw new Error(`${target} at ${key} is ${String(bytes.byteLength)} B — too small to be a real document`);
  }
  const magic = target === "pdf" ? "%PDF-" : "PK";
  const head = new TextDecoder("latin1").decode(bytes.slice(0, magic.length));
  if (head !== magic) {
    throw new Error(`${target} at ${key} does not start with ${magic} — not a ${target} file`);
  }
}

/**
 * Put the generated files on the ticket, if this deployment can.
 *
 * `WorkPort` is FROZEN and has no `addAttachment`, so the capability arrives
 * through the optional `DocAttacher` seam. A deployment without one is a
 * DEGRADED but honest outcome, not an error: the documents exist and are
 * durable, so the journal points at the object-store keys instead.
 */
async function attachDocs(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  files: readonly AnalysisDocFile[],
): Promise<AnalysisDocsResult> {
  const attacher = deps.docAttacher;
  if (attacher === undefined) {
    await record(deps, run, {
      kind: "analysis",
      title: "analiz belgesi saklandı",
      detail: `ticket'a eklenemedi (bu kurulumda ek yükleme yok) — ${files.map((f) => f.storageKey).join(", ")}`,
      key: "docs:no-attacher",
    });
    return { files, attached: false, problem: "no attacher" };
  }

  try {
    for (const file of files) {
      // Per FILE, not per activity: a retry that already uploaded the docx must
      // not upload it again while retrying the pdf.
      await deps.idempotency.once(`${run.runId}:attach:${file.target}`, () =>
        attacher.addAttachment(ticket, file.fileName, file.bytes, file.contentType),
      );
    }
    await record(deps, run, {
      kind: "analysis",
      title: "analiz belgesi ticket'a eklendi",
      detail: `${String(files.length)} dosya: ${files.map((f) => f.fileName).join(", ")}`,
      key: "docs:attached",
    });
    return { files, attached: true, problem: null };
  } catch (error) {
    await reportProblem(deps, run, ticket, `belge ticket'a eklenemedi: ${String(error)}`, "docs:attach-failed");
    return { files, attached: false, problem: String(error) };
  }
}

/**
 * Say what went wrong in BOTH places a human looks — the journal and the
 * ticket. Fail-soft is only defensible if the failure is visible; a swallowed
 * error here would leave a reviewer waiting for an attachment that is never
 * coming, with nothing on the ticket to say so.
 *
 * The Jira comment is itself best-effort: if the ticket cannot be commented on
 * either, the journal line still stands, and this must not throw.
 */
async function reportProblem(
  deps: ActivityDeps,
  run: RunContext,
  ticket: TicketKey,
  detail: string,
  key: string,
): Promise<void> {
  await record(deps, run, {
    kind: "analysis",
    title: "analiz belgesi eksik",
    detail: `${detail} (analiz teslimi etkilenmedi)`,
    key,
  });
  try {
    await deps.idempotency.once(`${run.runId}:${key}:comment`, () =>
      deps.work.addComment(ticket, deps.translate(run.locale, "jira.analysis_docs_failed", { ticket })),
    );
  } catch {
    // The journal already carries it; a ticket that refuses comments must not
    // turn a degraded delivery into a failed activity.
  }
}

import { z } from "zod";
import { Locale, NonEmpty, RunId } from "./common.js";

/** Publish targets (M47) + file renderers docx/pdf (M103, Aşama 2). */
export const PublishTarget = z.enum(["jira", "confluence", "repo-docs", "docx", "pdf"]);
export type PublishTarget = z.infer<typeof PublishTarget>;

export const PublishDocKind = z.enum(["analysis", "evidence_summary", "release_note"]);
export type PublishDocKind = z.infer<typeof PublishDocKind>;

export const PublishRequest = z.object({
  runId: RunId,
  doc: PublishDocKind,
  targets: z.array(PublishTarget).min(1),
  locale: Locale,
});
export type PublishRequest = z.infer<typeof PublishRequest>;

export const PublishReceipt = z.object({
  target: PublishTarget,
  ref: NonEmpty, // comment id / page id / commit sha / file path
});
export type PublishReceipt = z.infer<typeof PublishReceipt>;

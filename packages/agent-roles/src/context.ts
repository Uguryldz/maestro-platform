import type { RepoCard, TicketSnapshot } from "@maestro/contracts";
import type { SourceKind } from "./schema-builder.js";

/**
 * Everything a thinking role is allowed to know. Nothing outside this object
 * may appear in its output — that is what makes M98 ("no fabrication")
 * checkable instead of merely instructed: every source reference is looked up
 * here, and a reference that is not in this object is a fabrication.
 */

export interface NamedDoc {
  name: string;
  text: string;
}

/** Read-only repo discovery result of step 3o. */
export interface RepoDiscovery {
  appId: string;
  files: string[];
  modules: string[];
}

/** Knowledge pack (M38): one store, per-variant content. */
export interface KnowledgePack {
  repoCards: RepoCard[];
  knowledgeDocs: NamedDoc[];
  codingStandards: NamedDoc[];
  exampleAnalyses: NamedDoc[];
}

export interface ClarificationRound {
  id: string;
  question: string;
  answer: string | null;
}

export interface AnalysisContext {
  ticket: TicketSnapshot;
  discovery: RepoDiscovery;
  knowledge: KnowledgePack;
  clarifications: ClarificationRound[];
}

export type ReferenceIndex = Record<SourceKind, Set<string>>;

/**
 * Every reference value the analyst is permitted to cite. Matching is exact
 * (after trimming): a "nearly right" path is still a path nobody can open, and
 * an auditor following the source must land on something real.
 */
export function buildReferenceIndex(context: AnalysisContext): ReferenceIndex {
  const repoCard = new Set<string>();
  for (const card of context.knowledge.repoCards) {
    repoCard.add(card.appId);
    for (const module of card.modules) {
      repoCard.add(`${card.appId}/${module.name}`);
      repoCard.add(module.path);
    }
  }

  // Example analyses belong here because the prompt SHOWS them. Indexing only
  // what the model may cite while showing it more is a false-positive machine:
  // a citation of the example document in front of the analyst would be refused
  // as a fabrication, and the repair round could not explain why.
  const knowledgeDoc = new Set<string>();
  for (const doc of [
    ...context.knowledge.knowledgeDocs,
    ...context.knowledge.codingStandards,
    ...context.knowledge.exampleAnalyses,
  ]) {
    knowledgeDoc.add(doc.name);
  }

  const ticket = new Set<string>([context.ticket.key]);
  if (context.ticket.parentKey) ticket.add(context.ticket.parentKey);

  return {
    repo_file: new Set(context.discovery.files),
    repo_card: repoCard,
    knowledge_doc: knowledgeDoc,
    ticket,
    clarification: new Set(context.clarifications.map((c) => c.id)),
  };
}

export function isKnownReference(index: ReferenceIndex, kind: SourceKind, ref: string): boolean {
  return index[kind].has(ref.trim());
}

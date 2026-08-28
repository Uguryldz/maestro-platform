import type { DocTemplateOutput, DocTemplateRecord, DocTemplateStore } from "../deps.js";

/**
 * The corporate template store's reference implementation (M103r/M83).
 *
 * It enforces the same two rules the Postgres-backed one must, so a bug in
 * either shows up in a unit test rather than in a bank's document: an uploaded
 * version is never mutated, and a new upload must be exactly `latest + 1` — two
 * document owners uploading at the same moment cannot both become version 3
 * with one of the files silently lost.
 *
 * Process-local, so every uploaded template dies with the process. That is a
 * real cost and it is declared in the composition root's `VOLATILE_STORES`
 * rather than hidden here: a run pinned to version 2 (M83) cannot render after
 * a restart that lost version 2.
 */
export class InMemoryDocTemplateStore implements DocTemplateStore {
  private readonly versions: DocTemplateRecord[] = [];
  private readonly produced: DocTemplateOutput[] = [];

  constructor(seed: readonly DocTemplateRecord[] = [], outputs: readonly DocTemplateOutput[] = []) {
    for (const record of seed) this.versions.push(clone(record));
    this.produced.push(...outputs.map((output) => ({ ...output })));
  }

  latest(): Promise<DocTemplateRecord | null> {
    const newest = this.versions[this.versions.length - 1];
    return Promise.resolve(newest === undefined ? null : clone(newest));
  }

  get(version: number): Promise<DocTemplateRecord | null> {
    const found = this.versions.find((record) => record.version === version);
    return Promise.resolve(found === undefined ? null : clone(found));
  }

  /** Newest first, bounded — the screen lists the last few, not the archive. */
  outputs(limit: number): Promise<readonly DocTemplateOutput[]> {
    return Promise.resolve(
      [...this.produced]
        .sort((left, right) => right.at.localeCompare(left.at))
        .slice(0, Math.max(0, limit))
        .map((output) => ({ ...output })),
    );
  }

  /** Test/seed hook: record a document as having been produced. */
  recordOutput(output: DocTemplateOutput): void {
    this.produced.push({ ...output });
  }

  // Async so a refused write is a rejected promise rather than a synchronous
  // throw out of a Promise-returning method.
  async publish(record: DocTemplateRecord): Promise<void> {
    const latest = this.versions[this.versions.length - 1]?.version ?? 0;
    if (record.version !== latest + 1) {
      throw new Error(
        `doc template version ${String(record.version)} is not ${String(latest + 1)} — ` +
          `an upload publishes a new version and never overwrites one (M83)`,
      );
    }
    this.versions.push(clone(record));
    await Promise.resolve();
  }
}

/**
 * Copy far enough that a caller cannot reach back into a stored version — the
 * bytes included. A shared `Uint8Array` would let whoever uploaded version 2
 * rewrite it in place afterwards, which is exactly what "immutable version"
 * is supposed to prevent.
 */
function clone(record: DocTemplateRecord): DocTemplateRecord {
  return {
    ...record,
    styles: [...record.styles],
    placeholders: record.placeholders.map((placeholder) => ({ ...placeholder })),
    content: Uint8Array.from(record.content),
  };
}

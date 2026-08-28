/**
 * Analysis guidance store — the "öğren" knowledge library. An operator uploads
 * short notes ("dikkat edilecekler"); the enabled ones are injected into the
 * analyst's context when a NEW analysis is prepared. This is the BFF-side port;
 * the Prisma implementation lives in apps/deploy (like every other store), and
 * an in-memory one backs the tests.
 */
export interface GuidanceRecord {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  updatedAt: string;
  /**
   * Which agent variant this note targets. `null` (or absent) = global, every
   * agent learns from it — today's behaviour; a variant id = only that agent.
   * Optional (not `| null` required) so the Prisma store in apps/deploy keeps
   * compiling until it maps the new `AnalysisGuidance.variantId` column.
   */
  variantId?: string | null;
}

/** What a create/update carries — the store stamps id/updatedAt. */
export interface GuidanceWrite {
  title: string;
  content: string;
  enabled: boolean;
  /** Target agent variant; omitted/null = global (all agents). */
  variantId?: string | null;
}

export interface GuidanceStore {
  /** Every note, newest first, for the library screen. */
  list(): Promise<readonly GuidanceRecord[]>;
  /** The enabled notes only — what the analyst actually learns from. */
  listEnabled(): Promise<readonly GuidanceRecord[]>;
  /** Create a note; returns the stored row. */
  create(write: GuidanceWrite): Promise<GuidanceRecord>;
  /** Update title/content/enabled of an existing note; null if it does not exist. */
  update(id: string, patch: Partial<GuidanceWrite>): Promise<GuidanceRecord | null>;
  /** Remove a note; true when a row was deleted. */
  remove(id: string): Promise<boolean>;
}

/** Reference in-memory store — the tests' backing, and the fallback. */
export class InMemoryGuidanceStore implements GuidanceStore {
  private readonly rows = new Map<string, GuidanceRecord>();
  private counter = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  list(): Promise<readonly GuidanceRecord[]> {
    return Promise.resolve(
      [...this.rows.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    );
  }

  listEnabled(): Promise<readonly GuidanceRecord[]> {
    return this.list().then((all) => all.filter((r) => r.enabled));
  }

  create(write: GuidanceWrite): Promise<GuidanceRecord> {
    const id = `ag_${++this.counter}`;
    const row: GuidanceRecord = {
      id,
      ...write,
      variantId: write.variantId ?? null,
      updatedAt: this.now().toISOString(),
    };
    this.rows.set(id, row);
    return Promise.resolve(row);
  }

  update(id: string, patch: Partial<GuidanceWrite>): Promise<GuidanceRecord | null> {
    const existing = this.rows.get(id);
    if (existing === undefined) return Promise.resolve(null);
    const row: GuidanceRecord = { ...existing, ...patch, updatedAt: this.now().toISOString() };
    this.rows.set(id, row);
    return Promise.resolve(row);
  }

  remove(id: string): Promise<boolean> {
    return Promise.resolve(this.rows.delete(id));
  }
}
